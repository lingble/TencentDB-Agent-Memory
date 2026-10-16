/**
 * CodeGraphService — async orchestration of code-graph assets.
 *
 * Glues together IKnowledgeStore (metadata/status) + BuildQueue (background serial) + an injectable
 * worker (actual git clone + codegraph build) to provide:
 *   - create/sync return immediately (fire-and-forget); the control plane polls status;
 *   - state machine pending → processing(cloning/indexing) → ready / failed(+sync_error);
 *   - memory + team isolation, idempotency (same memory+team+repo+branch returns the existing one), hard delete + cleanup of four resource kinds.
 *
 * delete semantics (008 / 007 §5.5): deletable in any state (including pending/processing).
 * An in-memory cancelled flag tells the in-flight worker to abort (not persisted, no soft delete); if the worker
 * finds at a checkpoint before finishing that the resource was deleted, it skips ready/callback and does idempotent cleanup. Cleanup covers four resource kinds:
 * instance pool (memory) → metadata row (hard delete) → disk directory (rmSync), with per-step try/catch
 * so that a failure in any step doesn't affect the others (exception-safe + idempotent). Remote metadata reporting is not done in this phase.
 *
 * The worker is injected to ease unit testing (no real git/codegraph needed); see the router wiring for the production implementation.
 * Physical directory: {dataRoot}/{service_id}/{team_id}/{code_graph_id}/ (001 multi-tenancy).
 */

import { join } from "node:path";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";

import type {
  AuditAction,
  CodeGraphRow,
  IKnowledgeStore,
  ListOpts,
  CountOpts,
} from "./types.js";
import { BuildQueue } from "./build-queue.js";
import type { ICredentialStore } from "../source-auth/types.js";
import { SSH_PROVIDER_ID } from "../code-source/providers/ssh.js";
import type { AuthMethodKind } from "../code-source/auth-methods/types.js";
import type { CredentialKind } from "../source-auth/types.js";

export interface CodeGraphBuildContext {
  codeGraphId: string;
  serviceId: string;
  teamId: string;
  repoUrl: string;
  branch: string;
  /** Local working directory for this asset (checkout + index live here). */
  dir: string;
  /** Callable by the worker to update fine-grained internal status (cloning → indexing). */
  setInternalStatus: (s: string) => void;
  /**
   * 资产归属用户（SSH clone 用它定位该用户的私钥）。
   * 取 `owner_user_id ?? user_id`；两者都缺时为空串（worker 据此报「未配置 SSH 公钥」）。
   */
  ownerUserId?: string;
}

export interface CodeGraphBuildResult {
  commitHash?: string;
  stats?: { files: number; nodes: number; edges: number };
}

export type CodeGraphWorker = (ctx: CodeGraphBuildContext) => Promise<CodeGraphBuildResult>;

/**
 * sync result (discriminated union):
 *   - ok       rebuild enqueued;
 *   - not_found memory/team/id mismatch;
 *   - busy     currently pending/processing (concurrent rejection, maps to HTTP 409); step is the internal stage (may be null).
 */
export type SyncResult =
  | { kind: "ok"; row: CodeGraphRow }
  | { kind: "not_found" }
  | { kind: "busy"; status: "pending" | "processing"; step: string | null };

/**
 * build 的选项（透传至 runBuild；不传则行为与 create/sync 完全一致）。
 */
export interface BuildOptions {
  /**
   * true = 跳过 fetch/clone，直接用该资源**已有目录**的内容建索引。
   *
   * 目录恒为 `{dataRoot}/{service_id}/{team_id}/{code_graph_id}`，
   * 不接受任何外部传入路径（无路径穿越面，见设计文档 §4）。
   */
  fromLocalDir?: boolean;
}

/**
 * build 结果：在 sync 的判别联合基础上多一个「目录缺失/为空」分支。
 *
 * 单独成成员而不是复用 not_found —— 两者的处置完全不同：
 * not_found 是资源不存在（404），empty_dir 是资源存在但没内容可建（400）。
 */
export type BuildResult = SyncResult | { kind: "empty_dir" };

export interface CodeGraphServiceLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CodeGraphServiceOptions {
  store: IKnowledgeStore;
  /** knowledge data root directory; asset directory = {dataRoot}/{service_id}/{team_id}/{code_graph_id}/. */
  dataRoot: string;
  /** 常规 worker：拉取（clone/fetch）+ 建索引。create / sync 走它。 */
  worker: CodeGraphWorker;
  /**
   * 本地构建 worker：**只建索引，不拉取**。`POST /code-graph/build` 走它。
   *
   * 独立注入而非在 worker 里加分支 —— 保持线上 clone 链路的执行体单一语义，
   * 新增路径的回归风险不落在主链路上（设计文档 §3.1）。
   * 未注入时 build() 直接返回 empty_dir 之外的路径会失败，由装配层保证注入。
   */
  localWorker?: CodeGraphWorker;
  queue?: BuildQueue;
  logger?: CodeGraphServiceLogger;
  /** Callback config for TMC status notifications. Optional. */
  callbackConfig?: { tmcCallbackUrl: string };
  /**
   * External source credential store (when create carries a credential, it is persisted before enqueueing).
   * When not injected, create does not accept a credential parameter (public repo scenario).
   */
  credentialStore?: ICredentialStore;
  /**
   * Code source provider registry (used to read the auth method a provider declares).
   * Only depends on the `authMethod.kind` field, so the store layer doesn't depend back on the full code-source types.
   */
  codeSourceRegistry?: {
    get(id: string): { authMethod: { kind: AuthMethodKind } } | undefined;
  };
  /**
   * Release in-memory resources held by this code-graph (instance pool + close index handle).
   * Injected rather than depending on module directly, so the store layer doesn't depend back on the wiring layer. Idempotent: safe to call repeatedly.
   * Provided by module.ts during wiring (wraps instancePool.delete + closeIndex).
   */
  releaseInstance?: (codeGraphId: string) => void;
}

export interface CreateCodeGraphParams {
  service_id: string;
  team_id: string;
  repo_url: string;
  branch: string;
  repo_name?: string;
  owner_user_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  visibility?: string;
  /**
   * External source credential (private repo). Passed in the same request as create; KS persists it **before enqueueing the build**,
   * eliminating the race window of "create clones immediately before the credential is written".
   */
  credential?: {
    provider_id: string;
    secret: string;
    username?: string;
  };
}

export class CodeGraphService {
  private readonly store: IKnowledgeStore;
  private readonly dataRoot: string;
  private readonly worker: CodeGraphWorker;
  private readonly localWorker?: CodeGraphWorker;
  private readonly queue: BuildQueue;
  private readonly logger?: CodeGraphServiceLogger;
  private readonly callbackConfig?: { tmcCallbackUrl: string };
  private readonly releaseInstance?: (codeGraphId: string) => void;
  private readonly credentialStore?: ICredentialStore;
  private readonly codeSourceRegistry?: CodeGraphServiceOptions["codeSourceRegistry"];
  /**
   * In-flight delete flags: set when delete hits a resource that is queued/executing;
   * the worker reads them at checkpoints to decide whether to abort. In-memory only (the same id is serialized by SerialQueue +
   * Node is single-threaded, so reads/writes never race). Removed after cleanup finishes.
   */
  private readonly cancelled = new Set<string>();

  constructor(opts: CodeGraphServiceOptions) {
    this.store = opts.store;
    this.dataRoot = opts.dataRoot;
    this.localWorker = opts.localWorker;
    this.worker = opts.worker;
    this.queue = opts.queue ?? new BuildQueue();
    this.logger = opts.logger;
    this.callbackConfig = opts.callbackConfig;
    this.releaseInstance = opts.releaseInstance;
    this.credentialStore = opts.credentialStore;
    this.codeSourceRegistry = opts.codeSourceRegistry;
  }

  dirFor(serviceId: string, teamId: string, codeGraphId: string): string {
    return join(this.dataRoot, serviceId, teamId, codeGraphId);
  }

  /**
   * Idempotently create and build the graph asynchronously.
   * - Already exists (same memory+team+repo+branch) → return the existing row directly, without rebuilding.
   * - New → persist as pending + build in the background.
   */
  create(params: CreateCodeGraphParams): { row: CodeGraphRow; existed: boolean } {
    const { row, existed } = this.store.createCodeGraph(params);
    if (!existed) {
      // ① Private repo: persist the credential before enqueueing (otherwise the worker clones immediately before the credential exists → 401).
      //
      // Exception: SSH sources don't persist a credential row — they use a per-user private key + GIT_SSH_COMMAND
      // instead of a token injected into the URL. If a credential row were stored, the worker would hand the ssh:// URL
      // to the basic-auth builder, which would turn it into https://... and blow up. See design doc §2.2 D2.
      const isSshSource = params.credential?.provider_id === SSH_PROVIDER_ID;
      if (params.credential && !isSshSource) {
        if (!this.credentialStore) {
          throw new Error("credential provided but credentialStore is not wired");
        }
        // The persisted kind is determined by the provider's auth method; falls back to bearer when no registry is injected.
        //
        // AuthMethodKind has one more member than CredentialKind: "ssh-key" (protocol-level, never persisted).
        // Narrow explicitly here: anything other than bearer/basic is treated as bearer — whatever reaches this point
        // is definitely not ssh (excluded above); the narrowing only satisfies the type system and doesn't change runtime behavior.
        const declared =
          this.codeSourceRegistry?.get(params.credential.provider_id)?.authMethod.kind ?? "bearer";
        const kind: CredentialKind = declared === "basic" ? "basic" : "bearer";
        this.credentialStore.put(
          { type: "code-graph", serviceId: row.service_id, resourceId: row.code_graph_id },
          { kind, secret: params.credential.secret, username: params.credential.username },
          params.credential.provider_id,
          params.user_id,
        );
      }
      this.audit(row, "create", `clone ${row.repo_url}@${row.branch}`, params.user_id);
      this.enqueueBuild(row);
    }
    return { row, existed };
  }

  /** Persist service_url for a code-graph. Returns updated row or null. */
  updateServiceUrl(serviceId: string, codeGraphId: string, serviceUrl: string): CodeGraphRow | null {
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, { service_url: serviceUrl });
    return this.store.getCodeGraphById(serviceId, codeGraphId);
  }

  /** Update code-graph metadata (repo_name, summary). Returns updated row or null. */
  updateMeta(serviceId: string, codeGraphId: string, patch: { repo_name?: string; summary?: string | null }): CodeGraphRow | null {
    return this.store.updateCodeGraphMeta(serviceId, codeGraphId, patch);
  }

  /** Re-pull + rebuild (explicitly triggered by the control plane). memory/team mismatch returns not_found; pending/processing returns busy. */
  sync(serviceId: string, teamId: string, codeGraphId: string, requesterUserId?: string): SyncResult {
    const row = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (!row) return { kind: "not_found" };
    // Concurrent rejection: reject outright while queued/executing — no status overwrite, no re-enqueue, no audit.
    if (row.status === "pending" || row.status === "processing") {
      return { kind: "busy", status: row.status, step: row.internal_status };
    }
    const nextVersion = row.version + 1;
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
      status: "pending",
      internal_status: null,
      sync_error: null,
      version: nextVersion,
    });
    this.audit({ ...row, version: nextVersion }, "ingest", "manual sync", requesterUserId);
    const fresh = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (fresh) this.enqueueBuild(fresh);
    return fresh ? { kind: "ok", row: fresh } : { kind: "not_found" };
  }

  /**
   * 本地目录构建：**不拉取**，直接用该资源已有目录的内容重建索引。
   *
   * 与 sync 的差别只有两点：
   *   1. 入队前多一道目录非空校验（缺失/为空 → empty_dir，不入队）
   *   2. 入队时带 `{ fromLocalDir: true }`，runBuild 据此换 localWorker
   *
   * 用途：① 目录内容已就位、只想重建索引；② 把 failed 的资源修复为 ready
   * （成功分支无条件写 ready + 清 sync_error，对原状态无要求，见设计文档 §3.3）。
   */
  build(serviceId: string, teamId: string, codeGraphId: string, requesterUserId?: string): BuildResult {
    const row = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (!row) return { kind: "not_found" };
    // 并发拒绝：与 sync 同口径。
    if (row.status === "pending" || row.status === "processing") {
      return { kind: "busy", status: row.status, step: row.internal_status };
    }
    // 目录校验前置：不存在/为空直接返回，避免入队后必然 failed 的难排查结果。
    if (!this.isNonEmptyDir(this.dirFor(serviceId, teamId, codeGraphId))) {
      return { kind: "empty_dir" };
    }
    const nextVersion = row.version + 1;
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
      status: "pending",
      internal_status: null,
      sync_error: null,
      version: nextVersion,
    });
    this.audit({ ...row, version: nextVersion }, "ingest", "build from local dir", requesterUserId);
    const fresh = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (fresh) this.enqueueBuild(fresh, { fromLocalDir: true });
    return fresh ? { kind: "ok", row: fresh } : { kind: "not_found" };
  }

  /** 目录存在且非空（用于 build 的前置校验）。 */
  private isNonEmptyDir(dir: string): boolean {
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
      return readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  }

  get(serviceId: string, teamId: string, codeGraphId: string): CodeGraphRow | null {
    return this.store.getCodeGraph(serviceId, teamId, codeGraphId);
  }

  /** Look up by globally unique code_graph_id (still scoped by service_id to prevent cross-tenant access). For spec id-only endpoints. */
  getById(serviceId: string, codeGraphId: string): CodeGraphRow | null {
    return this.store.getCodeGraphById(serviceId, codeGraphId);
  }

  list(serviceId: string, teamId: string, opts?: ListOpts): CodeGraphRow[] {
    return this.store.listCodeGraphs(serviceId, teamId, opts);
  }

  count(serviceId: string, teamId: string, opts?: CountOpts): number {
    return this.store.countCodeGraphs(serviceId, teamId, opts);
  }

  /**
   * Delete a code-graph (008 / 007 §5.5). Deletable in any state (including pending/processing).
   * memory/team mismatch returns false; otherwise hard delete + cleanup of four resource kinds, returns true.
   *
   * If the resource is queued/executing (pending/processing), first set the cancelled flag to tell the worker
   * to abort at a checkpoint; then immediately hard delete + clean up (without waiting for the worker). When the worker re-checks before finishing and finds
   * it deleted, it skips ready/callback and does another idempotent cleanup, leaving nothing behind.
   */
  delete(serviceId: string, teamId: string, codeGraphId: string): boolean {
    const row = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (!row) return false;

    // Tell the in-flight worker to abort (pending in queue or processing in progress).
    if (row.status === "pending" || row.status === "processing") {
      this.cancelled.add(codeGraphId);
    }

    this.audit(row, "delete", null);
    this.cleanupResources(serviceId, teamId, codeGraphId);

    // If the worker is still running, it sees at a checkpoint that the row was hard-deleted (getById → null) and aborts;
    // the cancelled flag is left for the worker to clear when it finishes (see runBuild), so it's not removed here,
    // to cover the window where "delete completes before the worker checkpoint". cleanup is idempotent; repeats are harmless.
    return true;
  }

  /**
   * Idempotent cleanup of four resource kinds (order: release memory/connections first, then delete from disk).
   * Each step has its own try/catch — a failure in any step doesn't affect the others, ensuring exception safety.
   *   1. instance pool (memory): releaseInstance (pool.delete + closeIndex)
   *   2. metadata row: hard delete (safe even if 0 rows match; supports double cleanup by worker + delete)
   *   3. disk directory: rmSync recursive+force (idempotent)
   * Queued BuildQueue tasks are skipped by the runBuild entry check on cancelled/row existence, so nothing to do here.
   */
  private cleanupResources(serviceId: string, teamId: string, codeGraphId: string): void {
    try {
      this.releaseInstance?.(codeGraphId);
    } catch (err) {
      this.logger?.warn?.(`[code-graph] release instance failed ${codeGraphId}: ${String(err)}`);
    }
    try {
      this.store.deleteCodeGraph(serviceId, teamId, codeGraphId);
    } catch (err) {
      this.logger?.warn?.(`[code-graph] hard-delete row failed ${codeGraphId}: ${String(err)}`);
    }
    try {
      rmSync(this.dirFor(serviceId, teamId, codeGraphId), { recursive: true, force: true });
    } catch (err) {
      this.logger?.warn?.(`[code-graph] rm dir failed ${codeGraphId}: ${String(err)}`);
    }
  }

  /**
   * Worker checkpoint: whether the resource has been deleted (cancelled flag set, or row no longer in the DB).
   * Two criteria cover: ① delete happened while the worker was running (cancelled); ② delete already completed
   * and the row was hard-deleted (getById → null). Either one counts as deleted.
   */
  private isDeleted(serviceId: string, codeGraphId: string): boolean {
    return this.cancelled.has(codeGraphId) || this.store.getCodeGraphById(serviceId, codeGraphId) === null;
  }

  /** Write a code-graph audit record. Failures don't block the main flow. */
  private audit(row: CodeGraphRow, action: AuditAction, detail: string | null, requesterUserId?: string): void {
    try {
      this.store.appendCodeGraphAudit({
        service_id: row.service_id,
        asset_id: row.code_graph_id,
        version: row.version,
        action,
        // Prefer recording the requester (initiator of sync/create), falling back to the row's creator.
        user_id: requesterUserId ?? row.user_id,
        agent_id: row.agent_id,
        detail,
      });
    } catch (err) {
      this.logger?.warn?.(`[code-graph] audit ${action} failed: ${String(err)}`);
    }
  }

  private enqueueBuild(row: CodeGraphRow, opts?: BuildOptions): void {
    this.queue.enqueue(row.code_graph_id, () =>
      this.runBuild(
        row.service_id,
        row.code_graph_id,
        row.team_id,
        row.repo_url,
        row.branch,
        row.owner_user_id ?? row.user_id ?? undefined,
        opts,
      ),
    );
  }

  private async runBuild(
    serviceId: string,
    codeGraphId: string,
    teamId: string,
    repoUrl: string,
    branch: string,
    ownerUserId?: string,
    opts?: BuildOptions,
  ): Promise<void> {
    // Entry checkpoint: deleted while pending → skip directly; don't set processing, don't build.
    if (this.isDeleted(serviceId, codeGraphId)) {
      this.finishCancelled(serviceId, teamId, codeGraphId);
      return;
    }
    // 本地构建没有 clone 步骤，写 "cloning" 会误导（前端/运维据此判断卡在哪一步）。
    const fromLocalDir = opts?.fromLocalDir === true;
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
      status: "processing",
      internal_status: fromLocalDir ? "indexing" : "cloning",
      sync_error: null,
    });
    // 本地构建换 worker；未注入 localWorker 时退化到常规 worker（保守：宁可走原路径也不静默跳过）。
    const worker = fromLocalDir ? (this.localWorker ?? this.worker) : this.worker;
    try {
      const result = await worker({
        codeGraphId,
        serviceId,
        teamId,
        repoUrl,
        branch,
        dir: this.dirFor(serviceId, teamId, codeGraphId),
        setInternalStatus: (s) =>
          this.store.updateCodeGraphStatus(serviceId, codeGraphId, { status: "processing", internal_status: s }),
        ownerUserId,
      });
      // Pre-finish checkpoint: deleted during processing → skip ready/audit/callback and do idempotent final cleanup.
      if (this.isDeleted(serviceId, codeGraphId)) {
        this.finishCancelled(serviceId, teamId, codeGraphId);
        return;
      }
      this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
        status: "ready",
        internal_status: null,
        sync_error: null,
        commit_hash: result.commitHash ?? null,
        stats_json: result.stats ? JSON.stringify(result.stats) : null,
        last_sync_at: new Date().toISOString(),
      });
      const synced = this.store.getCodeGraphById(serviceId, codeGraphId);
      if (synced) {
        this.audit(synced, "ready", result.stats ? JSON.stringify(result.stats) : null);
      }
      this.logger?.info?.(`[code-graph] ${codeGraphId} ready`);

      // Auto-generate summary + callback TMC
      await this.onBuildComplete(synced, "ready", null, result.stats ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The worker threw, but if it was deleted in the meantime, treat it as cancelled rather than failed: skip failed status/callback and clean up.
      if (this.isDeleted(serviceId, codeGraphId)) {
        this.finishCancelled(serviceId, teamId, codeGraphId);
        return;
      }
      this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
        status: "failed",
        internal_status: null,
        sync_error: msg.slice(0, 500),
      });
      const failed = this.store.getCodeGraphById(serviceId, codeGraphId);
      if (failed) this.audit(failed, "failed", msg.slice(0, 500));
      this.logger?.warn?.(`[code-graph] ${codeGraphId} failed: ${msg}`);

      // Callback TMC about failure
      await this.onBuildComplete(failed, "failed", msg, null);
    }
  }

  /**
   * Wrap-up after a worker checkpoint determines "deleted": idempotently clean up disk/handles the worker may have just written,
   * and remove the cancelled flag (the worker for this id ends here, so the flag has served its purpose).
   */
  private finishCancelled(serviceId: string, teamId: string, codeGraphId: string): void {
    this.cleanupResources(serviceId, teamId, codeGraphId);
    this.cancelled.delete(codeGraphId);
    this.logger?.info?.(`[code-graph] ${codeGraphId} build aborted (deleted during processing)`);
  }

  /**
   * Post-build hook: generate summary (if synced) and callback TMC.
   * Never throws — runs after the main build is already committed.
   */
  private async onBuildComplete(
    row: CodeGraphRow | null,
    status: "ready" | "failed",
    errorMsg: string | null,
    stats: { files: number; nodes: number; edges: number } | null,
  ): Promise<void> {
    if (!row || !this.callbackConfig) return;

    let summary: string | null = null;

    if (status === "ready") {
      // Generate summary via template (no LLM for code-graph)
      const { generateCodeGraphSummary } = await import("../callback.js");
      summary = generateCodeGraphSummary(row.repo_name || row.repo_url, row.branch, stats);
      if (summary) {
        this.store.updateCodeGraphStatus(row.service_id, row.code_graph_id, { summary });
      }
    }

    // Callback TMC
    const { callbackTMC } = await import("../callback.js");
    await callbackTMC(
      {
        knowledge_id: row.code_graph_id,
        service_id: row.service_id,
        type: "code-graph",
        status,
        summary,
        sync_error: errorMsg?.slice(0, 500) ?? null,
        timestamp: new Date().toISOString(),
      },
      this.callbackConfig,
    );
  }

  /** Wait for background tasks to finish (tests / shutdown). */
  async onIdle(codeGraphId?: string): Promise<void> {
    await this.queue.onIdle(codeGraphId);
  }
}
