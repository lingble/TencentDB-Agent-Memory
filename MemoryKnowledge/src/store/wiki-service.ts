/**
 * WikiService — async orchestration of wiki assets (symmetric with CodeGraphService).
 *
 * IKnowledgeStore (metadata/status) + BuildQueue (background serial) + injectable worker
 * (actual ingest / indexing). State machine: pending → processing(scanning/ingesting)
 * → ready / failed(+sync_error). memory + team isolation, idempotency (same memory+team+name returns the existing one),
 * soft delete + directory cleanup. Physical directory {dataRoot}/{service_id}/{team_id}/{wiki_id}/ (001 multi-tenancy).
 *
 * File layer (finalized in doc 11): one set of ls/read/write/rm each for raw / page, aligned with the L2 Scenario.
 * - raw/* only operates on raw/sources/ and does not trigger ingest.
 * - page/* operates on wiki/; writes automatically inject frontmatter `locked: true`, and deletes call
 *   the lib-layer cascadeDeleteWikiPagesWithRefs for reference cascading.
 */

import { join, resolve, normalize, dirname } from "node:path";
import {
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

import type {
  AuditAction,
  IKnowledgeStore,
  WikiRow,
  ListOpts,
  CountOpts,
} from "./types.js";
import { BuildQueue } from "./build-queue.js";
import {
  initIndexDb,
  withWriteDb,
  getReadDb,
  evictWikiDb,
  upsertSource,
  listSources,
  deleteSources,
  sha256,
  type SourceStatus,
} from "../engines/wiki/index-db.js";

export interface WikiBuildContext {
  wikiId: string;
  serviceId: string;
  teamId: string;
  name: string;
  dir: string;
  setInternalStatus: (s: string) => void;
  /** Generation of a single ingest run; shared by progress/terminal callbacks to guard Panel against late packets */
  ingestRunId: string;
}

export interface WikiBuildResult {
  pageCount?: number;
}

export type WikiWorker = (ctx: WikiBuildContext) => Promise<WikiBuildResult | void>;

/**
 * ingest result (discriminated union):
 *   - ok       rebuild enqueued (no in-flight task);
 *   - queued   already in flight; per onBusy:'replace', the old task was cancelled and the new task queued (design 2026-09-21 §3.3);
 *   - not_found memory/team/id mismatch;
 *   - busy     currently pending/processing with onBusy:'reject' (concurrent rejection, maps to HTTP 409),
 *              step is the internal stage (may be null).
 */
export type IngestResult =
  | { kind: "ok"; row: WikiRow }
  | { kind: "queued"; row: WikiRow }
  | { kind: "not_found" }
  | { kind: "busy"; status: "pending" | "processing"; step: string | null };

/**
 * ingest behavior options (design 2026-09-21 §3.3).
 * onBusy only takes effect when the wiki already has an in-flight task (status ∈ {pending, processing}):
 *   - 'reject' (default): reject and return busy (original semantics; auto-sync/CLI/sync alias unchanged);
 *   - 'replace': set the cancelled flag + internal_status='cancelling', and queue the new task
 *     into SerialQueue (FIFO). After the old worker returns, a checkpoint does the preserveRaw wrap-up.
 */
export interface IngestOptions {
  onBusy?: "reject" | "replace";
}

export interface WikiServiceLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface WikiServiceOptions {
  store: IKnowledgeStore;
  dataRoot: string;
  worker: WikiWorker;
  queue?: BuildQueue;
  logger?: WikiServiceLogger;
  /** Callback config for TMC status notifications. Optional. */
  callbackConfig?: {
    tmcCallbackUrl: string;
    /** Per-instance LLM resolver for summary generation (keyed by service_id). */
    resolveLlm: (serviceId: string) => import("../config.js").LlmConfig;
  };
}

export interface CreateWikiParams {
  service_id: string;
  team_id: string;
  name: string;
  source_type?: string;
  source_url?: string;
  owner_user_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  visibility?: string;
  service_url?: string;
}

// ── File-layer result types (aligned with the yaml schema) ──

export interface RawFileEntry {
  filename: string;
  size: number;
  /** Source file lifecycle status (uploaded/ingested/failed, design 003). */
  status: SourceStatus;
  /** First upload time (unchanged afterwards). */
  created_at: string;
  /** Time of the most recent content change. */
  updated_at: string;
  /** user_id of the last modifier (no history log). */
  last_modified_by: string | null;
  /** Time of the most recent successful extraction (null if never extracted). */
  ingested_at: string | null;
  /** @deprecated Legacy-compatible field, equal to created_at. */
  uploaded_at: string;
}

export interface RawWriteResult {
  filename: string;
  size: number;
}

export interface RawReadItem {
  filename: string;
  content?: string;
  not_found?: boolean;
}

export interface RawWriteManyItem {
  filename: string;
  size: number;
}

export interface RawRmResult {
  deleted_files: string[];
  deleted_pages: string[];
  rewritten_pages: number;
}

/**
 * Structure of the import filename mapping file (`<wikiDir>/import-map.json`).
 * providerId → (externalId → on-disk filename).
 * Supports two value shapes: string (current write form) or { filename } (legacy/future extension).
 */
export interface ImportNameMapFile {
  version: 1;
  providers: Record<
    string,
    Record<string, string | { filename: string; title?: string }>
  >;
}

export interface PageWriteResult {
  ref: string;
  locked_injected: boolean;
}

export interface PageReadItem {
  ref: string;
  content?: string;
  not_found?: boolean;
}

export interface PageWriteManyItem {
  ref: string;
  locked_injected: boolean;
}

export interface PageRmResult {
  deleted_pages: string[];
  rewritten_files: number;
}

/**
 * Return wrapper for write operations:
 * - `null`: wiki doesn't exist or doesn't belong to the memory/team
 * - `"processing"`: wiki is currently processing; write rejected
 * - `"invalid_path"`: path traversal check failed
 * - `"forbidden_path"`: wrote to a forbidden path such as a structural file
 * - `"too_large"`: exceeds the size limit
 * - otherwise: the actual result object
 */
export type WriteOutcome<T> =
  | T
  | null
  | "processing"
  | "invalid_path"
  | "forbidden_path"
  | "too_large";

const PAGE_WRITE_MAX_BYTES = 512 * 1024;
const RAW_WRITE_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_RM_MAX = 20;
const RAW_RM_MAX = 50;
const RAW_READ_MAX = 50;
const RAW_WRITE_MAX = 50;
const PAGE_READ_MAX = 20;
const PAGE_WRITE_MAX = 20;

/** Structural files under wiki/ that page/write and page/rm may not touch (also matched without .md). */
const PAGE_FORBIDDEN_REFS = new Set([
  "index",
  "schema",
  "purpose",
  "wiki/index",
  "wiki/schema",
  "wiki/purpose",
]);

export class WikiService {
  private readonly store: IKnowledgeStore;
  private readonly dataRoot: string;
  private readonly worker: WikiWorker;
  private readonly queue: BuildQueue;
  private readonly logger?: WikiServiceLogger;
  private readonly callbackConfig?: {
    tmcCallbackUrl: string;
    resolveLlm: (serviceId: string) => import("../config.js").LlmConfig;
  };
  /**
   * Abort flags (generation-scoped, design 2026-09-21 §3.3).
   *
   * key = wiki_id, value = the version of the **aborted generation** of ingest.
   *
   * Why generation-scoped: onBusy:'replace' **enqueues the new task immediately** after setting the flag, and
   * old and new tasks share the same wiki_id key in SerialQueue. If we only checked "is there a flag",
   * the new task's runBuild entry checkpoint would treat itself as "aborted" too and abort immediately,
   * leaving the wiki stuck in draft with ingest never running. With the version:
   *   - the old task carries version=N, the flag holds N → match, abort;
   *   - the new task carries version=N+1, the flag still holds N → no match, runs normally.
   *
   * delete() uses -1 as a sentinel (matches any generation, since the row gets hard-deleted
   * and all subsequent queued tasks should abort).
   *
   * In-memory only (the same id is serialized by SerialQueue + Node is single-threaded, so reads/writes never race).
   * Removed after wrap-up.
   */
  private readonly cancelled = new Map<string, number>();

  /** Abort sentinel for delete: matches any generation. */
  private static readonly CANCEL_ALL_VERSIONS = -1;

  constructor(opts: WikiServiceOptions) {
    this.store = opts.store;
    this.dataRoot = opts.dataRoot;
    this.worker = opts.worker;
    this.queue = opts.queue ?? new BuildQueue();
    this.logger = opts.logger;
    this.callbackConfig = opts.callbackConfig;
  }

  dirFor(serviceId: string, teamId: string, wikiId: string): string {
    return join(this.dataRoot, serviceId, teamId, wikiId);
  }

  /**
   * Create wiki metadata + directory shell. **Does not auto-ingest**.
   * Idempotent: the same (service_id, team_id, name) returns the existing row.
   */
  create(params: CreateWikiParams): { row: WikiRow; existed: boolean } {
    const { row, existed } = this.store.createWiki(params);
    if (!existed) {
      const dir = this.dirFor(row.service_id, row.team_id, row.wiki_id);
      mkdirSync(join(dir, "raw", "sources"), { recursive: true });
      // Explicitly create index.db (4 tables, including source) — from then on rawWrite/rawLs read/write the source table directly (design 006/003).
      try {
        initIndexDb(dir);
      } catch (err) {
        this.logger?.warn?.(`[wiki] initIndexDb failed for ${row.wiki_id}: ${String(err)}`);
      }
      this.audit(row, "create", `create wiki ${row.name}`, params.user_id);
    }
    return { row, existed };
  }

  /** Persist service_url for a wiki. Returns updated row or null. */
  updateServiceUrl(serviceId: string, wikiId: string, serviceUrl: string): WikiRow | null {
    this.store.updateWikiStatus(serviceId, wikiId, { service_url: serviceUrl });
    return this.store.getWikiById(serviceId, wikiId);
  }

  /** Update wiki metadata (name, summary). Returns updated row or null. */
  updateMeta(serviceId: string, wikiId: string, patch: { name?: string; summary?: string | null }): WikiRow | null {
    return this.store.updateWikiMeta(serviceId, wikiId, patch);
  }

  /**
   * Explicitly trigger ingest (LLM processes raw → page + builds index).
   * Returns immediately and runs asynchronously in the background. memory/team mismatch returns not_found.
   *
   * When a task is already in flight (pending/processing), behavior is determined by opts.onBusy (design 2026-09-21 §3.3):
   *   - 'reject' (default): return busy (HTTP 409), no status overwrite, no audit — original semantics;
   *   - 'replace': set the cancelled flag + internal_status='cancelling', and queue the new task into
   *     SerialQueue (FIFO). When the old worker returns, the runBuild checkpoint does the preserveRaw wrap-up
   *     (status reset to draft, wiki row and raw kept), and the new task scans normally once dequeued.
   *     This way "cancel old task + queue new task" completes atomically within one call, with no intermediate dirty state.
   */
  ingest(
    serviceId: string,
    teamId: string,
    wikiId: string,
    requesterUserId?: string,
    opts?: IngestOptions,
  ): IngestResult {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return { kind: "not_found" };

    const inFlightStatus = row.status === "pending" || row.status === "processing" ? row.status : null;
    if (inFlightStatus && opts?.onBusy !== "replace") {
      // Concurrent rejection: reject outright while queued/executing — no status overwrite, no re-enqueue, no audit.
      return { kind: "busy", status: inFlightStatus, step: row.internal_status };
    }
    const inFlight = inFlightStatus !== null;

    if (inFlight) {
      // replace semantics: abort only **the current generation** (row.version); the new task at version+1 is unaffected;
      // also set the intermediate cancelling state so the frontend can see it.
      this.cancelled.set(wikiId, row.version);
      this.store.updateWikiStatus(serviceId, wikiId, { internal_status: "cancelling" });
    }

    const nextVersion = row.version + 1;
    this.store.updateWikiStatus(serviceId, wikiId, {
      status: "pending",
      internal_status: null,
      sync_error: null,
      version: nextVersion,
    });
    this.audit({ ...row, version: nextVersion }, "ingest", inFlight ? "ingest (replace)" : "manual ingest", requesterUserId);
    const fresh = this.store.getWiki(serviceId, teamId, wikiId);
    if (fresh) this.enqueueBuild(fresh);
    if (!fresh) return { kind: "not_found" };
    return inFlight ? { kind: "queued", row: fresh } : { kind: "ok", row: fresh };
  }

  /** sync semantics = re-run ingest (explicitly triggered by the control plane). Keeps reject semantics unchanged. */
  sync(serviceId: string, teamId: string, wikiId: string, requesterUserId?: string): IngestResult {
    return this.ingest(serviceId, teamId, wikiId, requesterUserId);
  }

  get(serviceId: string, teamId: string, wikiId: string): WikiRow | null {
    return this.store.getWiki(serviceId, teamId, wikiId);
  }

  /** Look up by globally unique wiki_id (still scoped by service_id to prevent cross-tenant access). For spec id-only endpoints. */
  getById(serviceId: string, wikiId: string): WikiRow | null {
    return this.store.getWikiById(serviceId, wikiId);
  }

  list(serviceId: string, teamId: string, opts?: ListOpts): WikiRow[] {
    return this.store.listWikis(serviceId, teamId, opts);
  }

  count(serviceId: string, teamId: string, opts?: CountOpts): number {
    return this.store.countWikis(serviceId, teamId, opts);
  }

  /**
   * Delete a wiki (008 / 007 §5.5). Deletable in any state (including pending/processing).
   * memory/team mismatch returns false; otherwise hard delete + cleanup of four resource kinds, returns true.
   *
   * If the resource is queued/executing, first set the cancelled flag to tell the worker to abort at a checkpoint, then immediately
   * hard delete + clean up (without waiting for the worker). When the worker re-checks before finishing and finds it deleted, it skips ready/callback and does
   * another idempotent cleanup, leaving nothing behind.
   */
  delete(serviceId: string, teamId: string, wikiId: string): boolean {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return false;

    if (row.status === "pending" || row.status === "processing") {
      // Sentinel -1: delete hard-deletes the row, so every queued generation should abort.
      this.cancelled.set(wikiId, WikiService.CANCEL_ALL_VERSIONS);
    }

    this.audit(row, "delete", null);
    this.cleanupResources(serviceId, teamId, wikiId);
    // Don't remove the cancelled flag here (covers the window where delete precedes the worker checkpoint);
    // finishCancelled removes it when the worker finishes. cleanup is idempotent; repeats are harmless.
    return true;
  }

  /**
   * Idempotent cleanup of four resource kinds (order: release connections first, then delete from disk). Each step has its own try/catch; exception-safe.
   *   1. index.db read connection pool: evictWikiDb (idempotent; the worker's withWriteDb finally already closes the write connection)
   *   2. metadata row: hard delete (safe even if 0 rows match; supports double cleanup by worker + delete)
   *   3. disk directory (wiki/ raw/ index.db and -wal/-shm): rmSync recursive+force (idempotent)
   * Queued BuildQueue tasks are skipped by the runBuild entry check on cancelled/row existence, so nothing to do here.
   */
  private cleanupResources(serviceId: string, teamId: string, wikiId: string): void {
    try {
      evictWikiDb(wikiId);
    } catch (err) {
      this.logger?.warn?.(`[wiki] evict index.db failed ${wikiId}: ${String(err)}`);
    }
    try {
      this.store.deleteWiki(serviceId, teamId, wikiId);
    } catch (err) {
      this.logger?.warn?.(`[wiki] hard-delete row failed ${wikiId}: ${String(err)}`);
    }
    try {
      rmSync(this.dirFor(serviceId, teamId, wikiId), { recursive: true, force: true });
    } catch (err) {
      this.logger?.warn?.(`[wiki] rm dir failed ${wikiId}: ${String(err)}`);
    }
  }

  /**
   * Worker checkpoint: whether this build should abort.
   *
   * Two criteria (covering both delete-during-run and delete-already-done timings):
   *   1. Generation-scoped cancelled flag hit: the flagged generation is -1 (delete sentinel, matches any generation),
   *      or equals the version this task was enqueued with (replace precisely hits the old generation);
   *   2. The row is no longer in the DB.
   *
   * Generation comparison ensures the **new task enqueued by replace isn't hit by the flag it triggered itself**.
   */
  private isDeleted(serviceId: string, wikiId: string, version: number): boolean {
    const marked = this.cancelled.get(wikiId);
    const cancelledHit =
      marked !== undefined &&
      (marked === WikiService.CANCEL_ALL_VERSIONS || marked === version);
    return cancelledHit || this.store.getWikiById(serviceId, wikiId) === null;
  }

  /**
   * Wrap-up (idempotent) after a worker checkpoint determines "must abort".
   *
   * opts.preserveRaw=true (design 2026-09-21 §3.3.2, triggered by ingest(onBusy:'replace')):
   *   only reset status to draft — keep the wiki metadata row, raw, and already-ready pages
   *   so the subsequent new task can continue via incremental diffing. No deletion at all.
   *
   * opts.preserveRaw=false or omitted (original delete trigger):
   *   evict read connection pool + hard-delete metadata row + rmSync disk directory (the cleanupResources trio).
   *
   * Both branches remove the cancelled flag.
   */
  private finishCancelled(
    serviceId: string,
    teamId: string,
    wikiId: string,
    opts?: { preserveRaw?: boolean },
  ): void {
    if (opts?.preserveRaw) {
      // Reset to draft only when "the current row is still our own generation (version <= cancelled generation)".
      //
      // If the new task has already bumped the version (on replace, ingest() immediately does version+1 and sets
      // pending), the new task has taken over this row — we **must not** reset then, or we'd overwrite the new
      // task's pending with draft, and the frontend would see a bogus "awaiting processing/queued" window when actually
      // the old worker clobbered the new task's status. Just step aside; the new task drives its own status.
      const current = this.store.getWikiById(serviceId, wikiId);
      const cancelledVersion = this.cancelled.get(wikiId);
      const superseded =
        current !== null &&
        cancelledVersion !== undefined &&
        cancelledVersion !== WikiService.CANCEL_ALL_VERSIONS &&
        current.version > cancelledVersion;
      if (superseded) {
        this.logger?.info?.(
          `[wiki] ${wikiId} old build aborted; newer ingest (v${current?.version}) already owns status, leaving as-is`,
        );
      } else {
        this.store.updateWikiStatus(serviceId, wikiId, {
          status: "draft",
          internal_status: null,
          sync_error: "cancelled by user",
        });
        this.logger?.info?.(`[wiki] ${wikiId} build aborted (replaced by newer ingest; raw preserved)`);
      }
    } else {
      this.cleanupResources(serviceId, teamId, wikiId);
      this.logger?.info?.(`[wiki] ${wikiId} build aborted (deleted during processing)`);
    }
    this.cancelled.delete(wikiId);
  }

  /**
   * Determine what triggered this abort:
   *   - wiki row still exists → triggered by ingest(onBusy:'replace') → preserveRaw (keep raw);
   *   - wiki row deleted → triggered by delete() → hard delete.
   *
   * Note: isDeleted() can't be used to distinguish these (it's the dual criterion of cancelled flag OR missing row);
   * row existence must be checked separately.
   */
  private isCancelledByReplace(serviceId: string, wikiId: string): boolean {
    return this.store.getWikiById(serviceId, wikiId) !== null;
  }

  /** Write a wiki audit record. Failures don't block the main flow. */
  private audit(row: WikiRow, action: AuditAction, detail: string | null, requesterUserId?: string): void {
    try {
      this.store.appendWikiAudit({
        service_id: row.service_id,
        asset_id: row.wiki_id,
        version: row.version,
        action,
        // Prefer recording the requester (initiator of ingest/create), falling back to the row's creator.
        user_id: requesterUserId ?? row.user_id,
        agent_id: row.agent_id,
        detail,
      });
    } catch (err) {
      this.logger?.warn?.(`[wiki] audit ${action} failed: ${String(err)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // File layer — raw/* (source material under raw/sources/)
  // ═══════════════════════════════════════════════════════════════════

  /** List source material files under raw/sources/ (now queries the source table, design 003 §3.5). Returns null if the wiki doesn't exist. */
  rawLs(serviceId: string, teamId: string, wikiId: string): RawFileEntry[] | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    const dir = this.dirFor(serviceId, teamId, wikiId);
    try {
      const db = getReadDb(wikiId, dir);
      return listSources(db).map((s) => ({
        filename: s.filename,
        size: s.size,
        status: s.status,
        created_at: s.created_at,
        updated_at: s.updated_at,
        last_modified_by: s.last_modified_by,
        ingested_at: s.ingested_at,
        uploaded_at: s.created_at, // legacy-compatible field
      }));
    } catch {
      // index.db not created yet (old wiki / never rawWrite) → no source registered.
      return [];
    }
  }

  /** Read the raw contents of a single raw file. Returns null if the file doesn't exist (including when the wiki doesn't exist). */
  rawRead(serviceId: string, teamId: string, wikiId: string, filename: string): string | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    const safe = this.resolveRawPath(sourcesDir, filename);
    if (!safe) return null;
    try {
      return readFileSync(safe, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Batch read raw files.
   * - wiki doesn't exist → null
   * - any filename with path traversal → "invalid_path"
   * - exceeds RAW_READ_MAX → throws (router converts to 400)
   * A single missing file isn't an error; the corresponding item is marked not_found:true (spec: overall still 200).
   */
  rawReadMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filenames: string[],
  ): WriteOutcome<RawReadItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (filenames.length > RAW_READ_MAX) {
      throw new Error(`filenames exceeds max ${RAW_READ_MAX}`);
    }
    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    // Validate all paths first (any invalid one fails the whole batch with 400)
    const safePaths: string[] = [];
    for (const fn of filenames) {
      const safe = this.resolveRawPath(sourcesDir, fn);
      if (!safe) return "invalid_path";
      safePaths.push(safe);
    }
    const items: RawReadItem[] = [];
    for (let i = 0; i < filenames.length; i++) {
      const filename = filenames[i];
      try {
        const content = readFileSync(safePaths[i], "utf-8");
        items.push({ filename, content });
      } catch {
        items.push({ filename, not_found: true });
      }
    }
    return items;
  }

  /**
   * Write/overwrite a single raw file (upsert) + register in the source table (design 003 §3.4).
   * - wiki doesn't exist → null
   * - processing → "processing"
   * - path traversal → "invalid_path"
   * - over 5MB → "too_large"
   */
  rawWrite(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filename: string,
    content: string,
    userId?: string,
  ): WriteOutcome<RawWriteResult> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    // Note: processing is **deliberately not blocked** here. Design 2026-09-21 "import and extract" requires
    // "new import overrides old import": re-importing during extraction must be allowed to write raw, otherwise it returns
    // 409 "wiki is processing; cannot write/delete" and blocks the import.
    // Safety: the following ingest(onBusy:'replace') cancels the old task, and its page output
    // is discarded by the runBuild checkpoint; the new task re-scans all raw by sha256 diff
    // (skipping those already ingested with unchanged sha), so no dirty data gets persisted.

    const size = Buffer.byteLength(content, "utf-8");
    if (size > RAW_WRITE_MAX_BYTES) return "too_large";

    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    const safe = this.resolveRawPath(sourcesDir, filename);
    if (!safe) return "invalid_path";

    mkdirSync(sourcesDir, { recursive: true });
    writeFileSync(safe, content, "utf-8");
    this.registerSources(serviceId, teamId, wikiId, [{ filename, content, size }], userId);
    return { filename, size };
  }

  /**
   * Batch write raw files (whole batch atomic).
   * - Validate everything first: path traversal → "invalid_path"; any item over 5MB → "too_large"
   * - Once all pass, write files one by one; if any write fails, roll back previously written files (deleting files
   *   that weren't there originally), ensuring the batch either fully succeeds or has no effect.
   * Error codes are the same as rawWrite.
   */
  rawWriteMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    files: { filename: string; content: string }[],
    userId?: string,
  ): WriteOutcome<RawWriteManyItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    // Same as above (rawWrite): deliberately don't block processing, to support overwriting via "re-import during extraction".
    if (files.length > RAW_WRITE_MAX) {
      throw new Error(`files exceeds max ${RAW_WRITE_MAX}`);
    }

    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    type Plan = {
      filename: string;
      safePath: string;
      content: string;
      size: number;
      preExistingContent: string | null; // recorded if it existed before writing; restored on rollback
    };
    const plans: Plan[] = [];
    for (const { filename, content } of files) {
      if (typeof content !== "string") return "invalid_path";
      const size = Buffer.byteLength(content, "utf-8");
      if (size > RAW_WRITE_MAX_BYTES) return "too_large";
      const safe = this.resolveRawPath(sourcesDir, filename);
      if (!safe) return "invalid_path";
      let pre: string | null = null;
      try {
        pre = readFileSync(safe, "utf-8");
      } catch {
        pre = null;
      }
      plans.push({ filename, safePath: safe, content, size, preExistingContent: pre });
    }

    mkdirSync(sourcesDir, { recursive: true });
    const written: Plan[] = [];
    try {
      for (const p of plans) {
        writeFileSync(p.safePath, p.content, "utf-8");
        written.push(p);
      }
    } catch (err) {
      // Rollback: restore the old content of each written file (delete if it didn't exist)
      for (const p of written) {
        try {
          if (p.preExistingContent === null) {
            rmSync(p.safePath, { force: true });
          } else {
            writeFileSync(p.safePath, p.preExistingContent, "utf-8");
          }
        } catch {
          // If rollback also fails, all we can do is leave it to the caller to re-run ingest as a fallback
        }
      }
      throw err;
    }

    // After all files are written, register in the source table (check then update; idempotent when sha is unchanged).
    this.registerSources(
      serviceId,
      teamId,
      wikiId,
      plans.map((p) => ({ filename: p.filename, content: p.content, size: p.size })),
      userId,
    );
    // After pulling to disk, bump version + update last_sync_at (design §3.1⑥).
    // - version is used for downstream change detection (ingest compares source file version vs extracted version)
    // - last_sync_at is the observation point for external sync ("last pull time")
    // Idempotency: even if all file contents are identical, write + register still runs and the version still advances;
    //   this is the expected behavior of the SoT (wiki table state): once raw is written it counts as a new version,
    //   and downstream ingest decides whether to actually re-extract (skipped when sha is identical).
    if (plans.length > 0) {
      this.store.updateWikiStatus(serviceId, wikiId, {
        version: row.version + 1,
        last_sync_at: new Date().toISOString(),
      });
    }
    return plans.map(({ filename, size }) => ({ filename, size }));
  }

  // ─────────────────────────────────────────────────────────────
  // Import filename mapping (externalId → filename)
  //
  // Background: wiki import (wiki-source) derives on-disk filenames from the document **title** (readable),
  // but titles change, and a "title" is not a stable identity. Scheduled sync fully re-pulls every round, and dedupe groups are only valid within a round,
  // so after a remote rename: new title → new file created; another doc still using the old title → reuses the old filename and overwrites it,
  // causing cross-contaminated content + leftover junk files, with no warning at all.
  //
  // Fix: persist provider+externalId → filename to import-map.json in the wiki directory.
  // Previously imported documents reuse their old filename; the title is for display only. Storage lives here (rather than in import-runner) because
  // only this class holds dataRoot / dirFor(), so callers don't need to pass paths through.
  // ─────────────────────────────────────────────────────────────

  /** Mapping file path: `<wikiDir>/import-map.json`. */
  private importMapPath(serviceId: string, teamId: string, wikiId: string): string {
    return join(this.dirFor(serviceId, teamId, wikiId), "import-map.json");
  }

  /**
   * Read the filename mapping for a provider.
   * File missing/corrupt → return an empty object (degrades to the old "generate from title" behavior without blocking import).
   */
  readImportNameMap(
    serviceId: string,
    teamId: string,
    wikiId: string,
    providerId: string,
  ): Record<string, string> {
    try {
      const p = this.importMapPath(serviceId, teamId, wikiId);
      if (!existsSync(p)) return {};
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as ImportNameMapFile | null;
      const providers = parsed?.providers;
      if (!providers || typeof providers !== "object") return {};
      const m = providers[providerId];
      // Legacy structure compatibility: the value may be a { filename } object
      if (!m || typeof m !== "object") return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(m)) {
        const fn = typeof v === "string" ? v : v?.filename;
        if (typeof fn === "string" && fn) out[k] = fn;
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Write back the filename mapping for a provider (full overwrite).
   * Write failures are only logged — the files are already on disk; a lost mapping only affects name reuse in the next round and doesn't block the current import.
   */
  writeImportNameMap(
    serviceId: string,
    teamId: string,
    wikiId: string,
    providerId: string,
    map: Record<string, string>,
  ): void {
    try {
      const p = this.importMapPath(serviceId, teamId, wikiId);
      let file: ImportNameMapFile = { version: 1, providers: {} };
      if (existsSync(p)) {
        try {
          const parsed = JSON.parse(readFileSync(p, "utf-8")) as ImportNameMapFile | null;
          if (parsed && typeof parsed === "object" && parsed.providers) file = parsed;
        } catch {
          // Rebuild entirely if corrupt
        }
      }
      file.providers[providerId] = map;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(file, null, 2), "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.(`import-map write failed: ${msg}`);
    }
  }

  /**
   * Batch delete raw files + cascade cleanup of downstream pages.
   * Calls the lib-layer deleteSourceFiles, which decides each page's fate internally.
   * - wiki doesn't exist → null
   * - processing → "processing"
   * - filenames contain path traversal → "invalid_path"
   * - more than 50 → throws (router converts to 400)
   */
  async rawRm(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filenames: string[],
  ): Promise<WriteOutcome<RawRmResult>> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (filenames.length > RAW_RM_MAX) {
      throw new Error(`filenames exceeds max ${RAW_RM_MAX}`);
    }

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const sourcesDir = join(projectPath, "raw", "sources");
    const fullPaths: string[] = [];
    for (const fn of filenames) {
      const safe = this.resolveRawPath(sourcesDir, fn);
      if (!safe) return "invalid_path";
      fullPaths.push(safe);
    }

    // In-house cascade delete: delete raw sources and clean up pages referencing them (driven by frontmatter sources).
    const { deleteSourceFiles } = await import(
      "../engines/wiki/ingest-v2/cascade.js"
    );
    const result = await deleteSourceFiles(projectPath, fullPaths, {
      logReason: "wiki/raw/rm",
    });

    // Delete the corresponding source rows (matching the file cascade delete, design 003 §5).
    try {
      initIndexDb(projectPath);
      withWriteDb(projectPath, (db) => deleteSources(db, filenames));
    } catch (err) {
      this.logger?.warn?.(`[wiki] source rows delete failed: ${String(err)}`);
    }

    return {
      deleted_files: filenames,
      deleted_pages: result.deletedWikiPaths.map((p: string) =>
        this.absToPageRef(projectPath, p),
      ),
      rewritten_pages: result.rewrittenSourcePages,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // File layer — page/* (processed pages under wiki/)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * List page files under wiki/ (recursively scans .md for frontmatter).
   * Returns an empty array when status≠ready.
   */
  pageLs(serviceId: string, teamId: string, wikiId: string): { id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[] | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status !== "ready") return [];

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const wikiDir = join(projectPath, "wiki");
    if (!existsSync(wikiDir)) return [];

    const items: { id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[] = [];
    this.scanPagesRecursive(wikiDir, wikiDir, items);
    return items;
  }

  /** Read the raw contents of a single page. ref can be a page id or relPath. */
  pageRead(serviceId: string, teamId: string, wikiId: string, ref: string): string | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const safe = this.resolvePageRef(projectPath, ref);
    if (!safe) return null;
    try {
      return readFileSync(safe, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Batch read raw page contents.
   * - wiki doesn't exist → null
   * - any ref with path traversal → "invalid_path"
   * - exceeds PAGE_READ_MAX → throws
   * A single missing ref isn't an error; the corresponding item is marked not_found:true (spec: overall still 200).
   */
  pageReadMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    refs: string[],
  ): WriteOutcome<PageReadItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (refs.length > PAGE_READ_MAX) {
      throw new Error(`refs exceeds max ${PAGE_READ_MAX}`);
    }
    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const safePaths: string[] = [];
    for (const r of refs) {
      // allowMissing alone isn't enough for reads — not_found must still be a valid path, so here we
      // distinguish "valid path but file missing (not_found)" from "invalid path (invalid_path)"
      const safe = this.resolvePageRef(projectPath, r, { allowMissing: true });
      if (!safe) return "invalid_path";
      safePaths.push(safe);
    }
    const items: PageReadItem[] = [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      try {
        const content = readFileSync(safePaths[i], "utf-8");
        items.push({ ref, content });
      } catch {
        items.push({ ref, not_found: true });
      }
    }
    return items;
  }

  /**
   * Write/overwrite a single page (upsert). Automatically injects `locked: true` into frontmatter.
   * - wiki doesn't exist → null
   * - processing → "processing"
   * - path traversal → "invalid_path"
   * - structural file → "forbidden_path"
   * - over 512KB → "too_large"
   */
  pageWrite(
    serviceId: string,
    teamId: string,
    wikiId: string,
    ref: string,
    content: string,
  ): WriteOutcome<PageWriteResult> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";

    const size = Buffer.byteLength(content, "utf-8");
    if (size > PAGE_WRITE_MAX_BYTES) return "too_large";

    if (this.isForbiddenPageRef(ref)) return "forbidden_path";

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const safe = this.resolvePageRef(projectPath, ref, { allowMissing: true });
    if (!safe) return "invalid_path";

    const { content: finalContent, lockedInjected } = injectLockedTrue(content);

    mkdirSync(join(safe, ".."), { recursive: true });
    writeFileSync(safe, finalContent, "utf-8");
    return { ref, locked_injected: lockedInjected };
  }

  /**
   * Batch write pages (whole batch atomic). Each item automatically gets frontmatter `locked: true` injected.
   * - Validate everything first: processing → "processing"; path traversal → "invalid_path";
   *   structural file → "forbidden_path"; over 512KB → "too_large"
   * - Once all pass, write files one by one; if any fails, roll back the written files.
   */
  pageWriteMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    pages: { ref: string; content: string }[],
  ): WriteOutcome<PageWriteManyItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (pages.length > PAGE_WRITE_MAX) {
      throw new Error(`pages exceeds max ${PAGE_WRITE_MAX}`);
    }

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    type Plan = {
      ref: string;
      safePath: string;
      finalContent: string;
      lockedInjected: boolean;
      preExistingContent: string | null;
    };
    const plans: Plan[] = [];
    for (const { ref, content } of pages) {
      if (typeof content !== "string") return "invalid_path";
      if (this.isForbiddenPageRef(ref)) return "forbidden_path";
      const size = Buffer.byteLength(content, "utf-8");
      if (size > PAGE_WRITE_MAX_BYTES) return "too_large";
      const safe = this.resolvePageRef(projectPath, ref, { allowMissing: true });
      if (!safe) return "invalid_path";
      const { content: finalContent, lockedInjected } = injectLockedTrue(content);
      let pre: string | null = null;
      try {
        pre = readFileSync(safe, "utf-8");
      } catch {
        pre = null;
      }
      plans.push({ ref, safePath: safe, finalContent, lockedInjected, preExistingContent: pre });
    }

    const written: Plan[] = [];
    try {
      for (const p of plans) {
        mkdirSync(join(p.safePath, ".."), { recursive: true });
        writeFileSync(p.safePath, p.finalContent, "utf-8");
        written.push(p);
      }
    } catch (err) {
      for (const p of written) {
        try {
          if (p.preExistingContent === null) {
            rmSync(p.safePath, { force: true });
          } else {
            writeFileSync(p.safePath, p.preExistingContent, "utf-8");
          }
        } catch {
          // best-effort rollback
        }
      }
      throw err;
    }

    return plans.map(({ ref, lockedInjected }) => ({ ref, locked_injected: lockedInjected }));
  }

  /**
   * Batch delete pages + cascade cleanup of references. Calls the lib-layer cascadeDeleteWikiPagesWithRefs.
   * - wiki doesn't exist → null
   * - processing → "processing"
   * - contains path traversal → "invalid_path"
   * - contains a structural file → "forbidden_path"
   * - more than 20 → throws
   */
  async pageRm(
    serviceId: string,
    teamId: string,
    wikiId: string,
    refs: string[],
  ): Promise<WriteOutcome<PageRmResult>> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (refs.length > PAGE_RM_MAX) {
      throw new Error(`refs exceeds max ${PAGE_RM_MAX}`);
    }

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const fullPaths: string[] = [];
    for (const r of refs) {
      if (this.isForbiddenPageRef(r)) return "forbidden_path";
      const safe = this.resolvePageRef(projectPath, r);
      if (!safe) return "invalid_path";
      fullPaths.push(safe);
    }

    const { cascadeDeleteWikiPagesWithRefs } = await import(
      "../engines/wiki/ingest-v2/cascade.js"
    );
    const result = await cascadeDeleteWikiPagesWithRefs(projectPath, fullPaths);

    return {
      deleted_pages: result.deletedPaths.map((p: string) =>
        this.absToPageRef(projectPath, p),
      ),
      rewritten_files: result.rewrittenFiles,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Register a batch of source files in the source table (used by rawWrite/rawWriteMany).
   * Ensures index.db exists (idempotent initIndexDb), and upserts each file via upsertSource in one write transaction
   * (check then update: new → uploaded / sha changed → reset to uploaded / sha unchanged → idempotent).
   * Registration failure doesn't block the main write flow (files are already on disk) — logs a warn and leaves it to later ingest/rawLs as a fallback.
   */
  private registerSources(
    serviceId: string,
    teamId: string,
    wikiId: string,
    files: { filename: string; content: string; size: number }[],
    userId?: string,
  ): void {
    const dir = this.dirFor(serviceId, teamId, wikiId);
    try {
      initIndexDb(dir);
      withWriteDb(dir, (db) => {
        for (const f of files) {
          upsertSource(db, {
            filename: f.filename,
            sha256: sha256(f.content),
            size: f.size,
            userId: userId ?? null,
          });
        }
      });
    } catch (err) {
      this.logger?.warn?.(`[wiki] source register failed for ${wikiId}: ${String(err)}`);
    }
  }

  private resolveRawPath(sourcesDir: string, filename: string): string | null {
    if (!filename || filename.includes("..") || filename.startsWith("/")) return null;
    const normalized = normalize(filename);
    if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
    // resolve(sourcesDir) converts to an absolute path, so that when sourcesDir is relative
    // (e.g. KNOWLEDGE_DATA_DIR=./data), comparison with the resolved absolute path doesn't fail.
    const base = resolve(sourcesDir);
    const safe = resolve(base, normalized);
    const dirWithSep = base.endsWith("/") ? base : base + "/";
    if (safe !== base && !safe.startsWith(dirWithSep)) return null;
    return safe;
  }

  /**
   * Resolve a page ref (id or relPath) → absolute path. Must fall under the wiki/ subtree.
   * - allowMissing=true for write: allowed even if the path doesn't exist
   * - allowMissing=false for read/rm: the file must already exist
   */
  private resolvePageRef(
    projectPath: string,
    ref: string,
    opts: { allowMissing?: boolean } = {},
  ): string | null {
    if (!ref || ref.includes("..") || ref.startsWith("/")) return null;
    const cleanRef = ref.replace(/^wiki\//, "");
    if (cleanRef.includes("..")) return null;

    // Resolve to an absolute path so comparison doesn't fail when projectPath is relative.
    const wikiDir = resolve(projectPath, "wiki");
    const wikiDirSep = wikiDir.endsWith("/") ? wikiDir : wikiDir + "/";

    // Try as-is first, then try appending the .md extension.
    const candidates = cleanRef.endsWith(".md") ? [cleanRef] : [cleanRef + ".md", cleanRef];
    for (const c of candidates) {
      const safe = resolve(wikiDir, c);
      if (safe !== wikiDir && !safe.startsWith(wikiDirSep)) continue;
      if (opts.allowMissing) {
        // write path with .md appended: allow either one
        return c.endsWith(".md") ? safe : null;
      }
      if (existsSync(safe)) return safe;
    }
    if (opts.allowMissing) {
      // When no .md candidate matched, force-append .md
      const safe = resolve(wikiDir, cleanRef.endsWith(".md") ? cleanRef : cleanRef + ".md");
      if (safe === wikiDir || !safe.startsWith(wikiDirSep)) return null;
      return safe;
    }
    return null;
  }

  /** Convert a wiki/.../page.md absolute path back to a ref (e.g. "concepts/redis"). */
  private absToPageRef(projectPath: string, abs: string): string {
    const wikiDir = resolve(projectPath, "wiki");
    const prefix = wikiDir.endsWith("/") ? wikiDir : wikiDir + "/";
    if (!abs.startsWith(prefix)) return abs;
    return abs.slice(prefix.length).replace(/\.md$/, "");
  }

  private isForbiddenPageRef(ref: string): boolean {
    const cleanRef = ref.replace(/^wiki\//, "").replace(/\.md$/, "");
    return PAGE_FORBIDDEN_REFS.has(cleanRef) || PAGE_FORBIDDEN_REFS.has(`wiki/${cleanRef}`);
  }

  private scanPagesRecursive(
    baseDir: string,
    dir: string,
    out: { id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[],
  ): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === "media") continue;
        this.scanPagesRecursive(baseDir, full, out);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      let content = "";
      try {
        content = readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      const rel = full.slice(baseDir.length + 1).replace(/\\/g, "/");
      const id = rel.replace(/\.md$/, "");
      const fm = parseFrontmatterMin(content);
      out.push({
        id,
        title: fm.title || entry.replace(/\.md$/, "").replace(/-/g, " "),
        type: fm.type || "other",
        path: `wiki/${rel}`,
        ...(fm.description ? { description: fm.description } : {}),
        locked: fm.locked,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════

  private enqueueBuild(row: WikiRow): void {
    // The generation version is enqueued along with the task: runBuild compares it against the cancelled flag,
    // so the task newly enqueued by replace (higher version) isn't hit by the old generation's flag.
    const version = row.version;
    this.queue.enqueue(row.wiki_id, () =>
      this.runBuild(row.service_id, row.wiki_id, row.team_id, row.name, version),
    );
  }

  private async runBuild(
    serviceId: string,
    wikiId: string,
    teamId: string,
    name: string,
    version: number,
  ): Promise<void> {
    // Entry checkpoint: aborted while pending → skip; don't set processing, don't ingest.
    // preserveRaw depends on the trigger: replace (row still exists) keeps raw; delete (row gone) hard-deletes.
    if (this.isDeleted(serviceId, wikiId, version)) {
      this.finishCancelled(serviceId, teamId, wikiId, {
        preserveRaw: this.isCancelledByReplace(serviceId, wikiId),
      });
      return;
    }
    this.store.updateWikiStatus(serviceId, wikiId, {
      status: "processing",
      internal_status: "scanning",
      sync_error: null,
    });
    // Progress/terminal callbacks share the same generation, so Panel can reject late progress after a clear
    const ingestRunId = randomUUID();
    try {
      const result = await this.worker({
        wikiId,
        serviceId,
        teamId,
        name,
        dir: this.dirFor(serviceId, teamId, wikiId),
        setInternalStatus: (s) =>
          this.store.updateWikiStatus(serviceId, wikiId, { status: "processing", internal_status: s }),
        ingestRunId,
      });
      // Pre-finish checkpoint: aborted during processing → skip ready/audit/callback, idempotent wrap-up.
      if (this.isDeleted(serviceId, wikiId, version)) {
        this.finishCancelled(serviceId, teamId, wikiId, {
          preserveRaw: this.isCancelledByReplace(serviceId, wikiId),
        });
        return;
      }
      this.store.updateWikiStatus(serviceId, wikiId, {
        status: "ready",
        internal_status: null,
        sync_error: null,
        page_count: result?.pageCount ?? null,
        last_sync_at: new Date().toISOString(),
      });
      const synced = this.store.getWikiById(serviceId, wikiId);
      if (synced) {
        this.audit(synced, "ready", result?.pageCount != null ? `pages: ${result.pageCount}` : null);
      }
      this.logger?.info?.(`[wiki] ${wikiId} ready (pages: ${result?.pageCount ?? '?'})`);

      // Auto-generate summary + callback TMC
      await this.onBuildComplete(synced, "ready", null, ingestRunId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The worker threw, but if it was aborted in the meantime, treat it as cancelled rather than failed: skip failed status/callback and wrap up.
      if (this.isDeleted(serviceId, wikiId, version)) {
        this.finishCancelled(serviceId, teamId, wikiId, {
          preserveRaw: this.isCancelledByReplace(serviceId, wikiId),
        });
        return;
      }
      this.store.updateWikiStatus(serviceId, wikiId, {
        status: "failed",
        internal_status: null,
        sync_error: msg.slice(0, 500),
      });
      const failed = this.store.getWikiById(serviceId, wikiId);
      if (failed) this.audit(failed, "failed", msg.slice(0, 500));
      this.logger?.warn?.(`[wiki] ${wikiId} failed: ${msg}`);

      // Callback TMC about failure
      await this.onBuildComplete(failed, "failed", msg, ingestRunId);
    }
  }

  /**
   * Post-build hook: generate summary (if synced) and callback TMC.
   * Never throws — runs after the main build is already committed.
   */
  private async onBuildComplete(
    row: WikiRow | null,
    status: "ready" | "failed",
    errorMsg: string | null,
    ingestRunId?: string,
  ): Promise<void> {
    if (!row || !this.callbackConfig) return;

    let summary: string | null = null;

    if (status === "ready") {
      // Generate summary via LLM (attempt even if some sources failed — generate as long as there are pages)
      try {
        const pages = this.pageLs(row.service_id, row.team_id, row.wiki_id) ?? [];
        this.logger?.info?.(`[wiki] summary generation start (wikiId=${row.wiki_id}, pages=${pages.length}, status=${status})`);
        const { generateWikiSummary } = await import("../callback.js");
        summary = await generateWikiSummary(
          row.wiki_id,
          row.name,
          pages.map((p) => ({ title: p.title, description: p.description })),
          this.callbackConfig.resolveLlm(row.service_id),
        );
        this.logger?.info?.(`[wiki] summary generation done (wikiId=${row.wiki_id}, len=${summary?.length ?? 0}, empty=${!summary})`);
        if (summary) {
          this.store.updateWikiStatus(row.service_id, row.wiki_id, { summary });
        }
      } catch (err) {
        this.logger?.warn?.(`[wiki] summary generation failed: ${String(err)}`);
      }
    }

    // Callback TMC
    const { callbackTMC } = await import("../callback.js");
    await callbackTMC(
      {
        knowledge_id: row.wiki_id,
        service_id: row.service_id,
        type: "wiki",
        status,
        summary,
        sync_error: errorMsg?.slice(0, 500) ?? null,
        timestamp: new Date().toISOString(),
        ...(ingestRunId ? { run_id: ingestRunId } : {}),
      },
      this.callbackConfig,
    );
  }

  async onIdle(wikiId?: string): Promise<void> {
    await this.queue.onIdle(wikiId);
  }
}

// ─── Module-level helpers (no class state dependency, easy to unit test) ───

/** Minimal frontmatter parsing (extracts title/type/description/locked), in the same style as manager. */
function parseFrontmatterMin(content: string): { title: string; type: string; description: string; locked: boolean } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const typeMatch = fm.match(/^type:\s*["']?(.+?)["']?\s*$/m);
  // description is written by ingest-v2 (see engines/wiki/ingest-v2/frontmatter.ts);
  // it's a one-sentence overview of the page — more descriptive than the title, used to generate the wiki summary.
  const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  const lockedMatch = fm.match(/^locked:\s*(true|false)\s*$/m);
  return {
    title: titleMatch ? titleMatch[1].trim() : "",
    type: typeMatch ? typeMatch[1].trim().toLowerCase() : "",
    description: descMatch ? descMatch[1].trim() : "",
    locked: lockedMatch ? lockedMatch[1] === "true" : false,
  };
}

/**
 * Inject `locked: true` into frontmatter:
 * - With frontmatter: if a locked: field exists, force it to true; otherwise append a line at the end of the frontmatter
 * - Without frontmatter: prepend a frontmatter block to the file (containing only locked: true)
 *
 * Returns { content, lockedInjected }; lockedInjected indicates whether **this call** actually added/changed the locked
 * field (already true counts as lockedInjected=false, since nothing changed).
 */
function injectLockedTrue(content: string): { content: string; lockedInjected: boolean } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) {
    const wrapped = `---\nlocked: true\n---\n${content.startsWith("\n") ? content.slice(1) : content}`;
    return { content: wrapped, lockedInjected: true };
  }
  const fmBody = fmMatch[1];
  const lockedMatch = fmBody.match(/^locked:\s*(true|false)\s*$/m);
  if (lockedMatch) {
    if (lockedMatch[1] === "true") return { content, lockedInjected: false };
    const newFmBody = fmBody.replace(/^locked:\s*(true|false)\s*$/m, "locked: true");
    return {
      content: content.replace(fmBody, newFmBody),
      lockedInjected: true,
    };
  }
  const newFmBody = fmBody.endsWith("\n") ? `${fmBody}locked: true` : `${fmBody}\nlocked: true`;
  return {
    content: content.replace(fmBody, newFmBody),
    lockedInjected: true,
  };
}

export const __testing = { parseFrontmatterMin, injectLockedTrue };
