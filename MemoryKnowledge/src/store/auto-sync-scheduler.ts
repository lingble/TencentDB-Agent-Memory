/**
 * AutoSyncScheduler — periodically pulls git repos and updates the codegraph index.
 *
 * Model: FIFO queue + fixed-size worker pool.
 *   - Scanner: every scanIntervalMs, scans all repos in ready status;
 *     dedupes with a Set (skipping those already queued or being processed by a worker), then pushes to the in-memory queue.
 *   - Workers: maxConcurrentSyncs long-lived coroutines take tasks from the queue in FIFO order and call
 *     CodeGraphService.sync(); they poll while the queue is empty and exit naturally after stop.
 *
 * Per-repo sync frequency = max(single sync duration, scanIntervalMs). No extra cooldown field —
 * to control frequency, adjust SCAN_INTERVAL_MIN directly.
 *
 * Design goals (from requirements):
 *   1. Periodically detect git repo updates, automatically pull the latest code and rebuild the codegraph index
 *   2. Use a task queue to avoid bursts of pulls overwhelming the service (concurrency hard-capped by worker count)
 *   3. Repos already queued or in progress are not re-enqueued (Set dedupe; queue size upper bound = number of repos)
 *   4. A single repo's sync failure doesn't affect other repos (workers swallow exceptions and keep consuming)
 *   5. Reuse the existing busy/not_found rejection semantics of CodeGraphService.sync()
 *
 * Environment variables:
 *   - KNOWLEDGE_AUTO_SYNC_ENABLED: enable switch (default: false)
 *   - KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN: scan interval (minutes) (default: 10)
 *   - KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT: global max concurrent syncs (default: 3)
 */

import { createLogger } from "../logger.js";
import type { CodeGraphService, SyncResult } from "./code-graph-service.js";
import type { IKnowledgeStore } from "./types.js";
import { toCodeGraphTarget, toWikiTarget, type SyncTarget } from "./auto-sync-target.js";
import type { ICredentialStore, SourceCredential } from "../source-auth/types.js";

const log = createLogger("auto-sync-scheduler");

// ───────────────────────── Configuration ─────────────────────────

export interface AutoSyncConfig {
  /** Whether auto sync is enabled. Default false (must be explicitly enabled). */
  enabled: boolean;
  /** Main loop scan interval (ms). Default 10 minutes. */
  scanIntervalMs: number;
  /** Global max concurrent syncs (= number of workers). Default 3. */
  maxConcurrentSyncs: number;
}

const MIN_MS = 60 * 1000;
/** Poll interval (ms) while a worker is idle. Can also be advanced under fake timers in tests. */
const WORKER_IDLE_POLL_MS = 100;

/**
 * Resolve config from environment variables, with fallback defaults.
 * All numeric fields are clamped to prevent unreasonable config.
 */
export function resolveAutoSyncConfig(env: Record<string, string | undefined> = process.env): AutoSyncConfig {
  const enabled = parseBoolean(env.KNOWLEDGE_AUTO_SYNC_ENABLED, false);
  const scanIntervalMin = clamp(parseFloat(env.KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN ?? "") || 10, 1, 60);
  const maxConcurrent = clamp(parseInt(env.KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT ?? "") || 3, 1, 20);

  return {
    enabled,
    scanIntervalMs: scanIntervalMin * MIN_MS,
    maxConcurrentSyncs: maxConcurrent,
  };
}

// ───────────────────────── Scheduler ─────────────────────────

/**
 * Wiki pull service (for scheduled sync of external wikis).
 * Returns the number of pages written in this run. Implemented in wiki-source/ and injected by module.ts once wired.
 */
export interface WikiImporter {
  run(
    serviceId: string,
    teamId: string,
    wikiId: string,
    cred: SourceCredential,
  ): Promise<number>;
}

export interface AutoSyncSchedulerDeps {
  store: IKnowledgeStore;
  cgService: CodeGraphService;
  config: AutoSyncConfig;
  /** External wiki pull service; when not injected, all wiki sync targets are skipped (code-graph unaffected). */
  wikiImporter?: WikiImporter;
  /** External source credential store; when not injected, all wiki sync targets are skipped. */
  credentialStore?: ICredentialStore;
}

export interface AutoSyncStatus {
  /** Whether the scheduler has been started (and not stopped). */
  running: boolean;
  /** Number of sync tasks currently being executed by workers. */
  activeSyncs: number;
  /** Number of repos waiting in the queue. */
  queueLength: number;
  /** Whether the previous scan is still in progress (prevents re-entry). */
  scanning: boolean;
}

export class AutoSyncScheduler {
  private readonly store: IKnowledgeStore;
  private readonly cgService: CodeGraphService;
  private readonly config: AutoSyncConfig;
  private readonly wikiImporter?: WikiImporter;
  private readonly credentialStore?: ICredentialStore;

  /** Timers for the startup delay + periodic scan. */
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  /** Set of idle-worker sleep timers (all cleared on stop). */
  private readonly workerSleepTimers = new Set<ReturnType<typeof setTimeout>>();

  /** FIFO pending queue + dedupe Set (stores target.key, no collisions across types). */
  private readonly queue: SyncTarget[] = [];
  private readonly inFlight = new Set<string>();

  /** Number of workers currently executing a sync. */
  private activeSyncs = 0;
  /** Number of (long-lived) workers. */
  private workerCount = 0;
  /** Stop flag. After stop, worker loops exit. */
  private stopped = true;
  /** Whether the previous scan is still in progress. */
  private scanning = false;

  constructor(deps: AutoSyncSchedulerDeps) {
    this.store = deps.store;
    this.cgService = deps.cgService;
    this.config = deps.config;
    this.wikiImporter = deps.wikiImporter;
    this.credentialStore = deps.credentialStore;
  }

  /**
   * Start scheduling:
   *   - First scan delayed by 30s (let restore finish first, avoiding disk contention)
   *   - Scan every scanIntervalMs
   *   - Start maxConcurrentSyncs long-lived workers
   */
  start(): void {
    if (!this.config.enabled) {
      log.info("[auto-sync] disabled by config, skipping start");
      return;
    }
    if (!this.stopped) {
      log.warn("[auto-sync] already started");
      return;
    }
    this.stopped = false;
    log.info("[auto-sync] starting scheduler", {
      scanIntervalMs: this.config.scanIntervalMs,
      maxConcurrentSyncs: this.config.maxConcurrentSyncs,
    });

    // Start the long-lived worker pool
    for (let i = 0; i < this.config.maxConcurrentSyncs; i++) {
      this.workerCount++;
      void this.runWorker(i).finally(() => { this.workerCount--; });
    }

    // Delay the first scan by 30s
    const startupDelay = 30_000;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.stopped) return;
      void this.scan();
      this.scanTimer = setInterval(() => {
        if (this.stopped) return;
        void this.scan();
      }, this.config.scanIntervalMs);
    }, startupDelay);
    log.info(`[auto-sync] first scan in ${startupDelay / 1000}s`);
  }

  /** Stop the scheduler: cancel timers and signal workers to exit (in-flight syncs complete naturally). */
  stop(): void {
    this.stopped = true;
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    for (const t of this.workerSleepTimers) clearTimeout(t);
    this.workerSleepTimers.clear();
    log.info("[auto-sync] stopped");
  }

  /** Status snapshot (used by the admin API). */
  getStatus(): AutoSyncStatus {
    return {
      running: !this.stopped,
      activeSyncs: this.activeSyncs,
      queueLength: this.queue.length,
      scanning: this.scanning,
    };
  }

  /** Manually trigger a scan round (used by the admin API). Doesn't affect the periodic schedule. No-op when disabled. */
  triggerScan(): void {
    if (!this.config.enabled) {
      log.warn("[auto-sync] cannot trigger: scheduler is disabled");
      return;
    }
    log.info("[auto-sync] manual scan triggered");
    void this.scan();
  }

  // ───────────────────────── Core scan loop ─────────────────────────

  /**
   * One scan round:
   *   1. List all code-graphs in ready status
   *   2. Dedupe with the inFlight Set (queued / in-progress ones are not re-enqueued)
   *   3. FIFO push to the queue; workers consume automatically
   */
  private async scan(): Promise<void> {
    if (this.scanning) {
      log.debug("[auto-sync] previous scan still running, skip this round");
      return;
    }
    this.scanning = true;
    try {
      log.info("[auto-sync] scan started");

      const candidates = this.listSyncCandidates();
      if (candidates.length === 0) {
        log.info("[auto-sync] no ready repos");
        return;
      }

      let enqueued = 0;
      for (const target of candidates) {
        if (this.stopped) break;
        if (this.inFlight.has(target.key)) continue; // already queued or in progress
        this.inFlight.add(target.key);
        this.queue.push(target);
        enqueued++;
      }
      log.info(`[auto-sync] enqueued ${enqueued} repo(s) (queue=${this.queue.length}, active=${this.activeSyncs})`);
    } catch (err) {
      log.error(`[auto-sync] scan error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * List code-graphs that need syncing: only those with status = ready.
   * Repos already queued or being processed by a worker are deduped by the inFlight Set in scan() and not re-enqueued;
   * per-repo sync cadence is naturally max(sync duration, scanIntervalMs), so no extra cooldown is needed.
   */
  private listSyncCandidates(): SyncTarget[] {
    const candidates: SyncTarget[] = [];

    // ① code-graph: status = ready (original logic, just wrapped in a target)
    for (const ref of this.store.listSyncedCodeGraphs()) {
      try {
        const row = this.store.getCodeGraph(ref.service_id, ref.team_id, ref.code_graph_id);
        if (!row) continue;
        if (row.status !== "ready") continue;
        candidates.push(toCodeGraphTarget(row));
      } catch (err) {
        log.warn(`[auto-sync] failed to check ${ref.code_graph_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ② wiki: **wikis with a credential row** (equivalent to "external import", §4.2)
    if (this.credentialStore) {
      for (const ref of this.credentialStore.listAllByType("wiki")) {
        try {
          const row = this.store.getWikiById(ref.serviceId, ref.resourceId);
          if (!row) continue;                              // resource deleted
          candidates.push(toWikiTarget(row));
        } catch (err) {
          log.warn(`[auto-sync] failed to check wiki ${ref.resourceId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return candidates;
  }

  // ───────────────────────── Worker pool ─────────────────────────

  /**
   * A long-lived worker: loops shifting the queue to run syncs; when empty, sleeps briefly and retries.
   * The loop exits naturally after stop(). All exceptions are swallowed (and logged) so the worker never dies.
   */
  private async runWorker(workerIdx: number): Promise<void> {
    log.debug(`[auto-sync] worker#${workerIdx} started`);
    while (!this.stopped) {
      const target = this.queue.shift();
      if (!target) {
        await this.sleep(WORKER_IDLE_POLL_MS);
        continue;
      }

      this.activeSyncs++;
      try {
        await this.syncOne(target);
      } catch (err) {
        // syncOne already catches internally; this is a fallback
        log.error(`[auto-sync] worker#${workerIdx} unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.activeSyncs--;
        this.inFlight.delete(target.key);
      }
    }
    log.debug(`[auto-sync] worker#${workerIdx} exiting`);
  }

  /** Dispatch by target type. */
  private async syncOne(target: SyncTarget): Promise<void> {
    return target.kind === "code-graph" ? this.syncCodeGraph(target) : this.syncWiki(target);
  }

  /** Run sync for a single code-graph (reuses CodeGraphService.sync's discriminated union). */
  private async syncCodeGraph(t: Extract<SyncTarget, { kind: "code-graph" }>): Promise<void> {
    const row = t.row;
    const startMs = Date.now();
    log.info(`[auto-sync] sync ${row.code_graph_id} (${row.repo_url}@${row.branch})`);
    try {
      // CodeGraphService.sync currently returns SyncResult synchronously; await keeps compatibility with a future async version or test mocks.
      const result: SyncResult = await Promise.resolve(
        this.cgService.sync(row.service_id, row.team_id, row.code_graph_id, undefined),
      );
      const durationMs = Date.now() - startMs;
      switch (result.kind) {
        case "ok":
          log.info(`[auto-sync] sync enqueued for ${row.code_graph_id} (took ${durationMs}ms)`);
          break;
        case "busy":
          log.debug(`[auto-sync] skip ${row.code_graph_id}: already ${result.status} (step: ${result.step})`);
          break;
        case "not_found":
          log.warn(`[auto-sync] skip ${row.code_graph_id}: not found (may have been deleted)`);
          break;
      }
    } catch (err) {
      log.error(`[auto-sync] sync failed for ${row.code_graph_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Sync one external wiki: fetch the owner token → call WikiImportService to pull + ingest.
   *
   * Key constraint (design §5.4): **failures do not write knowledge_wiki.sync_error** — that field is for
   * ingest extraction errors; mixing them would make it impossible to tell "is this wiki healthy or not". Sync failures are only logged.
   *
   * The current wiki provider (iWiki) is not wired yet: skip directly when there's no pull service,
   * ensuring code-graph auto-sync behaves exactly as before this change.
   */
  private async syncWiki(t: Extract<SyncTarget, { kind: "wiki" }>): Promise<void> {
    const wiki = t.row;
    if (!this.wikiImporter) {
      log.debug(`[auto-sync] wiki sync skipped (no importer wired): ${wiki.wiki_id}`);
      return;
    }
    const cred = this.credentialStore?.get({
      type: "wiki",
      serviceId: t.serviceId,
      resourceId: wiki.wiki_id,
    });
    if (!cred) {
      // No credential row = manually uploaded wiki, which shouldn't be a candidate (defensive check); or the user deleted the credential.
      log.warn(`[auto-sync] wiki ${wiki.wiki_id} credential missing, skip sync`);
      return;
    }
    try {
      const n = await this.wikiImporter.run(t.serviceId, t.teamId, wiki.wiki_id, cred);
      log.info(`[auto-sync] wiki ${wiki.wiki_id} synced (${n} pages)`);
    } catch (err) {
      // Log only; don't write sync_error (see above).
      log.error(
        `[auto-sync] wiki sync failed for ${wiki.wiki_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** setTimeout-based sleep; all cleared on stop to avoid timer leaks in tests. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.workerSleepTimers.delete(t);
        resolve();
      }, ms);
      this.workerSleepTimers.add(t);
    });
  }
}

// ───────────────────────── Helpers ─────────────────────────

function parseBoolean(val: string | undefined, fallback: boolean): boolean {
  if (val == null || val.trim() === "") return fallback;
  const v = val.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
