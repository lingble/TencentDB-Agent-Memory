/**
 * useWikiSources - all state and data logic for the Wiki asset page.
 * The component layer only keeps JSX rendering; state / data logic is centralized here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { knowledgeApi, wikiProgressPercent, wikiStageLabel, type GraphData, type WikiDetail, type WikiPage, type SourceProviderMeta, type WikiCrawlOptions, type WikiSourceListResult } from '@/lib/api/knowledge-api';
import { useTeams, useAgents } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea, confirmThenRun } from '@/lib/tea-bridge';
import {
  findExistingRawFilenames,
  formatOverwriteFilenames,
  readUploadFile,
} from '../utils/wiki-upload-utils';
import { maxBytesForFile } from '../utils/wiki-format-store';
import {
  RAW_PREVIEW_ERROR_KEYS,
  type DetailTab,
  type SearchResult,
  type StatusFilter,
  type SubView,
  type ViewMode,
  type WikiScopeTab,
} from '../constants/wiki-constants';

export function useWikiSources() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<WikiDetail[]>([]);
  const [loading, setLoading] = useState(false);
  // Show Agent assets (fixed) by default, so users don't mistakenly think their assets are under "Team assets"
  const [scopeTab, setScopeTab] = useState<WikiScopeTab>('fixed');
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [subView, setSubView] = useState<SubView>('list');
  const [selectedWikiId, setSelectedWikiId] = useState('');

  // Create wiki
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const uploadInFlightRef = useRef(false);

  // Allocate-to-agent
  const [allocateTarget, setAllocateTarget] = useState<{ wiki_id: string; name: string } | null>(
    null,
  );
  const [fixedBoundIds, setFixedBoundIds] = useState<Set<string>>(new Set());
  const { activeTeamId, activeTeam } = useTeams();
  // The "Configurable scope" tab needs the current user's identity; uses the team role check instead.
  const auth = readAuth();
  const currentUser = auth?.user_id ?? '';
  // The fixed-asset tab only lists agents owned by the user (consistent with the ChatMemory / Skills panels,
  // and with the doc §4.2 permission rule: agent-fixed only allows viewing agents owned by the caller).
  // Previously readActiveTeamAgents returned all team agents, letting users see other people's agents.
  const { agents: allAgents } = useAgents(activeTeamId);
  const teamAgents = useMemo(
    () =>
      allAgents
        .filter((a) => a.owner_user_id === currentUser)
        .map((a) => ({ id: a.agent_id, name: a.name })),
    [allAgents, currentUser],
  );
  // The agent_id selected under the fixed tab
  const [agentFilter, setAgentFilter] = useState<string>('');

  // -- External source (iWiki, etc.) registration flow --
  // '' = local upload (no external source, upload files directly)
  const [formSourceType, setFormSourceType] = useState<string>('');
  const [sourceProviders, setSourceProviders] = useState<SourceProviderMeta[]>([]);
  /**
   * Credentials temporarily entered in the dialog (stored dynamically per provider.form_fields);
   * memory only, cleared immediately after submit, never written to localStorage.
   */
  const [formCredential, setFormCredential] = useState<Record<string, string>>({});
  const setCredentialField = (name: string, value: string) =>
    setFormCredential((prev) => ({ ...prev, [name]: value }));

  const [formSourceUrl, setFormSourceUrl] = useState<string>('');
  /**
   * Crawl strategy: tree = traverse child documents, links = traverse hyperlinks in the text.
   * Fixed default 'tree' - the UI does not expose a "follow source" option, so tree is used even without a manual switch,
   * consistent with iWiki's defaultCrawlMode, avoiding "looks unselected but actually uses the provider fallback".
   */
  const [crawlMode, setCrawlMode] = useState<WikiCrawlOptions['mode']>('tree');
  // Max crawl depth for the links strategy: fixed at 1 (only documents directly linked from the entry page); not exposed in the UI.
  const CRAWL_MAX_DEPTH = 1;
  /** Whether this wiki already has credentials stored in KS (decides whether the detail page shows the token entry page). */
  const [credConfigured, setCredConfigured] = useState(false);
  const [savingCred, setSavingCred] = useState(false);
  const [fetchingTree, setFetchingTree] = useState(false);
  const [treeResult, setTreeResult] = useState<WikiSourceListResult | null>(null);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  /** The wiki_id just created in the external source flow (used for both listing the tree and importing). */
  const [pendingWikiId, setPendingWikiId] = useState<string>('');

  /** Fetch enabled wiki sources when opening the create dialog. */
  const openCreate = async () => {
    setShowCreate(true);
    setFormSourceType('');
    setFormCredential({});
    setFormSourceUrl('');
    setTreeResult(null);
    setSelectedPageIds([]);
    if (!activeTeamId) return;
    try {
      const items = await knowledgeApi.source.wikiProviders(activeTeamId);
      setSourceProviders(items);
    } catch {
      setSourceProviders([]);
    }
  };

  /** Fetch the remote document tree. If wikiId is omitted -> use pendingWikiId from the create flow. */
  const fetchWikiTree = async (wikiId?: string, crawl?: WikiCrawlOptions) => {
    const target = wikiId ?? pendingWikiId;
    if (!activeTeamId || !formSourceType || !formSourceUrl.trim() || !target) return;
    setFetchingTree(true);
    try {
      const res = await knowledgeApi.source.wikiList({
        teamId: activeTeamId,
        wikiId: target,
        sourceUrl: formSourceUrl.trim(),
        providerId: formSourceType,
        ...(crawl ?? (crawlMode ? { crawl: { mode: crawlMode, maxDepth: CRAWL_MAX_DEPTH } } : {})),
      });
      setTreeResult(res);
      // Select all non-directory nodes by default
      setSelectedPageIds(res.pages.filter((p) => !p.isDir).map((p) => p.externalId));
    } catch (e: unknown) {
      tea.notify.error(e);
      setTreeResult(null);
    } finally {
      setFetchingTree(false);
    }
  };

  /** Import the selected documents (fetch + write to disk, does not trigger ingest). If wikiId is omitted -> use pendingWikiId. */
  const importWikiPages = async (wikiId?: string) => {
    const target = wikiId ?? pendingWikiId;
    if (!activeTeamId || !formSourceType || !formSourceUrl.trim() || !target) return;
    setImporting(true);
    try {
      await knowledgeApi.source.wikiImport({
        teamId: activeTeamId,
        wikiId: target,
        sourceUrl: formSourceUrl.trim(),
        providerId: formSourceType,
        pageIds: selectedPageIds,
      });
      // Close the dialog and clear the temporary external source state
      setShowCreate(false);
      setShowAddDoc(false);
      setFormSourceUrl('');
      setTreeResult(null);
      setSelectedPageIds([]);
      setFormCredential({});
      setPendingWikiId('');
      fetchSources();
      // Aligned with manual upload: import only writes raw documents, and extraction is left to the user to choose
      // "Start extraction" or "Process later", so users are aware that extraction must be triggered manually.
    } catch (e: unknown) {
      tea.notify.error(e);
    } finally {
      setImporting(false);
    }
  };

  /**
   * Pre-fetch the wiki source list when opening the "Add documents" dialog (used by the detail page external source tab).
   * Difference from openCreate: does not clear the external source form (the user may switch tabs directly inside an existing wiki).
   */
  const loadWikiProviders = async () => {
    if (!activeTeamId) return;
    try {
      setSourceProviders(await knowledgeApi.source.wikiProviders(activeTeamId));
    } catch {
      setSourceProviders([]);
    }
  };

  /**
   * Detail page "Add" entry: look up credential status by wiki_id (design §3.1 (2)).
   *
   * Credentials exist -> fetch the document tree directly (no longer asking the user to re-enter the token);
   * No credentials   -> stay on the entry page and wait for the user to enter the token, persisted by ensureCredential.
   *
   * The source URL is backfilled from the wiki's persisted source_url: existing wikis need not re-enter it, and the user can edit it.
   */
  const openAddDocExternal = async (wiki: WikiDetail) => {
    if (!activeTeamId) return;
    setAddDocTab('external');
    // Backfill with the persisted source (editable), so users don't have to re-enter it for existing wikis
    if (wiki.source_type) setFormSourceType(wiki.source_type);
    if (wiki.source_url) setFormSourceUrl(wiki.source_url);
    setSelectedPageIds([]);
    setTreeResult(null);
    try {
      setSourceProviders(await knowledgeApi.source.wikiProviders(activeTeamId));
    } catch {
      setSourceProviders([]);
    }
    if (!wiki.source_type) return;
    try {
      const cred = await knowledgeApi.source.credentialStatus({
        teamId: activeTeamId,
        resourceType: 'wiki',
        resourceId: wiki.wiki_id,
      });
      setCredConfigured(!!cred);
      // Credentials configured and URL persisted -> list the tree directly, skipping token entry
      if (cred && wiki.source_url) {
        await fetchWikiTree(wiki.wiki_id);
      }
    } catch {
      setCredConfigured(false);
    }
  };

  /**
   * Detail page external source: save the token to KS (persisted per wiki_id), then list the tree immediately on success.
   *
   * Credentials must be saved before fetching the tree - KS's /list reads the token from credentialStore,
   * so without saving first it returns 401 NEED_CREDENTIAL (this was the root cause of the earlier "entered the token but it didn't work").
   */
  const ensureCredential = async (wikiId: string) => {
    if (!activeTeamId || !formSourceType) return false;
    const provider = sourceProviders.find((p) => p.id === formSourceType);
    if (!provider) return false;
    const secret = (formCredential.secret ?? '').trim();
    if (!secret) {
      tea.notify.error(t('code.register.tokenRequired'));
      return false;
    }
    setSavingCred(true);
    try {
      await knowledgeApi.source.credentialPut({
        teamId: activeTeamId,
        resourceType: 'wiki',
        resourceId: wikiId,
        providerId: provider.id,
        credKind: provider.auth_method,
        secret,
        ...((formCredential.username ?? '').trim()
          ? { username: (formCredential.username ?? '').trim() }
          : {}),
      });
      setCredConfigured(true);
      // Clear the plaintext token from memory immediately after submit; do not keep it in frontend state
      setFormCredential({});
      await fetchWikiTree(wikiId);
      return true;
    } catch (e: unknown) {
      tea.notify.error(e);
      return false;
    } finally {
      setSavingCred(false);
    }
  };

  useEffect(() => {
    if (teamAgents.length === 0) {
      setAgentFilter('');
      return;
    }
    if (!agentFilter || !teamAgents.some((a) => a.id === agentFilter)) {
      setAgentFilter(teamAgents[0].id);
    }
  }, [teamAgents, agentFilter]);

  const fetchFixedBindings = useCallback(async () => {
    if (!agentFilter) {
      setFixedBoundIds(new Set());
      return;
    }
    try {
      const items = await knowledgeApi.wiki.agentFixed(agentFilter);
      setFixedBoundIds(new Set(items.map((it) => it.knowledge_id)));
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('wiki.notify.loadFixedFailed'));
      setFixedBoundIds(new Set());
    }
  }, [agentFilter]);

  useEffect(() => {
    if (scopeTab === 'fixed') void fetchFixedBindings();
  }, [scopeTab, fetchFixedBindings]);

  // Filter by ownership tab
  const scopeSources = useMemo(() => {
    if (scopeTab === 'team') return sources;
    if (scopeTab === 'fixed') {
      if (!agentFilter) return [];
      return sources.filter((source) => source.wiki_id && fixedBoundIds.has(source.wiki_id));
    }
    return sources;
  }, [sources, scopeTab, agentFilter, fixedBoundIds]);

  // Stats are only affected by asset scope, so search or status filters don't distort the overview data.
  const stats = useMemo(
    () => ({
      total: scopeSources.length,
      ready: scopeSources.filter((source) => source.status === 'ready').length,
      processing: scopeSources.filter(
        (source) => source.status === 'pending' || source.status === 'processing',
      ).length,
      totalPages: scopeSources.reduce((sum, source) => sum + (source.page_count ?? 0), 0),
    }),
    [scopeSources],
  );

  const filteredSources = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return scopeSources.filter((source) => {
      const isProcessing = source.status === 'pending' || source.status === 'processing';
      if (statusFilter === 'ready' && source.status !== 'ready') return false;
      if (statusFilter === 'processing' && !isProcessing) return false;
      if (!normalizedKeyword) return true;
      return (
        source.name.toLowerCase().includes(normalizedKeyword) ||
        source.wiki_id.toLowerCase().includes(normalizedKeyword) ||
        (source.owner_user_id ?? '').toLowerCase().includes(normalizedKeyword)
      );
    });
  }, [scopeSources, keyword, statusFilter]);

  /** Hide the progress card after the user clicks "Clear"; reset on resubmit or when switching wikis. */
  const [ingestCardCleared, setIngestCardCleared] = useState(false);
  /** Time of the last poll that got the KS ground truth - shows "last updated" while processing so users can confirm progress is moving. */
  const [pollAt, setPollAt] = useState('');
  /** Number of checks in this polling round (+1 per successful poll), shown as "check #N / actually queried N times". */
  const [pollCount, setPollCount] = useState(0);
  /**
   * Set of wiki ids that have been submitted but whose new task hasn't actually started (not yet in processing).
   *
   * This is the key mask for "only show the status of the last submission": after submitting and before the new task is dequeued,
   * the wiki row still holds the status written by the previous task (possibly ready/failed). Without
   * masking, the frontend would leak the previous task's terminal state to the user - showing up as "just submitted but shows ready", "shows
   * the page count of the previous task", and other intermediate states.
   *
   * While in this set: terminal states are always shown as "processing" (reusing KS's processing text and progress),
   * until polling sees the wiki actually enter processing (the new task has taken over), at which point it is released.
   */
  const [pendingTakeover, setPendingTakeover] = useState<Set<string>>(new Set());

  // Detail view state (Wiki details: graph / pages / search Tabs)
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [selectedPage, setSelectedPage] = useState<WikiPage | null>(null);
  const [readContent, setReadContent] = useState('');
  const [readLoading, setReadLoading] = useState(false);
  // Raw document preview:
  // - format='native': PDF/HTML/text → the original bytes go to the browser's native renderer (truly lossless)
  // - format='html'  : OOXML etc. → converted HTML (lossy)
  // - anything else  : rendered as Markdown
  // - error: a readable reason when the conversion fails, instead of a blank panel
  const [rawPreview, setRawPreview] = useState<{
    format?: 'native' | 'client' | 'html' | 'markdown';
    error?: string;
  }>({});
  const [pageTypeFilter, setPageTypeFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // Add doc (add documents: file / paste markdown / external source)
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [addDocTab, setAddDocTab] = useState<'file' | 'markdown' | 'external'>('file');
  // Batch markdown: each entry is { filename, content }, can be added/removed
  const [mdDocs, setMdDocs] = useState<Array<{ filename: string; content: string }>>([
    { filename: '', content: '' },
  ]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Fetch ---
  // Request sequence number to prevent races: when switching tabs quickly, an earlier request may return later,
  // and the old tab's data would overwrite the new tab's data. Each fetch increments the sequence number,
  // and on response we check whether it is still the latest; if not, it is discarded.
  const fetchSeqRef = useRef(0);

  const fetchSources = useCallback(async () => {
    if (!activeTeamId) {
      setSources([]);
      setLoading(false);
      return;
    }
    const seq = ++fetchSeqRef.current;
    // Refresh silently when switching teams (keep the old list until new data arrives), no blanking or skeleton;
    // switching tabs still clears + shows loading (to avoid seeing the previous tab's list).
    const teamChanged = prevTeamIdRef.current !== activeTeamId;
    if (!teamChanged) {
      setLoading(true);
      // Clear old data immediately - otherwise switching tabs first shows the previous tab's list,
      // which is then suddenly replaced when new data arrives, visually a "flash".
      setSources([]);
    }
    try {
      // Assets are uniformly team-scoped (visibility=team); there is no private/"my assets" concept.
      // The fixed tab also fetches all team assets, then filters by fixedBoundIds.
      const d = await knowledgeApi.wiki.teamAssets(activeTeamId);
      if (seq !== fetchSeqRef.current) return; // superseded by a later request
      setSources(Array.isArray(d) ? d : []);
    } catch (e: unknown) {
      if (seq !== fetchSeqRef.current) return;
      tea.notify.error(e);
      setSources([]);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [activeTeamId, scopeTab]);

  // Trigger fetchSources: depends on the raw params + fetchSources, deduplicated by key to prevent repeated triggers in a short time.
  const fetchKeyRef = useRef<string>('');
  useEffect(() => {
    const key = `${activeTeamId}|${scopeTab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void fetchSources();
  }, [activeTeamId, scopeTab, fetchSources]);

  // When switching teams, exit the detail view and clear the old wiki's local state, to avoid still showing the previous team's pages/graph/content.
  const prevTeamIdRef = useRef(activeTeamId);
  useEffect(() => {
    if (prevTeamIdRef.current === activeTeamId) return;
    prevTeamIdRef.current = activeTeamId;
    setSubView('list');
    setSelectedWikiId('');
    setActiveTab('overview');
    setSelectedPage(null);
    setSearchQuery('');
    setSearchResults([]);
    setPageTypeFilter('all');
    setPages([]);
    setGraphData(null);
    setReadContent('');
    setRawPreview({});
    setShowAddDoc(false);
  }, [activeTeamId]);

  const fetchDetail = useCallback(async (wikiId: string) => {
    setGraphLoading(true);
    // Each sub-request has its own fallback, so the outer catch can't catch them; use a flag to detect any failure and show a unified message,
    // avoiding a silently blank detail page on load failure that leaves the user unable to tell what happened.
    let hadError = false;
    try {
      const [g, p] = await Promise.all([
        knowledgeApi.wiki.graph(wikiId).catch(() => {
          hadError = true;
          return null;
        }),
        knowledgeApi.wiki.pages(wikiId).catch(() => {
          hadError = true;
          return [];
        }),
      ]);
      setGraphData(g);
      setPages(Array.isArray(p) ? p : (p as { pages?: WikiPage[] } | null)?.pages || []);
    } finally {
      setGraphLoading(false);
    }
    if (hadError) tea.notify.error(t('wiki.notify.loadDetailFailed'));
  }, []);

  const runningWikiKey = useMemo(
    () =>
      sources
        .filter((s) => s.status === 'pending' || s.status === 'processing')
        .map((s) => `${s.wiki_id}:${s.status}:${s.internal_status ?? ''}`)
        .join('|'),
    [sources],
  );

  useEffect(() => {
    const running = sources.filter(
      (s) =>
        s.wiki_id &&
        // Besides pending/processing, also cover wikis that are "submitted but not yet taken over by the new task":
        // they look terminal (left by the previous task), but a new task is actually queued, so we must keep
        // polling to observe the moment the new task actually starts.
        (s.status === 'pending' || s.status === 'processing' || pendingTakeover.has(s.wiki_id)),
    );
    if (running.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      const items = await Promise.all(
        running.map(async (s) => {
          try {
            return await knowledgeApi.wiki.get(s.wiki_id);
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const map = new Map(items.filter(Boolean).map((w) => [w!.wiki_id, w!]));
      setSources((prev) =>
        prev.map((s) => (map.get(s.wiki_id) ? { ...s, ...map.get(s.wiki_id)! } : s)),
      );
      // The new task has actually started (processing) -> release the mask for this wiki and show its real progress from now on.
      setPendingTakeover((prev) => {
        if (prev.size === 0) return prev;
        let changed = false;
        const next = new Set(prev);
        for (const w of map.values()) {
          if (w && next.has(w.wiki_id) && w.status === 'processing') {
            next.delete(w.wiki_id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      // Increment the check count + record the time on each successful poll - the progress card uses these to show
      // "Check #N: ..." and "Actually queried N times, last at HH:MM:SS", so users can confirm progress is moving.
      setPollCount((n) => n + 1);
      setPollAt(new Date().toLocaleTimeString());
      if (selectedWikiId && map.has(selectedWikiId)) {
        const d = map.get(selectedWikiId)!;
        if (d.status === 'ready' || d.status === 'failed') void fetchDetail(selectedWikiId);
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runningWikiKey, selectedWikiId, fetchDetail]);

  /**
   * Session phase machine for the detail page progress card (purely derived, no separate data source).
   *
   * - The current wiki in sources becomes pending/processing -> 'active'
   * - Was 'active' during the session, then sees a terminal state -> stays at 'done' (shows the result until the user clears it)
   * - The wiki is already terminal on entering the detail page and this session never saw active -> 'idle' (no card shown)
   */
  const prevSessionRef = useRef<'idle' | 'active' | 'done'>('idle');
  const displayIngestState = useMemo(() => {
    const wiki = sources.find((s) => s.wiki_id === selectedWikiId);
    const name = wiki?.name ?? '';
    const rawStatus = wiki?.status ?? 'draft';
    /**
     * Mask "terminal states left by the previous task": while submitted but not yet taken over by the new task (pendingTakeover),
     * the ready/failed on the wiki row belongs to the previous task and must never be shown to the user.
     * During this period it is always presented as "processing" (reusing KS's processing text and stage progress),
     * until the new task actually enters processing, which releases the mask and shows its real progress.
     */
    const awaitingTakeover = selectedWikiId ? pendingTakeover.has(selectedWikiId) : false;
    const staleTerminal =
      awaitingTakeover && (rawStatus === 'ready' || rawStatus === 'failed');
    const status = staleTerminal ? 'processing' : rawStatus;
    // Stale terminal states do not show the previous task's internal_status / page_count (those belong to the old task)
    const internalStatus = staleTerminal ? null : (wiki?.internal_status ?? null);
    const pageCount = staleTerminal ? null : (wiki?.page_count ?? null);

    const inFlight = status === 'pending' || status === 'processing';
    const isTerminal = status === 'ready' || status === 'failed';
    // Session transition: active -> (terminal) -> done.
    // Note: after ready the progress card collapses automatically (the terminal state is shown by the title bar badge + page count);
    // the session is mainly for failed - the error reason must be shown explicitly, so it is kept until the user clicks "Clear".
    const session =
      inFlight ? 'active'
      : isTerminal && prevSessionRef.current === 'active' ? 'done'
      : isTerminal && prevSessionRef.current === 'done' ? 'done'
      : 'idle';
    if (session !== prevSessionRef.current) prevSessionRef.current = session;

    const stage = wikiStageLabel(status as WikiDetail['status'], internalStatus);
    const pageHint =
      typeof pageCount === 'number' && pageCount > 0
        ? t('wiki.ingest.currentPage', { count: pageCount })
        : '';

    // The processing text must include "check #N" and the page count hint - this is the only way users can tell "progress is really moving";
    // no refactor may omit the attempt / pageHint template params (lesson from a past regression).
    //
    // pending / draft are also shown with normal phase text (the "scanning files" stage); we no longer invent
    // text like "queued, waiting for the previous task to yield" - the status line only describes the real KS state.
    let detail: string;
    if (status === 'ready') {
      detail = t('wiki.ingest.done', { count: pageCount ?? 0 });
    } else if (status === 'failed') {
      detail = wiki?.sync_error || t('wiki.ingest.failed');
    } else {
      detail = t('knowledgeApi.ingest.check', { attempt: Math.max(pollCount, 1), stage, pageHint });
    }

    return {
      active: session === 'active',
      /** 'done' session = a "processing -> terminal" transition was observed in this session; still shows the result card. */
      session,
      /** Masked display state - shared by the badge and the card, so the two are always consistent. */
      status: status as WikiDetail['status'],
      wikiId: selectedWikiId,
      wiki: name,
      currentFile: '',
      detail,
      done: wikiProgressPercent(status as WikiDetail['status'], internalStatus),
      total: 100,
      checkCount: session === 'active' ? pollCount : 0,
      lastCheckedAt: session === 'active' ? pollAt : '',
      log: [] as { file: string; status: 'error' | 'done'; error?: string }[],
    };
  }, [sources, selectedWikiId, pollAt, pollCount, pendingTakeover]);

  async function handleUnbindWiki(wikiId: string) {
    if (!agentFilter) return;
    await confirmThenRun(
      {
        message: t('wiki.confirm.unbind'),
        description: t('wiki.confirm.unbind.desc'),
        okText: t('wiki.confirm.unbind.ok'),
      },
      async () => {
        await knowledgeApi.wiki.unbind(wikiId, agentFilter);
        tea.notify.success(t('wiki.notify.unbound'));
        if (selectedWikiId === wikiId) setSelectedWikiId('');
        await fetchFixedBindings();
        await fetchSources();
      },
      (e) => tea.notify.error((e as Error)?.message || t('wiki.notify.unbindFailed')),
    );
  }

  // --- Handlers ---
  const handleCreate = async () => {
    if (!newName.trim() || !activeTeamId) return;

    // External source: validate required credential fields
    const provider = sourceProviders.find((p) => p.id === formSourceType);
    if (provider) {
      for (const f of provider.form_fields) {
        if (f.required && !(formCredential[f.name] ?? '').trim()) {
          tea.notify.error(t('code.register.tokenRequired'));
          return;
        }
      }
      if (!formSourceUrl.trim()) {
        tea.notify.error(t('wiki.register.sourceUrl'));
        return;
      }
    }

    setSubmitting(true);
    try {
      const detail = await knowledgeApi.wiki.create(
        activeTeamId,
        newName.trim(),
        provider ? formSourceUrl.trim() : undefined,
        provider ? formSourceType : undefined,
      );

      // External source: only save credentials; **do not fetch the document list here**.
      // Fetching is triggered on demand from the detail page "Add", keeping the create flow consistent with manual creation
      // (close once created), to avoid having to wait for the whole document tree on every creation.
      if (provider) {
        const secret = (formCredential.secret ?? '').trim();
        const username = (formCredential.username ?? '').trim();
        await knowledgeApi.source.credentialPut({
          teamId: activeTeamId,
          resourceType: 'wiki',
          resourceId: detail.wiki_id,
          providerId: provider.id,
          credKind: provider.auth_method,
          secret,
          ...(username ? { username } : {}),
        });
        // Clear the plaintext token from memory immediately after submit
        setFormCredential({});
      }

      tea.notify.success(t('wiki.notify.created', { name: newName.trim() }));
      setShowCreate(false);
      setNewName('');
      setFormSourceUrl('');
      setTreeResult(null);
      setSelectedPageIds([]);
      fetchSources();
    } catch (e: unknown) {
      tea.notify.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  /** Set of all wiki_ids currently being ingested (pending / processing), used to determine button state per card in the list. */
  const runningWikiIds = useMemo(
    () =>
      new Set(
        sources
          .filter((s) => s.status === 'pending' || s.status === 'processing')
          .map((s) => s.wiki_id),
      ),
    [sources],
  );
  /**
   * Whether the wiki on the current detail page is itself being extracted (pending / processing).
   *
   * Used to decide whether the top bar "Import documents" button is disabled: only cares about the **current wiki**, and is not
   * disabled just because other knowledge bases are running.
   *
   * Background (design 2026-09-21 §3.3): KS uses a per-wiki SerialQueue (different wikis
   * have independent queues and can naturally run in parallel), and re-running the same wiki is safely switched by onBusy:'replace'
   * (cancel the old task + queue the new task). So the old "only one Wiki extraction at a time"
   * global mutex (based on runningWiki without wikiId filtering) is no longer necessary, and would instead wrongly block
   * the import entry of unrelated knowledge bases.
   *
   * Note: displayIngestState / ingestBusy still keep global semantics - the top progress bar needs
   * to restore the progress of **any** running wiki after a page refresh (stateRecovery), so it cannot be narrowed.
   */
  const isCurrentWikiIngesting = (wikiId: string): boolean => {
    if (!wikiId) return false;
    const self = sources.find(
      (s) => s.wiki_id === wikiId && (s.status === 'pending' || s.status === 'processing'),
    );
    return !!self;
  };

  /**
   * Import and extract (design 2026-09-21 merged entry).
   *
   * A single composite request does "write raw + trigger ingest"; interrupting the old task is done in the background by Panel/KS's
   * onBusy:'replace', invisible to the user (no confirm, no Alert).
   *
   * This function does not poll progress itself - right after submitting it calls fetchSources to get the new state (KS ground truth,
   * pending/processing), and the runningWikiKey polling effect takes over subsequent refreshes.
   */
  const submitAddAndIngest = async (params: {
    wikiId: string;
    mode: 'files' | 'markdown' | 'external' | 'reingest';
    // encoding must be kept and passed through: Knowledge decodes as base64 by default, and a hand-pasted MD must say
    // 'utf8' explicitly, otherwise it is judged invalid base64. See the comments in import-and-ingest-modal.tsx.
    files?: { filename: string; content: string; encoding?: 'utf8' | 'base64' }[];
    markdown?: { filename: string; content: string; encoding?: 'utf8' | 'base64' }[];
    source_url?: string;
    provider_id?: string;
    page_ids?: string[];
  }): Promise<void> => {
    const { wikiId, mode } = params;
    if (!wikiId) return;

    try {
      const res = await knowledgeApi.wiki.importAndIngest({
        wiki_id: wikiId,
        mode,
        ...(params.files ? { files: params.files } : {}),
        ...(params.markdown ? { markdown: params.markdown } : {}),
        ...(params.source_url ? { source_url: params.source_url } : {}),
        ...(params.provider_id ? { provider_id: params.provider_id } : {}),
        ...(params.page_ids ? { page_ids: params.page_ids } : {}),
      });

      // The composite request has returned: whether or not it succeeded, raw may have changed.
      // fetchSources pulls the new state (pending/processing) - sources is the single source of truth,
      // and the runningWikiKey polling effect uses it to start 2s polling automatically until a terminal state.
      setRawRefreshKey((k) => k + 1);
      await fetchSources();

      if (!res.ok) {
        const msg = res.error_message || t('wiki.notify.ingestFailed');
        tea.notify.error(msg);
        fetchDetail(wikiId);
        return;
      }

      // ✅ Show the progress card only once the compound request is accepted (the task is really queued):
      // reset the "cleared" flag so the card appears, and reset the check count to zero - otherwise the second
      // import would continue counting from the previous one.
      //
      // ⚠ This reset used to run **before the request was sent**: when an oversize file was rejected with
      // 413/FILE_TOO_LARGE, the card had already popped up and entered the polling state, so the user saw the
      // contradictory picture "an error, yet progress is running". It now resets only after acceptance, and a
      // rejected request shows no progress at all.
      setIngestCardCleared(false);
      setPollCount(0);
      setPollAt('');
      // Mask "terminal states left by the previous task": from now until the new task actually enters processing,
      // any ready/failed on this wiki is treated as stale and not shown to the user.
      setPendingTakeover((prev) => {
        const next = new Set(prev);
        next.add(wikiId);
        return next;
      });

      // Trigger an immediate refresh, so the new state shows without waiting for the next poll tick
      fetchDetail(wikiId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      tea.notify.error(msg);
      setRawRefreshKey((k) => k + 1);
      fetchDetail(wikiId);
    }
  };

  const handleIngest = async (wikiId: string) => {
    if (!wikiId) return;
    // List-page ingest only extracts, exactly matching the "re-extract" path of the detail page "Import documents" Modal
    // when "all three tabs are empty": it goes through the same composite endpoint import-and-ingest
    // (mode: 'reingest'), and KS's onBusy:'replace' atomically does "cancel the old task +
    // queue the new task".
    await submitAddAndIngest({ wikiId, mode: 'reingest' });
  };

  const handleDelete = async (wikiId: string, name: string) => {
    await confirmThenRun(
      {
        message: t('wiki.confirm.delete', { name }),
        okText: t('common.delete'),
      },
      async () => {
        await knowledgeApi.wiki.delete(wikiId);
        if (selectedWikiId === wikiId) setSubView('list');
        fetchSources();
      },
    );
  };

  const openDetail = (wikiId: string) => {
    setSelectedWikiId(wikiId);
    setActiveTab('overview');
    setSelectedPage(null);
    setSearchQuery('');
    setSearchResults([]);
    setPageTypeFilter('all');
    // When switching to another wiki's details, the previous wiki's detail-level data (page list / graph / read content) must be cleared.
    // Otherwise, before the new wiki's fetchDetail returns, the overview/graph/pages tabs would briefly flash the previous wiki's content.
    setPages([]);
    setGraphData(null);
    setReadContent('');
    setRawPreview({});
    setSubView('detail');
    fetchDetail(wikiId);
  };

  const handleReadPage = async (page: WikiPage) => {
    if (!selectedWikiId) return;
    // When switching pages, clear the old content first before entering loading - otherwise the derived metadata (from readContent)
    // would keep the previous document's tags until the new content returns, visually a "flash of the old document".
    setSelectedPage(page);
    setReadContent('');
    // A wiki page is markdown, rendered as markdown
    setRawPreview({});
    setReadLoading(true);
    try {
      const r = await knowledgeApi.wiki.read(
        selectedWikiId,
        (page as { id?: string }).id || page.path,
      );
      setReadContent(r?.content || '');
    } catch (e: unknown) {
      setReadContent('');
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('wiki.notify.readPageFailed'));
    } finally {
      setReadLoading(false);
    }
  };

  /**
   * Reads a raw document (an uploaded file under raw/sources/) for preview.
   *
   * A preview should **render the original document itself**, not turn the content into text and show that:
   * - Rich documents (docx/pptx/xlsx/pdf/odt/...) → KS converts them to full HTML (keeping paged slides, Excel row and
   *   column headers, paged pages and other original layouts) → rendered by the front end in a sandboxed iframe;
   * - Text files (md/txt/csv) → the original text → rendered as Markdown.
   * The form is told by the backend's `preview_format`, and the front end picks its renderer from it.
   * When a conversion fails, a readable reason is shown instead of a blank panel.
   */
  const handleReadRaw = async (filename: string) => {
    if (!selectedWikiId) return;
    setSelectedPage({ path: `raw/${filename}`, title: filename, type: 'raw' });
    setReadContent('');
    setRawPreview({});
    setReadLoading(true);
    try {
      const r = await knowledgeApi.wiki.rawRead(selectedWikiId, [filename]);
      const item = r?.items?.[0];
      if (!item || item.not_found) {
        setRawPreview({ error: t('wiki.notify.rawNotFound') });
        return;
      }
      // Look only at preview_error and do not require binary: html/htm are text sources (binary=false), but their
      // preview also goes through the conversion layer, so a failure needs a readable reason just the same.
      if (item.preview_error) {
        setRawPreview({
          error: RAW_PREVIEW_ERROR_KEYS[item.preview_error] ?? t('wiki.rawPreview.failed'),
        });
        return;
      }
      setReadContent(item.content || '');
      setRawPreview({ format: item.preview_format ?? 'markdown' });
    } catch (e: unknown) {
      setRawPreview({
        error: (e instanceof Error ? e.message : String(e)) || t('wiki.notify.readRawFailed'),
      });
    } finally {
      setReadLoading(false);
    }
  };

  const handleDeletePage = async (page: WikiPage) => {
    if (!selectedWikiId) return;
    const ref = (page as { id?: string }).id || page.path;
    await confirmThenRun(
      {
        message: t('wiki.confirm.deletePage', { name: page.title || ref }),
        description: t('wiki.confirm.deletePage.desc'),
        okText: t('common.delete'),
      },
      async () => {
        await knowledgeApi.wiki.pageDelete(selectedWikiId, [ref]);
        tea.notify.success(t('wiki.notify.pageDeleted'));
        if (selectedPage && ((selectedPage as { id?: string }).id || selectedPage.path) === ref) {
          setSelectedPage(null);
          setReadContent('');
        }
        await fetchDetail(selectedWikiId);
      },
      (e) => tea.notify.error((e as Error)?.message || t('wiki.notify.pageDeleteFailed')),
    );
  };

  const handleDeleteRaw = async (filename: string) => {
    if (!selectedWikiId) return;
    await confirmThenRun(
      {
        message: t('wiki.confirm.deleteRaw', { name: filename }),
        description: t('wiki.confirm.deleteRaw.desc'),
        okText: t('common.delete'),
      },
      async () => {
        await knowledgeApi.wiki.rawDelete(selectedWikiId, [filename]);
        tea.notify.success(t('wiki.notify.rawDeleted'));
        if (selectedPage?.path === `raw/${filename}`) {
          setSelectedPage(null);
          setReadContent('');
          setRawPreview({});
        }
        await fetchDetail(selectedWikiId);
      },
      (e) => tea.notify.error((e as Error)?.message || t('wiki.notify.rawDeleteFailed')),
    );
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() || !selectedWikiId) return;
    setSearching(true);
    try {
      const r = await knowledgeApi.wiki.search(selectedWikiId, searchQuery, 20);
      setSearchResults((r as { results?: SearchResult[] }).results || []);
    } catch (e: unknown) {
      tea.notify.error(e);
    } finally {
      setSearching(false);
    }
  };

  // Raw document list refresh signal: RawFilesSection maintains its own independent state and only reloads when wikiId changes;
  // after a successful upload fetchDetail only refreshes pages/graph and won't trigger a refetch there. Incrementing this key forces it to reload.
  const [rawRefreshKey, setRawRefreshKey] = useState(0);

  const confirmOverwrite = async (filenames: readonly string[]): Promise<boolean> => {
    try {
      const { files } = await knowledgeApi.wiki.rawList(selectedWikiId);
      const existing = findExistingRawFilenames(
        filenames,
        files.map((file) => file.filename),
      );
      if (existing.length === 0) return true;

      return tea.confirm({
        message: t('wiki.detail.overwrite.title', { count: existing.length }),
        description: t('wiki.detail.overwrite.desc', { files: formatOverwriteFilenames(existing) }),
        okText: t('wiki.detail.overwrite.ok'),
        cancelText: t('common.cancel'),
      });
    } catch (e: unknown) {
      tea.notify.error(e instanceof Error ? e : t('wiki.notify.uploadCancelled'));
      return false;
    }
  };


  const handleUploadMdBatch = async () => {
    if (!activeTeamId || !selectedWikiId) return;
    const valid = mdDocs.filter((d) => d.filename.trim() && d.content.trim());
    if (valid.length === 0) return;
    if (uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    setSubmitting(true);
    if (!(await confirmOverwrite(valid.map((doc) => doc.filename.trim())))) {
      uploadInFlightRef.current = false;
      setSubmitting(false);
      return;
    }
    const failures: Array<{ filename: string; error: string }> = [];
    for (const doc of valid) {
      const filename = doc.filename.trim();
      try {
        await knowledgeApi.wiki.upload({ teamId: activeTeamId, wikiId: selectedWikiId, filename, content: doc.content });
      } catch (e: unknown) {
        failures.push({ filename, error: e instanceof Error ? e.message : String(e) });
      }
    }
    uploadInFlightRef.current = false;
    setSubmitting(false);
    if (failures.length === 0) {
      tea.notify.success(t('wiki.detail.upload.success', { count: valid.length }));
      setMdDocs([{ filename: '', content: '' }]);
      setShowAddDoc(false);
      fetchDetail(selectedWikiId);
      setRawRefreshKey((k) => k + 1);
    } else {
      const okCount = valid.length - failures.length;
      // List the reason for each failed file, showing at most 3 and collapsing the rest
      const shown = failures
        .slice(0, 3)
        .map((f) => `${f.filename}: ${f.error}`)
        .join('\n');
      const more = failures.length > 3 ? t('wiki.detail.upload.more', { count: failures.length - 3 }) : '';
      tea.notify.error(t('wiki.detail.upload.partialFail', { ok: okCount, fail: failures.length, detail: `${shown}${more}` }));
      fetchDetail(selectedWikiId);
      setRawRefreshKey((k) => k + 1);
    }
  };

  // Batch file upload: supports multi-select + drag and drop, uploads concurrently
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, 'pending' | 'done' | 'error'>
  >({});

  const handleBatchUpload = async () => {
    if (!activeTeamId || !selectedWikiId || pendingFiles.length === 0) return;
    if (uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    setSubmitting(true);
    if (!(await confirmOverwrite(pendingFiles.map((file) => file.name)))) {
      uploadInFlightRef.current = false;
      setSubmitting(false);
      return;
    }
    setUploadProgress(Object.fromEntries(pendingFiles.map((f) => [f.name, 'pending'])));
    // Front-end pre-check: stop files over the maxBytes sent down by the format registry, **without sending a request**.
    // There used to be no such check, so an oversize file went through the whole base64 encoding plus the Panel/KS round
    // trip before being rejected with a 413, a big file waited for nothing, and the error text hard-coded "512KB" (which
    // did not match the real tier and misled people).
    const maxOf = (f: File) => maxBytesForFile(f.name);
    const oversize = pendingFiles.filter((f) => {
      const max = maxOf(f);
      return max !== undefined && f.size > max;
    });
    if (oversize.length) {
      for (const f of oversize) {
        setUploadProgress((prev) => ({ ...prev, [f.name]: 'error' }));
        tea.notify.error(
          t('wiki.detail.upload.fileTooLarge', {
            filename: f.name,
            maxMB: ((maxOf(f) ?? 0) / 1024 / 1024).toFixed(1),
          }),
        );
      }
    }
    const uploadables = pendingFiles.filter((f) => !oversize.includes(f));
    if (!uploadables.length) {
      uploadInFlightRef.current = false;
      setSubmitting(false);
      return;
    }
    // Upload all files concurrently (only those within the limit)
    const results = await Promise.allSettled(
      uploadables.map(async (f) => {
        const { content, encoding } = await readUploadFile(f);
        await knowledgeApi.wiki.upload({
          teamId: activeTeamId,
          wikiId: selectedWikiId,
          filename: f.name,
          content,
          encoding,
        });
        setUploadProgress((prev) => ({ ...prev, [f.name]: 'done' }));
      }),
    );
    uploadInFlightRef.current = false;
    setSubmitting(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    const succeeded = results.length - failed;
    if (failed === 0) {
      tea.notify.success(t('wiki.detail.upload.successFiles', { count: succeeded }));
      setPendingFiles([]);
      setUploadProgress({});
      setShowAddDoc(false);
      fetchDetail(selectedWikiId);
      setRawRefreshKey((k) => k + 1);
      // The file upload entry previously missed this step, so users didn't know they had to trigger extraction manually after uploading.
    } else {
      results.forEach((r, i) => {
        if (r.status === 'rejected')
          setUploadProgress((prev) => ({ ...prev, [pendingFiles[i].name]: 'error' }));
      });
      tea.notify.error(t('wiki.detail.upload.fail', { ok: succeeded, fail: failed }));
      fetchDetail(selectedWikiId);
      setRawRefreshKey((k) => k + 1);
    }
  };

  // --- Computed ---
  const typeCounts = useMemo(
    () =>
      pages.reduce<Record<string, number>>((a, p) => {
        a[p.type] = (a[p.type] || 0) + 1;
        return a;
      }, {}),
    [pages],
  );
  const types = useMemo(() => Object.keys(typeCounts).sort(), [typeCounts]);
  const filteredPages = useMemo(
    () => (pageTypeFilter === 'all' ? pages : pages.filter((p) => p.type === pageTypeFilter)),
    [pages, pageTypeFilter],
  );
  const edgeCount = graphData?.edges?.length || 0;

  const { displayContent, metadata } = useMemo(() => {
    const text = readContent;
    // Case 1: standard --- fenced frontmatter
    const fenced = text.match(/^---\n([\s\S]*?)\n---\n*/);
    if (fenced) {
      const body = text.slice(fenced[0].length);
      const meta: Record<string, string> = {};
      fenced[1].split('\n').forEach((l) => {
        const [k, ...v] = l.split(':');
        if (k?.trim() && v.length) meta[k.trim()] = v.join(':').trim();
      });
      return { displayContent: body, metadata: Object.keys(meta).length > 0 ? meta : null };
    }
    // Case 2: unfenced frontmatter (type: xxx\ntitle: xxx\n... at the start)
    const lines = text.split('\n');
    const fmLines: string[] = [];
    let i = 0;
    // skip leading blank lines
    while (i < lines.length && !lines[i].trim()) i++;
    // collect key: value lines (must have key at start, no leading whitespace, colon present)
    while (i < lines.length) {
      const line = lines[i];
      if (/^[a-zA-Z_][\w-]*\s*:/.test(line)) {
        fmLines.push(line);
        i++;
      } else {
        break;
      }
    }
    if (fmLines.length >= 2) {
      const meta: Record<string, string> = {};
      fmLines.forEach((l) => {
        const [k, ...v] = l.split(':');
        if (k?.trim() && v.length) meta[k.trim()] = v.join(':').trim();
      });
      // skip blank lines after frontmatter
      while (i < lines.length && !lines[i].trim()) i++;
      return {
        displayContent: lines.slice(i).join('\n'),
        metadata: Object.keys(meta).length > 0 ? meta : null,
      };
    }
    return { displayContent: text, metadata: null };
  }, [readContent]);

  return {
    // context
    activeTeam,
    activeTeamId,
    currentUser,
    teamAgents,
    // list view
    sources,
    loading,
    scopeTab,
    setScopeTab,
    keyword,
    setKeyword,
    statusFilter,
    setStatusFilter,
    viewMode,
    setViewMode,
    subView,
    setSubView,
    selectedWikiId,
    setSelectedWikiId,
    // create
    showCreate,
    setShowCreate,
    newName,
    setNewName,
    submitting,
    setSubmitting,
    // allocate
    allocateTarget,
    setAllocateTarget,
    fixedBoundIds,
    agentFilter,
    setAgentFilter,
    // detail
    activeTab,
    setActiveTab,
    pages,
    setPages,
    graphData,
    setGraphData,
    graphLoading,
    setGraphLoading,
    ingestCardCleared,
    setIngestCardCleared,
    selectedPage,
    setSelectedPage,
    readContent,
    setReadContent,
    readLoading,
    setReadLoading,
    rawPreview,
    setRawPreview,
    handleReadRaw,
    pageTypeFilter,
    setPageTypeFilter,
    searchQuery,
    setSearchQuery,
    searchResults,
    setSearchResults,
    searching,
    setSearching,
    // add doc
    showAddDoc,
    setShowAddDoc,
    addDocTab,
    setAddDocTab,
    mdDocs,
    setMdDocs,
    pendingFiles,
    setPendingFiles,
    uploadProgress,
    setUploadProgress,
    rawRefreshKey,
    setRawRefreshKey,
    fileInputRef,
    // fetch & handlers
    fetchSources,
    fetchFixedBindings,
    fetchDetail,
    handleUnbindWiki,
    handleCreate,
    // External source (iWiki, etc.)
    formSourceType,
    setFormSourceType,
    sourceProviders,
    formCredential,
    setFormCredential,
    setCredentialField,
    formSourceUrl,
    setFormSourceUrl,
    treeResult,
    selectedPageIds,
    setSelectedPageIds,
    fetchingTree,
    importing,
    credConfigured,
    crawlMode,
    setCrawlMode,
    savingCred,
    fetchWikiTree,
    importWikiPages,
    loadWikiProviders,
    openAddDocExternal,
    ensureCredential,
    openCreate,
    handleIngest,
    isCurrentWikiIngesting,
    submitAddAndIngest,
    handleDelete,
    openDetail,
    handleReadPage,
    handleDeletePage,
    handleDeleteRaw,
    handleSearch,
    handleUploadMdBatch,
    handleBatchUpload,
    // computed
    scopeSources,
    stats,
    filteredSources,
    typeCounts,
    types,
    filteredPages,
    edgeCount,
    runningWikiIds,
    displayIngestState,
    displayContent,
    metadata,
  };
}

export type WikiSourcesStore = ReturnType<typeof useWikiSources>;
