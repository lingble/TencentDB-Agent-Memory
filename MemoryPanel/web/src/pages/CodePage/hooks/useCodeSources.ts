/**
 * useCodeSources — all state and data logic for the Code asset page.
 * The component layer only keeps JSX rendering; state / data logic is centralized here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  knowledgeApi,
  type CodeGraphDetail,
  type SourceProviderMeta,
} from '@/lib/api/knowledge-api';
import { useTeams, useAgents } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea } from '@/lib/tea-bridge';
import { isValidGitUrl, isSshGitUrl, formatRepoName, SSH_SOURCE_ID, type ScopeTab, type StatusFilter, type SubView, type ViewMode } from '../constants/code-constants';

export function useCodeSources() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<CodeGraphDetail[]>([]);
  const [loading, setLoading] = useState(false);
  // Show Agent assets (fixed) by default, so users don't mistakenly think their own assets are under "Team assets"
  const [scopeTab, setScopeTab] = useState<ScopeTab>('fixed');
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [inFlight, setInFlight] = useState<CodeGraphDetail[]>([]);

  // Detail view state
  const [subView, setSubView] = useState<SubView>('list');
  const [selectedCgId, setSelectedCgId] = useState('');

  // Register dialog state
  const [showRegister, setShowRegister] = useState(false);
  const [formRepo, setFormRepo] = useState('');
  const [formBranch, setFormBranch] = useState('main');
  const [submitting, setSubmitting] = useState(false);

  // External source (e.g. Gongfeng): '' = public repo
  const [formSourceType, setFormSourceType] = useState('');
  const [sourceProviders, setSourceProviders] = useState<SourceProviderMeta[]>([]);
  /**
   * Credential field values temporarily entered in the dialog (stored dynamically per provider.form_fields);
   * in memory only, cleared immediately after submit, never persisted to localStorage.
   * key = field name (`secret` / `username` / others in the future).
   */
  const [formCredential, setFormCredential] = useState<Record<string, string>>({});
  const setCredentialField = (name: string, value: string) =>
    setFormCredential((prev) => ({ ...prev, [name]: value }));

  // SSH 两段式注册：第 1 段拿到的公钥 + 是否展示公钥弹窗
  const [sshPublicKey, setSshPublicKey] = useState('');
  const [showSshKey, setShowSshKey] = useState(false);

  // Allocate-to-agent dialog state
  const [allocateTarget, setAllocateTarget] = useState<{
    cgId: string;
    repo: string;
    branch: string;
  } | null>(null);
  const [selectedCodeAsset, setSelectedCodeAsset] = useState<{
    cgId: string;
    repo: string;
    branch: string;
  } | null>(null);
  const { activeTeamId, activeTeam } = useTeams();
  const auth = readAuth();
  const currentUser = auth?.user_id ?? '';
  // The Fixed assets tab lists only agents owned by the current user (consistent with the ChatMemory / Skills panels,
  // and with the §4.2 permission rule in the docs: agent-fixed only allows viewing agents owned by the caller).
  const { agents: allAgents } = useAgents(activeTeamId);
  const teamAgents = useMemo(
    () =>
      allAgents
        .filter((a) => a.owner_user_id === currentUser)
        .map((a) => ({ id: a.agent_id, name: a.name })),
    [allAgents, currentUser],
  );
  // agent_id selected under the fixed tab
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [fixedBoundIds, setFixedBoundIds] = useState<Set<string>>(new Set());

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
      const items = await knowledgeApi.code.agentFixed(agentFilter);
      setFixedBoundIds(new Set(items.map((it) => it.knowledge_id)));
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('code.notify.loadFixedFailed'));
      setFixedBoundIds(new Set());
    }
  }, [agentFilter, t]);

  useEffect(() => {
    if (scopeTab === 'fixed') void fetchFixedBindings();
  }, [scopeTab, fetchFixedBindings]);

  const displaySources = useMemo(() => {
    // inFlight = repos just registered or just "Sync"-ed, whose status is refreshed live by code.get polling.
    // For the same id inFlight overrides sources: otherwise the detail header would only show the status from the
    // teamAssets snapshot at the 202 moment, and polling results would never reach the UI.
    if (inFlight.length === 0) return sources;
    const inFlightMap = new Map(inFlight.map((x) => [x.code_graph_id, x]));
    const sourceIds = new Set(sources.map((s) => s.code_graph_id));
    // Items not yet in teamAssets (just registered, meta not yet recorded) are placed first as placeholders
    const extras = inFlight.filter((x) => x.code_graph_id && !sourceIds.has(x.code_graph_id));
    return [...extras, ...sources.map((s) => inFlightMap.get(s.code_graph_id) ?? s)];
  }, [sources, inFlight]);

  const scopeSources = useMemo(() => {
    if (scopeTab === 'team') return displaySources;
    if (scopeTab === 'fixed') {
      if (!agentFilter) return [];
      return displaySources.filter(
        (source) => source.code_graph_id && fixedBoundIds.has(source.code_graph_id),
      );
    }
    return displaySources;
  }, [displaySources, scopeTab, agentFilter, fixedBoundIds]);

  // Stats follow only the current asset scope, so search or status filters don't distort the overview numbers.
  const stats = useMemo(
    () => ({
      total: scopeSources.length,
      ready: scopeSources.filter((source) => source.status === 'ready').length,
      processing: scopeSources.filter(
        (source) => source.status === 'pending' || source.status === 'processing',
      ).length,
      totalFiles: scopeSources.reduce((total, source) => total + (source.stats?.files ?? 0), 0),
    }),
    [scopeSources],
  );

  const filteredSources = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return scopeSources.filter((source) => {
      const isProcessing = source.status === 'pending' || source.status === 'processing';
      const isError = source.status === 'failed' || source.status === 'missing';
      if (statusFilter === 'ready' && source.status !== 'ready') return false;
      if (statusFilter === 'processing' && !isProcessing) return false;
      if (statusFilter === 'error' && !isError) return false;
      if (!normalizedKeyword) return true;
      return [
        source.repo_name,
        source.repo_url,
        source.branch,
        source.code_graph_id,
        source.owner_user_id ?? '',
        source.commit_hash ?? '',
      ].some((value) => value.toLowerCase().includes(normalizedKeyword));
    });
  }, [scopeSources, keyword, statusFilter]);

  // Detail: search & explore
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState('');
  const [exploreQuery, setExploreQuery] = useState('');
  const [exploring, setExploring] = useState(false);
  const [exploreResult, setExploreResult] = useState('');

  // Request sequence number to prevent races: when switching tabs quickly, an earlier request may return later,
  // and the old tab's data would overwrite the new tab's. Each fetch increments the sequence number,
  // and on response we check that it's still the latest; if not, discard it.
  const fetchSeqRef = useRef(0);

  const fetchSources = useCallback(async () => {
    if (!activeTeamId) {
      setSources([]);
      setLoading(false);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    // Clear old data immediately; otherwise when switching tabs the previous tab's list shows first
    // and is suddenly replaced when new data arrives, which visually looks like a "flash".
    setSources([]);
    try {
      // Assets are uniformly team-scoped (visibility=team); there is no private/my-assets concept.
      // The fixed tab also fetches all team assets, then filters by fixedBoundIds.
      const data = await knowledgeApi.code.teamAssets(activeTeamId);
      if (seq !== fetchSeqRef.current) return; // superseded by a later request
      setSources(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      if (seq !== fetchSeqRef.current) return;
      tea.notify.error(e);
      setSources([]);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [activeTeamId, scopeTab]);

  // Trigger fetchSources: depends on the raw params + fetchSources, with a key to dedupe repeated triggers in a short window.
  const fetchKeyRef = useRef<string>('');
  useEffect(() => {
    const key = `${activeTeamId}|${scopeTab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void fetchSources();
  }, [activeTeamId, scopeTab, fetchSources]);

  // Ref mirror of inFlight: the poll closure reads the latest value through the ref,
  // avoiding putting inFlight in the effect deps; otherwise every setInFlight (even with unchanged content,
  // just a new array reference) would re-trigger the effect -> immediate poll -> setInFlight again -> infinite loop.
  const inFlightRef = useRef<CodeGraphDetail[]>([]);
  inFlightRef.current = inFlight;
  const hasInFlight = inFlight.length > 0;

  useEffect(() => {
    if (!activeTeamId || !hasInFlight) return;
    const poll = async () => {
      const items = inFlightRef.current;
      if (items.length === 0) return;
      const toRemove: string[] = [];
      const updates: CodeGraphDetail[] = [];
      for (const item of items) {
        if (!item.code_graph_id) continue;
        try {
          const detail = await knowledgeApi.code.get(item.code_graph_id);
          if (detail.status === 'ready') {
            try {
              await knowledgeApi.code.registerMeta(activeTeamId, detail.code_graph_id);
            } catch (e: unknown) {
              // Idempotent: asset already exists / 409 -> ignore; other real errors are surfaced for troubleshooting
              // (the callback S2S is the primary path, this is only a fallback, but failures must be visible)
              const msg = e instanceof Error ? e.message : String(e);
              if (!/already|exist|409|registered|ok/i.test(msg)) {
                tea.notify.error(t('code.notify.metaFailed', { msg }));
              }
            }
            toRemove.push(detail.code_graph_id);
            void fetchSources();
          } else {
            // Only record an update when the status actually changes, to avoid pointless setInFlight re-renders
            if (detail.status !== item.status) updates.push(detail);
          }
        } catch {
          /* ignore transient poll errors */
        }
      }
      if (toRemove.length > 0 || updates.length > 0) {
        setInFlight((prev) => {
          let next = prev;
          if (toRemove.length > 0) {
            const removeSet = new Set(toRemove);
            next = next.filter((x) => !removeSet.has(x.code_graph_id));
          }
          if (updates.length > 0) {
            const updMap = new Map(updates.map((u) => [u.code_graph_id, u]));
            next = next.map((x) => updMap.get(x.code_graph_id) ?? x);
          }
          return next;
        });
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 8000);
    return () => clearInterval(timer);
  }, [hasInFlight, activeTeamId, fetchSources, t]);

  async function handleUnbindCode(codeGraphId: string) {
    if (!agentFilter) return;
    const ok = await tea.confirm({
      message: t('code.confirm.unbind'),
      description: t('code.confirm.unbind.desc'),
      okText: t('code.confirm.unbind.ok'),
    });
    if (!ok) return;
    try {
      await knowledgeApi.code.unbind(codeGraphId, agentFilter);
      tea.notify.success(t('code.notify.unbound'));
      if (selectedCodeAsset?.cgId === codeGraphId) setSelectedCodeAsset(null);
      await fetchFixedBindings();
      await fetchSources();
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('code.notify.unbindFailed'));
    }
  }

  /**
   * Load the source list when the register dialog opens. Fails silently with degradation (the form falls back to public repos only).
   *
   * We no longer query "sources configured by the current user": credentials are attached to the **resource**, and before registration there is no resource_id,
   * so that concept no longer holds; if registration fails, the user can reconfigure the specific resource from the list page.
   */
  const openRegister = useCallback(async () => {
    setShowRegister(true);
    // 每次打开注册弹窗都清掉上一次的 SSH 公钥态，避免残留旧公钥误导用户。
    setShowSshKey(false);
    setSshPublicKey('');
    if (!activeTeamId) return;
    try {
      const providers = await knowledgeApi.source.providers(activeTeamId);
      setSourceProviders(providers);
    } catch {
      setSourceProviders([]);
    }
  }, [activeTeamId]);

  /**
   * 注册 = 两段式（仅 SSH 仓库需要两段）：
   *
   *   第 1 段 ensureSshKey：向后端取（必要时生成）该用户的公钥，弹窗展示给用户，
   *                        用户去 Git 平台配好后再进入第 2 段。
   *   第 2 段 submitCreate：真正 create 建图。
   *
   * 这样设计的原因：若一步到位直接 create，用户此刻还没配公钥，
   * clone 必定失败并在列表里留一条 failed 记录，体验很差。
   */
  const ensureSshKey = async (): Promise<void> => {
    if (!activeTeamId) return;
    setSubmitting(true);
    try {
      const info = await knowledgeApi.code.sshKeyEnsure(activeTeamId);
      setSshPublicKey(info.public_key);
      setShowSshKey(true);
    } catch (e: unknown) {
      tea.notify.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const submitCreate = async (): Promise<void> => {
    const repo = formRepo.trim();
    if (!repo || !formBranch.trim() || !activeTeamId) return;
    if (!isValidGitUrl(repo)) {
      tea.notify.error(t('code.register.invalidUrl'));
      return;
    }
    const isSsh = isSshGitUrl(repo);
    // Private repo (HTTPS platform): validate required fields per provider.form_fields.
    // SSH source has empty form_fields → token validation is naturally skipped.
    const provider = sourceProviders.find((p) => p.id === formSourceType);
    if (provider && !isSsh) {
      for (const f of provider.form_fields) {
        if (f.required && !(formCredential[f.name] ?? '').trim()) {
          tea.notify.error(t('code.register.tokenRequired'));
          return;
        }
      }
    }
    setSubmitting(true);
    try {
      // Private repo: pass the credentials along at create time, so KS persists them before enqueuing the graph build,
      // avoiding the race window of "create clones immediately, credentials not yet written" (otherwise private repos always 401).
      // SSH sources send no secret (the backend doesn't require one for that provider), only provider_id to indicate SSH.
      const secret = (formCredential.secret ?? '').trim();
      const username = (formCredential.username ?? '').trim();
      const detail = await knowledgeApi.code.create({
        teamId: activeTeamId,
        repoUrl: repo,
        branch: formBranch.trim(),
        repoName: repo,
        ...(isSsh
          ? { providerId: SSH_SOURCE_ID }
          : provider && secret
            ? {
                providerId: formSourceType,
                secret,
                ...(username ? { username } : {}),
              }
            : {}),
      });

      setShowRegister(false);
      setShowSshKey(false);
      setSshPublicKey('');
      setFormRepo('');
      setFormBranch('main');
      setFormSourceType('');
      setFormCredential({});
      setScopeTab('team');
      setInFlight((prev) => [
        ...prev.filter((x) => x.code_graph_id !== detail.code_graph_id),
        detail,
      ]);
      tea.notify.info(t('code.notify.registered'));
      fetchSources();
    } catch (e: unknown) {
      tea.notify.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegister = async () => {
    const repo = formRepo.trim();
    if (!repo || !formBranch.trim() || !activeTeamId) return;
    if (!isValidGitUrl(repo)) {
      tea.notify.error(t('code.register.invalidUrl'));
      return;
    }
    // SSH 仓库：先取公钥给用户去平台配置，用户点「已配置，继续」后才真正建图。
    if (isSshGitUrl(repo)) {
      await ensureSshKey();
      return;
    }
    await submitCreate();
  };

  const handleSync = async (cgId: string) => {
    try {
      await knowledgeApi.code.sync(cgId);
      // sync is async; 202 only means it's been enqueued. Put the repo back into inFlight (consistent with handleRegister),
      // and let the GET polling above run until status returns to ready; otherwise we'd only fetch one teamAssets snapshot
      // and the detail header would stay stuck at "Building" from that moment.
      const current =
        sources.find((s) => s.code_graph_id === cgId) ??
        inFlightRef.current.find((x) => x.code_graph_id === cgId);
      if (current) {
        setInFlight((prev) => [
          ...prev.filter((x) => x.code_graph_id !== cgId),
          { ...current, status: 'processing' },
        ]);
      }
      void fetchSources();
    } catch (e: unknown) {
      tea.notify.error(e);
    }
  };

  const handleDelete = async (cgId: string) => {
    const source = sources.find((s) => s.code_graph_id === cgId);
    if (!source) return;
    const ok = await tea.confirm({
      message: t('code.confirm.delete', {
        name: formatRepoName(source.repo_name, source.repo_url),
        branch: source.branch,
      }),
      okText: t('code.action.delete'),
    });
    if (!ok) return;
    try {
      await knowledgeApi.code.delete(cgId);
      // Optimistic update: remove from the local list immediately. Backend deletion is eventually consistent; refetching teamAssets right after
      // a successful delete may still return the repo, leaving the list unchanged until a manual page refresh. So remove it locally first,
      // and fetchSources only serves as a fallback reconciliation.
      setSources((prev) => prev.filter((x) => x.code_graph_id !== cgId));
      setInFlight((prev) => prev.filter((x) => x.code_graph_id !== cgId));
      if (selectedCodeAsset?.cgId === cgId) setSelectedCodeAsset(null);
      if (selectedCgId === cgId) setSubView('list');
      tea.notify.success(t('code.notify.deleted'));
      fetchSources();
    } catch (e: unknown) {
      tea.notify.error(e);
    }
  };

  const openDetail = (cgId: string) => {
    setSelectedCgId(cgId);
    setSearchQuery('');
    setSearchResult('');
    setExploreQuery('');
    setExploreResult('');
    setSubView('detail');
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchResult('');
    try {
      const res = await knowledgeApi.code.search({ codeGraphId: selectedCgId, query: searchQuery, kind: 'any', limit: 20 });
      setSearchResult(res?.text || JSON.stringify(res, null, 2));
    } catch (e: unknown) {
      setSearchResult('');
      tea.notify.error(e);
    } finally {
      setSearching(false);
    }
  };

  const handleExplore = async () => {
    if (!exploreQuery.trim()) return;
    setExploring(true);
    setExploreResult('');
    try {
      const res = await knowledgeApi.code.explore(selectedCgId, exploreQuery);
      setExploreResult(res?.text || JSON.stringify(res, null, 2));
    } catch (e: unknown) {
      setExploreResult('');
      tea.notify.error(e);
    } finally {
      setExploring(false);
    }
  };

  const selected = displaySources.find((source) => source.code_graph_id === selectedCgId);

  return {
    // context
    activeTeam,
    activeTeamId,
    currentUser,
    teamAgents,
    // list view
    sources,
    displaySources,
    loading,
    scopeTab,
    setScopeTab,
    keyword,
    setKeyword,
    statusFilter,
    setStatusFilter,
    viewMode,
    setViewMode,
    inFlight,
    setInFlight,
    subView,
    setSubView,
    selectedCgId,
    setSelectedCgId,
    // register
    showRegister,
    setShowRegister,
    formRepo,
    setFormRepo,
    formBranch,
    setFormBranch,
    submitting,
    setSubmitting,
    // External source
    formSourceType,
    setFormSourceType,
    sourceProviders,
    formCredential,
    setCredentialField,
    setFormCredential,
    openRegister,
    // SSH 两段式
    sshPublicKey,
    setSshPublicKey,
    showSshKey,
    setShowSshKey,
    submitCreate,
    // allocate
    allocateTarget,
    setAllocateTarget,
    selectedCodeAsset,
    setSelectedCodeAsset,
    agentFilter,
    setAgentFilter,
    // detail
    searchQuery,
    setSearchQuery,
    searching,
    searchResult,
    setSearchResult,
    exploreQuery,
    setExploreQuery,
    exploring,
    exploreResult,
    setExploreResult,
    selected,
    // fetch & handlers
    fetchSources,
    fetchFixedBindings,
    handleUnbindCode,
    handleRegister,
    handleSync,
    handleDelete,
    openDetail,
    handleSearch,
    handleExplore,
    // computed
    scopeSources,
    stats,
    filteredSources,
  };
}

export type CodeSourcesStore = ReturnType<typeof useCodeSources>;
