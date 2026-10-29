/**
 * Knowledge Panel API client (v1.0 frozen)
 *
 * Reference doc: docs/api/knowledge-panel-api.md
 * Prefix: `/api/v1/knowledge`, all POST, unified envelope { code, message, request_id, data }
 * Auth: `X-Tdai-Service-Id` + `X-Tdai-User-Key` (same as the meta API)
 *
 * Integrated in this phase (§2.0 minimal endpoint set):
 *   Wiki: list / create / ingest / get / delete / graph / page/ls / page/read /
 *         search / raw/ls / raw/read / raw/write (12 endpoints)
 *   Code-Graph: list / create / sync / delete / search / explore (6 endpoints)
 */

import { getPanelSession } from '../panelSession';
import { formatApiErrorMessage } from '../error-message';
import i18n from '@/i18n';

const BASE = '/api/v1/knowledge';

// ========================= Envelope =========================

interface Envelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

export class KnowledgeApiError extends Error {
  code: number;
  requestId: string;
  rawMessage: string;

  constructor(code: number, message: string, requestId: string) {
    super(formatApiErrorMessage({ code, message, requestId }));
    this.name = 'KnowledgeApiError';
    this.code = code;
    this.requestId = requestId;
    this.rawMessage = message;
  }
}

// ========================= Base Request =========================

async function panelPost<T>(path: string, body?: unknown): Promise<T> {
  const session = getPanelSession();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) {
    headers['X-Tdai-Service-Id'] = session.instanceId;
    headers['X-Tdai-User-Key'] = session.userKey;
  }
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let env: Envelope<T>;
  try {
    env = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new KnowledgeApiError(res.status || 500, text || res.statusText || 'Knowledge request failed', '');
  }
  if (!res.ok || env.code !== 0) {
    throw new KnowledgeApiError(env.code ?? res.status, env.message || res.statusText, env.request_id);
  }
  return env.data;
}

// ========================= Types (Panel API) =========================

export interface ImportAndIngestResult {
  ok: boolean;
  wiki_id: string;
  /** Returned on success */
  ingest_task_id?: string;
  status?: string;
  /** true = cancelled the old task and queued a new one */
  queued?: boolean;
  /** Returned on failure */
  failed_at?: 'write' | 'ingest';
  error_code?: string;
  error_message?: string;
  raw_persisted?: boolean;
}

export interface WikiDetail {
  wiki_id: string;
  team_id: string;
  name: string;
  /** null = manual upload; 'iwiki' etc. = external source (the detail page uses this to switch between "Add files" and "Pull from external"). */
  source_type: string | null;
  /** External source URL; only set when source_type is non-null. */
  source_url: string | null;
  service_url: string | null;
  summary: string | null;
  status: 'draft' | 'pending' | 'processing' | 'ready' | 'failed' | 'missing';
  internal_status?: string | null;
  sync_error: string | null;
  version: string;
  owner_user_id: string | null;
  page_count: number | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CodeGraphDetail {
  code_graph_id: string;
  team_id: string;
  repo_name: string;
  repo_url: string;
  branch: string;
  commit_hash: string | null;
  service_url: string | null;
  summary: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed' | 'missing';
  sync_error: string | null;
  version: string;
  owner_user_id: string | null;
  stats: { files: number; nodes: number; edges: number } | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A single file-format entry that KS sends to the front end (the **wire contract**, projected by `toWireFormats()`).
 *
 * Field compatibility policy:
 * - Keep `converter` / `note`: the old contract declared them, so they stay for backward compatibility (the front end
 *   does not read them, but they are not removed, so external integrations never see undefined)
 * - Drop `htmlPostProcessor` / `markdownPostProcessor` / `nonHtmlPassthrough`: these are KS internals that the old
 *   contract never declared and that only leaked by accident through a spread
 */
export interface WikiFileFormat {
  ext: string;
  sizeTier: 'text' | 'binary';
  /** Per-file size limit in bytes. Optional: a degraded snapshot may not have it. */
  maxBytes?: number;
  preview: 'native' | 'client' | 'converted' | 'markdown';
  converter: 'officeparser' | 'passthrough' | 'none';
  note?: string;
}

// ---- Legacy-compatible types (smooth transition) ----

/** @deprecated Use WikiDetail instead */
export interface WikiSource {
  wiki_id?: string;
  name: string;
  status: string;
  pageCount?: number;
  lastSync?: string;
  error?: string;
  agent_id?: string;
}

// ── External sources (Gongfeng / GitHub / GitLab) ──
// The source of truth for the source list and credential storage is KS; the frontend only gets metadata and never receives plaintext tokens.

export interface SourceProviderFormField {
  name: string;
  secret: boolean;
  required: boolean;
}

export interface SourceProviderMeta {
  id: string;
  /**
   * Auth method type (bearer / basic / ssh-key).
   * For `ssh-key`, form_fields is an empty array — the frontend renders no input fields
   * and switches to the "get and configure SSH public key" flow instead.
   */
  auth_method: 'bearer' | 'basic' | 'ssh-key';
  /** Form field list: the frontend renders dynamically from this. */
  form_fields: readonly SourceProviderFormField[];
  token_doc_url?: string | null;
}

/** SSH key info (the server only returns the public key; the private key never leaves the server). */
export interface SshKeyInfo {
  public_key: string;
  /** true = newly generated this time; false = reused an existing key. */
  created: boolean;
  username: string;
}

/** Remote wiki node (flat, including directory nodes). */
export interface WikiRemotePageRef {
  externalId: string;
  title: string;
  path: string;
  parentId?: string | null;
  isDir?: boolean;
  version?: string;
  updatedAt?: string;
}

export interface WikiResolvedRoot {
  rootType: 'dir' | 'doc';
  rootId: string;
  displayName: string;
  estimatedCount?: number;
}

/**
 * Crawl strategy: decides how documents are discovered starting from the import root.
 * - tree: expands child docs via the platform's hierarchy API (complete structure, slower for large spaces)
 * - links: discovers docs by parsing hyperlinks in the body (faster, only covers linked pages)
 */
export interface WikiCrawlOptions {
  mode?: 'tree' | 'links';
  /** Max crawl depth, only meaningful for links; 1 = only docs directly linked from the entry page. */
  maxDepth?: number;
}

export interface WikiSourceListResult {
  root: WikiResolvedRoot;
  pages: WikiRemotePageRef[];
  importable: number;
}

export interface WikiSourceImportResult {
  imported: number;
  skippedDirs: number;
  failed: Array<{ id: string; error: string }>;
  warnings: string[];
}

export interface SourceCredentialStatus {
  resource_type: 'code-graph' | 'wiki';
  resource_id: string;
  provider_id: string;
  cred_kind: string;
  last_verified_at: string | null;
  updated_at: string;
}

export type SourceResourceType = SourceCredentialStatus['resource_type'];

/** @deprecated Use CodeGraphDetail instead */
export interface CodeSource {
  code_graph_id?: string;
  repo: string;
  branch: string;
  repo_url?: string;
  repo_name?: string;
  gitUrl?: string;
  status: string;
  commit?: string;
  stats?: { files: number; nodes: number; edges: number };
  lastSyncAt?: string;
  error?: string;
  sync_error?: string;
  agent_id?: string;
}

/**
 * Triggers async ingest after importing into the knowledge base. Old code expected an SSE progress stream => the new Panel has no SSE,
 * so the frontend does: trigger ingest → poll get for status. The callback signature only exists for the old UI's progress bar.
 */
export interface IngestProgressEvent {
  type: 'file_start' | 'file_done' | 'file_error' | 'batch_done';
  file?: string;
  detail?: string;
  done?: number;
  total?: number;
  error?: string;
  ts: number;
}

export interface IngestStreamCallbacks {
  onProgress?: (event: IngestProgressEvent) => void;
  onComplete?: (result: { total: number; ingested: number }) => void;
  onError?: (error: string) => void;
}

// Graph types (compatible with the old version)
export interface GraphNode { id: string; label: string; type: string; path: string; linkCount: number; community: number; }
export interface GraphEdge { source: string; target: string; weight: number; }
export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; communities?: { id: number; nodeCount: number; topNodes: string[] }[]; }

export interface WikiPage { path: string; title: string; type: string; tags?: string[]; created?: string; updated?: string; }

/** List item after meta + KS join (team-assets) */
export interface KnowledgeAssetItem {
  knowledge_id: string;
  asset_type: string;
  name: string;
  description?: string | null;
  visibility: string;
  owner_user_id: string;
  meta_status: string;
  status: string;
  internal_status?: string | null;
  sync_error?: string | null;
  ks_missing?: boolean;
  team_id?: string;
  summary?: string | null;
  page_count?: number | null;
  last_sync_at?: string | null;
  /** Wiki only: null = manual upload, 'iwiki' etc. = external source. */
  source_type?: string | null;
  /** Wiki only: external source URL. */
  source_url?: string | null;
  repo_name?: string;
  repo_url?: string;
  branch?: string;
  commit_hash?: string | null;
  stats?: { files: number; nodes: number; edges: number } | null;
  created_at?: string;
  updated_at?: string;
}

function assetItemToWiki(item: KnowledgeAssetItem): WikiDetail {
  return {
    wiki_id: item.knowledge_id,
    team_id: item.team_id ?? '',
    name: item.name,
    source_type: item.source_type ?? null,
    source_url: item.source_url ?? null,
    service_url: null,
    summary: item.summary ?? null,
    status: (item.status as WikiDetail['status']) || 'draft',
    internal_status: item.internal_status ?? null,
    sync_error: item.sync_error ?? null,
    version: '1',
    owner_user_id: item.owner_user_id,
    page_count: item.page_count ?? null,
    last_sync_at: item.last_sync_at ?? null,
    created_at: item.created_at ?? '',
    updated_at: item.updated_at ?? '',
  };
}

function assetItemToCode(item: KnowledgeAssetItem): CodeGraphDetail {
  return {
    code_graph_id: item.knowledge_id,
    team_id: item.team_id ?? '',
    repo_name: item.repo_name ?? item.name,
    repo_url: item.repo_url ?? '',
    branch: item.branch ?? 'main',
    commit_hash: item.commit_hash ?? null,
    service_url: null,
    summary: item.summary ?? null,
    status: (item.status as CodeGraphDetail['status']) || 'pending',
    sync_error: item.sync_error ?? null,
    version: '1',
    owner_user_id: item.owner_user_id,
    stats: item.stats ?? null,
    last_sync_at: item.last_sync_at ?? null,
    created_at: item.created_at ?? '',
    updated_at: item.updated_at ?? '',
  };
}

async function listTeamAssets(path: string, teamId: string): Promise<KnowledgeAssetItem[]> {
  const d = await panelPost<{ items: KnowledgeAssetItem[]; total: number }>(path, { team_id: teamId });
  return d.items ?? [];
}

export interface KnowledgeFixedItem {
  knowledge_id: string;
  asset_type: 'llm_wiki' | 'code_graph';
  name: string;
  description?: string | null;
  status: string;
  visibility: string;
  agent_id: string;
}

async function allocateKnowledge(teamId: string, knowledgeId: string, agentId: string): Promise<void> {
  await panelPost('/allocate', { team_id: teamId, knowledge_id: knowledgeId, agent_id: agentId });
}

async function unbindKnowledge(knowledgeId: string, agentId: string): Promise<void> {
  await panelPost('/unbind', { knowledge_id: knowledgeId, agent_id: agentId });
}

async function listAgentFixedKnowledge(agentId: string): Promise<KnowledgeFixedItem[]> {
  const d = await panelPost<{ items: KnowledgeFixedItem[]; total: number }>('/agent-fixed', { agent_id: agentId });
  return d.items ?? [];
}

// ========================= Wiki API =========================

export function wikiStageLabel(status: WikiDetail['status'], internalStatus?: string | null): string {
  if (status === 'missing') return i18n.t('wiki.status.missing');
  if (status === 'pending') return i18n.t('wiki.status.pending');
  if (status === 'ready') return i18n.t('wiki.status.ready');
  if (status === 'failed') return i18n.t('wiki.status.failed');
  if (status === 'draft') return i18n.t('wiki.status.draft');
  const map: Record<string, string> = {
    scanning: i18n.t('knowledgeApi.stage.scanning'),
    ingesting: i18n.t('knowledgeApi.stage.ingesting'),
    'rebuilding-index': i18n.t('knowledgeApi.stage.rebuildingIndex'),
  };
  return internalStatus ? (map[internalStatus] ?? internalStatus) : i18n.t('knowledgeApi.stage.processing');
}

export function wikiProgressPercent(status: WikiDetail['status'], internalStatus?: string | null): number {
  if (status === 'ready') return 100;
  if (status === 'failed') return 100;
  if (status === 'missing') return 100;
  if (status === 'pending') return 5;
  if (status === 'processing') {
    if (internalStatus === 'scanning') return 20;
    if (internalStatus === 'ingesting') return 60;
    if (internalStatus === 'rebuilding-index') return 85;
    return 40;
  }
  return 0;
}

export const knowledgeApi = {
  health: () => panelPost<Record<string, unknown>>('/health').catch(() => ({ ok: true })),

  /** Read all Knowledge fixed assets (wiki + code_graph) bound to an Agent. */
  agentFixed: (agentId: string): Promise<KnowledgeFixedItem[]> => listAgentFixedKnowledge(agentId),

  // ---- Wiki ----

  wiki: {
    /**
     * Create a wiki. Returns WikiDetail (including wiki_id).
     * External sources (iWiki etc.) must pass sourceType + sourceUrl **together**;
     * source_type is persisted, and the detail page uses it to decide between "Upload files" and "Pull from external".
     */
    create: (
      teamId: string,
      name: string,
      sourceUrl?: string,
      sourceType?: string,
    ): Promise<WikiDetail> =>
      panelPost('/wiki/create', {
        team_id: teamId,
        name,
        ...(sourceUrl && sourceType ? { source_url: sourceUrl, source_type: sourceType } : {}),
      }),

    /** @deprecated Use teamAssets */
    list: async (teamId: string): Promise<WikiDetail[]> => {
      const d = await panelPost<{ items: WikiDetail[]; total: number }>('/wiki/list', { team_id: teamId });
      return d.items ?? [];
    },

    /** Team Wiki pool (meta list-accessible visibility=team + KS join) */
    teamAssets: async (teamId: string): Promise<WikiDetail[]> => {
      const items = await listTeamAssets('/wiki/team-assets', teamId);
      return items.map(assetItemToWiki);
    },

    /** Get details (including status, for polling after ingest) */
    get: (wikiId: string): Promise<WikiDetail> =>
      panelPost('/wiki/get', { wiki_id: wikiId }),

    /** Trigger async ingest (poll get for status afterwards) */
    ingest: (wikiId: string): Promise<void> =>
      panelPost('/wiki/ingest', { wiki_id: wikiId }),

    /** After triggering ingest, poll wiki/get and drive the progress display with the real status/internal_status. */
    ingestWithPolling: async (wikiId: string, callbacks: IngestStreamCallbacks, _teamId: string): Promise<void> => {
      try {
        callbacks.onProgress?.({ type: 'file_start', detail: i18n.t('knowledgeApi.ingest.triggering'), done: 0, total: 100, ts: Date.now() });
        try {
          await knowledgeApi.wiki.ingest(wikiId);
        } catch (err: unknown) {
          // If already pending/processing, KS returns 409 busy; the frontend keeps polling the existing task.
          if (!(err instanceof KnowledgeApiError && err.code === 409)) throw err;
        }

        const maxAttempts = 300; // About 10 minutes max; each attempt actually queries wiki/get.
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          await new Promise(r => setTimeout(r, attempt === 1 ? 800 : 2000));
          const detail = await knowledgeApi.wiki.get(wikiId);
          const stage = wikiStageLabel(detail.status, detail.internal_status);
          const done = wikiProgressPercent(detail.status, detail.internal_status);
          const pageHint = typeof detail.page_count === 'number' ? i18n.t('knowledgeApi.ingest.currentPage', { count: detail.page_count }) : '';
          callbacks.onProgress?.({
            type: 'file_done',
            detail: i18n.t('knowledgeApi.ingest.check', { attempt, stage, pageHint }),
            done,
            total: 100,
            ts: Date.now(),
          });

          if (detail.status === 'ready') {
            callbacks.onProgress?.({ type: 'batch_done', detail: i18n.t('knowledgeApi.ingest.complete'), done: 100, total: 100, ts: Date.now() });
            const count = detail.page_count ?? 0;
            callbacks.onComplete?.({ total: count, ingested: count });
            return;
          }
          if (detail.status === 'failed') {
            callbacks.onError?.(detail.sync_error || i18n.t('knowledgeApi.ingest.failed'));
            return;
          }
        }
        callbacks.onError?.(i18n.t('knowledgeApi.ingest.timeout'));
      } catch (err: unknown) {
        callbacks.onError?.(err instanceof Error ? err.message : String(err));
      }
    },

    /**
     * Import and extract (merged entry point, design 2026-09-21).
     *
     * Done in one request: write raw (optional) → trigger ingest. KS uses onBusy:'replace'
     * to atomically "cancel the old task + queue a new one"; the frontend needn't be aware or retry.
     *
     * mode maps to the Modal's three tabs: files | markdown | external | reingest.
     */
    importAndIngest: (params: {
      wiki_id: string;
      mode: 'files' | 'markdown' | 'external' | 'reingest';
      // encoding is passed through to Knowledge: base64 by default, and a hand-pasted MD must say 'utf8' explicitly.
      files?: { filename: string; content: string; encoding?: 'utf8' | 'base64' }[];
      markdown?: { filename: string; content: string; encoding?: 'utf8' | 'base64' }[];
      source_url?: string;
      provider_id?: string;
      page_ids?: string[];
    }): Promise<ImportAndIngestResult> =>
      panelPost('/wiki/import-and-ingest', params),

    /** Delete */
    delete: (wikiId: string): Promise<void> =>
      panelPost('/wiki/delete', { wiki_ids: [wikiId] }),

    /** Graph */
    graph: (wikiId: string): Promise<GraphData> =>
      panelPost('/wiki/graph', { wiki_id: wikiId }),

    /** Page list */
    pages: async (wikiId: string): Promise<WikiPage[]> => {
      const d = await panelPost<{ items: WikiPage[] }>('/wiki/page/ls', { wiki_id: wikiId });
      return d.items ?? [];
    },

    /** Read a page (including raw/sources/...) */
    read: async (wikiId: string, path: string): Promise<{ content: string }> => {
      const d = await panelPost<{ items: Array<{ ref: string; content?: string; not_found?: boolean }> }>(
        '/wiki/page/read', { wiki_id: wikiId, refs: [path] }
      );
      const item = d.items?.[0];
      if (item?.not_found) throw new Error(i18n.t('knowledgeApi.pageNotFound', { path }));
      return { content: item?.content ?? '' };
    },

    /** Delete a processed wiki page */
    pageDelete: (wikiId: string, refs: string[]): Promise<void> =>
      panelPost('/wiki/page/rm', { wiki_id: wikiId, refs }),

    /** Full-text search */
    search: (wikiId: string, query: string, limit?: number): Promise<{
      results: Array<{ path: string; title: string; snippet: string; score: number; type: string }>;
    }> =>
      panelPost('/wiki/search', { wiki_id: wikiId, query, limit: limit ?? 20 }),

    /** Raw file list */
    rawList: async (wikiId: string): Promise<{ files: Array<{ filename: string; size: number }> }> => {
      const d = await panelPost<{ items: Array<{ filename: string; size: number }> }>(
        '/wiki/raw/ls', { wiki_id: wikiId }
      );
      return { files: d.items ?? [] };
    },

    /**
     * Read a raw file (for previews).
     *
     * The backend's `preview_format` tells the form: `native`/`client` return the original bytes as base64, `html`
     * returns the converted HTML, and `markdown` returns the original text. When a conversion fails the item carries
     * only `preview_error` and no content.
     */
    rawRead: (wikiId: string, filenames: string[]): Promise<{ items: Array<{ filename: string; content?: string; not_found?: boolean; binary?: boolean; converterId?: string; preview_error?: string; preview_format?: 'native' | 'client' | 'html' | 'markdown' }> }> =>
      panelPost('/wiki/raw/read', { wiki_id: wikiId, filenames }),

    /** Delete a raw source document */
    rawDelete: (wikiId: string, filenames: string[]): Promise<void> =>
      panelPost('/wiki/raw/rm', { wiki_id: wikiId, filenames }),

    /**
     * Fetch the format registry (the wire contract of KS's `toWireFormats()`).
     * The front end's allowlist, upload channel, accept attribute and size checks are all derived from it.
     */
    formats: (): Promise<{ items: WikiFileFormat[] }> =>
      panelPost('/wiki/formats', {}),

    /**
     * Upload a raw file.
     *
     * - `encoding='base64'`: the original bytes read from a File go as base64 (docx/pdf/md/txt etc.)
     * - omitted: for plain text such as a hand-pasted MD, `content` is written to disk as UTF-8 directly
     */
    upload: (opts: { teamId: string; wikiId: string; filename: string; content: string; encoding?: 'utf8' | 'base64' }): Promise<void> =>
      panelPost('/wiki/raw/write', { team_id: opts.teamId, wiki_id: opts.wikiId, files: [{ filename: opts.filename, content: opts.content, encoding: opts.encoding }] }),

    allocate: (teamId: string, wikiId: string, agentId: string): Promise<void> =>
      allocateKnowledge(teamId, wikiId, agentId),

    unbind: (wikiId: string, agentId: string): Promise<void> =>
      unbindKnowledge(wikiId, agentId),

    agentFixed: async (agentId: string): Promise<KnowledgeFixedItem[]> => {
      const items = await listAgentFixedKnowledge(agentId);
      return items.filter((it) => it.asset_type === 'llm_wiki');
    },
  },

  // ---- Code-Graph ----

  code: {
    /** Create (register a repo). For private repos pass providerId + secret (+ username) together; KS stores the credentials before enqueueing. */
    create: (opts: {
      teamId: string;
      repoUrl: string;
      branch?: string;
      repoName?: string;
      providerId?: string;
      secret?: string;
      username?: string;
    }): Promise<CodeGraphDetail> =>
      panelPost('/code-graph/create', {
        team_id: opts.teamId,
        repo_url: opts.repoUrl,
        branch: opts.branch ?? 'main',
        repo_name: opts.repoName,
        ...(opts.providerId && opts.secret
          ? {
              provider_id: opts.providerId,
              secret: opts.secret,
              ...(opts.username ? { username: opts.username } : {}),
            }
          : {}),
      }),

    /** @deprecated Use teamAssets */
    list: async (teamId: string): Promise<CodeGraphDetail[]> => {
      const d = await panelPost<{ items: CodeGraphDetail[]; total: number }>('/code-graph/list', { team_id: teamId });
      return d.items ?? [];
    },

    /** Team Code pool */
    teamAssets: async (teamId: string): Promise<CodeGraphDetail[]> => {
      const items = await listTeamAssets('/code-graph/team-assets', teamId);
      return items.map(assetItemToCode);
    },

    /** Register meta once code is ready (create does not write meta) */
    registerMeta: (teamId: string, codeGraphId: string): Promise<void> =>
      panelPost('/code-graph/register-meta', { team_id: teamId, code_graph_id: codeGraphId }),

    /** Trigger sync (async; poll get as with ingest) */
    sync: (codeGraphId: string): Promise<void> =>
      panelPost('/code-graph/sync', { code_graph_id: codeGraphId }),

    /** Delete */
    delete: (codeGraphId: string): Promise<void> =>
      panelPost('/code-graph/delete', { code_graph_ids: [codeGraphId] }),

    /** Code search (returns { text, isError } text blocks) */
    search: (opts: { codeGraphId: string; query: string; kind?: string; limit?: number }): Promise<{ text: string; isError: boolean }> =>
      panelPost('/code-graph/search', { code_graph_id: opts.codeGraphId, query: opts.query, ...(opts.kind && opts.kind !== 'any' ? { kind: opts.kind } : {}), limit: opts.limit ?? 10 }),

    /** Code explore (returns { text, isError } text blocks) */
    explore: (codeGraphId: string, query: string): Promise<{ text: string; isError: boolean }> =>
      panelPost('/code-graph/explore', { code_graph_id: codeGraphId, query }),

    /** Details (for polling after sync) */
    get: (codeGraphId: string): Promise<CodeGraphDetail> =>
      panelPost('/code-graph/get', { code_graph_id: codeGraphId }),

    /**
     * SSH 公钥：取（必要时生成）。用户身份由后端从会话取，前端不传 user_id。
     * 注意顺序：注册 SSH 仓库前先调它拿到公钥 → 用户去平台配置 → 再调 create。
     */
    sshKeyEnsure: (teamId: string): Promise<SshKeyInfo> =>
      panelPost('/code-graph/ssh-key/ensure', { team_id: teamId }),

    /** SSH 公钥：只读取回已存在的（不生成）。未生成时后端返回错误。 */
    sshKeyGet: (teamId: string): Promise<SshKeyInfo> =>
      panelPost('/code-graph/ssh-key/get', { team_id: teamId }),

    allocate: (teamId: string, codeGraphId: string, agentId: string): Promise<void> =>
      allocateKnowledge(teamId, codeGraphId, agentId),

    unbind: (codeGraphId: string, agentId: string): Promise<void> =>
      unbindKnowledge(codeGraphId, agentId),

    agentFixed: async (agentId: string): Promise<KnowledgeFixedItem[]> => {
      const items = await listAgentFixedKnowledge(agentId);
      return items.filter((it) => it.asset_type === 'code_graph');
    },
  },

  // ---- External sources (Gongfeng / GitHub / GitLab) ----
  // Credentials are attached to the **resource** (resource_type + resource_id), not to a person; there is no longer a global list endpoint.
  source: {
    /** Enabled codegraph sources (data source for the registration form dropdown). */
    providers: (teamId: string): Promise<SourceProviderMeta[]> =>
      panelPost<{ items: SourceProviderMeta[] }>('/source/providers', { team_id: teamId })
        .then((d) => d.items ?? []),

    /** Enabled wiki sources (data source for the registration form dropdown). */
    wikiProviders: (teamId: string): Promise<SourceProviderMeta[]> =>
      panelPost<{ items: SourceProviderMeta[] }>('/source/wiki-providers', { team_id: teamId })
        .then((d) => d.items ?? []),

    /** List remote docs (resolveRoot + listPages). Omitting crawl → use the provider's default strategy. */
    wikiList: (opts: {
      teamId: string;
      wikiId: string;
      sourceUrl: string;
      providerId: string;
      crawl?: WikiCrawlOptions;
    }): Promise<WikiSourceListResult> =>
      panelPost<WikiSourceListResult>('/source/wiki/list', {
        team_id: opts.teamId,
        wiki_id: opts.wikiId,
        source_url: opts.sourceUrl,
        provider_id: opts.providerId,
        ...(opts.crawl ? { crawl: opts.crawl } : {}),
      }),

    /** Import remote docs (fetch + write to disk, does not trigger ingest). */
    wikiImport: (opts: {
      teamId: string;
      wikiId: string;
      sourceUrl: string;
      providerId: string;
      pageIds?: string[];
    }): Promise<WikiSourceImportResult> =>
      panelPost<WikiSourceImportResult>('/source/wiki/import', {
        team_id: opts.teamId,
        wiki_id: opts.wikiId,
        source_url: opts.sourceUrl,
        provider_id: opts.providerId,
        ...(opts.pageIds ? { page_ids: opts.pageIds } : {}),
      }),

    /** Credential status of a resource (metadata only, no plaintext). Returns null if not configured. */
    credentialStatus: (opts: {
      teamId: string;
      resourceType: SourceResourceType;
      resourceId: string;
    }): Promise<SourceCredentialStatus | null> =>
      panelPost<{ configured: boolean; credential: SourceCredentialStatus | null }>(
        '/source/credential/status',
        { team_id: opts.teamId, resource_type: opts.resourceType, resource_id: opts.resourceId },
      ).then((d) => d.credential ?? null),

    /** Write / update a resource's token (plaintext passes through Panel to KS only this once; the frontend keeps nothing). */
    credentialPut: (opts: {
      teamId: string;
      resourceType: SourceResourceType;
      resourceId: string;
      providerId: string;
      credKind: string;
      secret: string;
      username?: string;
    }): Promise<SourceCredentialStatus> =>
      panelPost<{ credential: SourceCredentialStatus }>('/source/credential', {
        team_id: opts.teamId,
        resource_type: opts.resourceType,
        resource_id: opts.resourceId,
        provider_id: opts.providerId,
        cred_kind: opts.credKind,
        secret: opts.secret,
        ...(opts.username ? { username: opts.username } : {}),
      }).then((d) => d.credential),

    /** Delete a resource's token. */
    credentialDelete: (opts: {
      teamId: string;
      resourceType: SourceResourceType;
      resourceId: string;
    }): Promise<void> =>
      panelPost('/source/credential/delete', {
        team_id: opts.teamId,
        resource_type: opts.resourceType,
        resource_id: opts.resourceId,
      }),
  },

  // ---- Connectors (import iwiki / TAPD docs) ----
  connectors: {
    pull: (name: string, params: Record<string, unknown>): Promise<void> =>
      panelPost('/connectors/pull', { name, ...params }),
  },
};

// ========================= Utility functions =========================

/** Poll wiki ingest status until ready/failed */
export async function pollWikiStatus(wikiId: string, maxAttempts = 30, intervalMs = 3000): Promise<WikiDetail> {
  for (let i = 0; i < maxAttempts; i++) {
    const detail = await knowledgeApi.wiki.get(wikiId);
    if (detail.status === 'ready' || detail.status === 'failed') return detail;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(i18n.t('knowledgeApi.wikiIngestTimeout', { wikiId }));
}

/** Poll code-graph sync status */
export async function pollCodeGraphStatus(codeGraphId: string, maxAttempts = 30, intervalMs = 5000): Promise<CodeGraphDetail> {
  for (let i = 0; i < maxAttempts; i++) {
    const detail = await knowledgeApi.code.get(codeGraphId);
    if (detail.status === 'ready' || detail.status === 'failed') return detail;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(i18n.t('knowledgeApi.codeGraphSyncTimeout', { codeGraphId }));
}
