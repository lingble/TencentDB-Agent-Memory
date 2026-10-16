/**
 * useChatMemory - all state and data logic for the Chat Memory page.
 * The component layer keeps only JSX rendering; state / data logic is centralized here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgents, useTeams } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea, confirmThenRun } from '@/lib/tea-bridge';
import { chatMemoryApi, type ChatMemoryBlock, type ChatMemorySearchHit } from '@/lib/teamApi';
import { type MemoryBlock, type MemoryLayer, type ScopeTab } from '../constants/types';
import { useScopeTabLabels } from '../constants/constants';
import {
  buildInitialLayerCounts,
  defaultTimeRange,
  isRangeTooLargeError,
  layerPageSize,
  mapLayerItem,
  type TimeRange,
} from '../utils/memory-utils';
import { getLayerCount } from '../utils/utils';

export function useChatMemory(props: { activeTeamId?: string | null } = {}) {
  const { t } = useTranslation();
  const scopeTabLabels = useScopeTabLabels();
  const auth = readAuth();
  const { activeTeamId: storeActiveTeamId, activeTeam } = useTeams();
  const currentUserId = auth?.user_id ?? '';
  const activeTeamId = props.activeTeamId ?? storeActiveTeamId;
  const { agents: teamAgents } = useAgents(activeTeamId);
  const ownedTeamAgents = useMemo(
    () => teamAgents.filter((a) => a.owner_user_id === currentUserId),
    [teamAgents, currentUserId],
  );

  const [blocks, setBlocks] = useState<MemoryBlock[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layer, setLayer] = useState<MemoryLayer>('L1');
  const [layerPages, setLayerPages] = useState<
    Record<string, Partial<Record<MemoryLayer, number>>>
  >({});
  // Total count per layer "within the current time window" (key: `${blockId}|${layer}`).
  // layerCounts holds the overall totals (fetched with limit=1 when a block is selected); with a time filter (L0/L1)
  // the BFF's res.total is the in-window count. Pagination must use it, otherwise the page count is inflated.
  const [windowTotals, setWindowTotals] = useState<
    Record<string, Partial<Record<MemoryLayer, number>>>
  >({});
  const [layerLoading, setLayerLoading] = useState(false);
  const [layerItemLoadingId, setLayerItemLoadingId] = useState<string | null>(null);
  // Manual refresh counter: incrementing it re-triggers loading of the current layer and the four-layer count fetch (effect-dependency driven).
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Detail-view time filter (applies to L0 / L1 only), defaults to "previous day ~ now"
  const [timeRange, setTimeRange] = useState<TimeRange>(() => defaultTimeRange());
  // true when the backend detects the filter range is too large; BlockDetail shows a hint instead of the empty state
  const [rangeTooLarge, setRangeTooLarge] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAllocate, setShowAllocate] = useState(false);
  // Show Agent assets (fixed) by default, so users don't think their own assets live under "Team assets"
  const [scopeTab, setScopeTab] = useState<ScopeTab>('fixed');
  const [agentFilter, setAgentFilter] = useState<string>('');

  useEffect(() => {
    if (ownedTeamAgents.length === 0) {
      setAgentFilter('');
      return;
    }
    if (!agentFilter || !ownedTeamAgents.some((a) => a.agent_id === agentFilter)) {
      setAgentFilter(ownedTeamAgents[0].agent_id);
    }
  }, [ownedTeamAgents, agentFilter]);

  // ── Data loading ──
  // Request sequence number against races: when switching tabs quickly, an earlier request may return later,
  // and old-tab data would overwrite new-tab data. Each fetch increments the sequence number;
  // when the response arrives, check whether it is still the latest, and discard it if not.
  const fetchSeqRef = useRef(0);
  // The team of the previous fetch, used to distinguish "switch team" from "switch tab / switch agent".
  // Switching team refreshes silently (keep the old list until new data arrives), no blanking or skeleton;
  // switching tab / agent still clears + shows loading as before.
  const prevTeamIdRef = useRef(activeTeamId);
  // Cap on consecutive L0 "auto-expand time range" steps: when the window reaches its earliest record, expand back 24h automatically,
  // until the backend confirms the block has no earlier records either (reload returns empty -> l0Ended is set).
  // This counter is an extreme fallback (prevents infinite loops in abnormal cases); it resets when the user adjusts the filter, since the component remounts.
  const l0AutoExpandCountRef = useRef(0);

  const fetchBlocks = useCallback(async () => {
    if (!activeTeamId) {
      setBlocks([]);
      setBlocksLoading(false);
      return;
    }
    // When the fixed tab has no agent selected, don't send a request, but make sure loading is turned off
    if (scopeTab === 'fixed' && !agentFilter) {
      setBlocks([]);
      setBlocksLoading(false);
      return;
    }
    const seq = ++fetchSeqRef.current;
    // Switching team refreshes silently (keep the old list until new data arrives), no blanking or skeleton;
    // switching tab / agent still clears + shows loading.
    const teamChanged = prevTeamIdRef.current !== activeTeamId;
    prevTeamIdRef.current = activeTeamId;
    if (!teamChanged) {
      setBlocksLoading(true);
      // Clear old data immediately - otherwise when switching tabs you first see the previous tab's list,
      // which is suddenly replaced once new data arrives, visually a "flash".
      setBlocks([]);
    }
    try {
      let res: { items: ChatMemoryBlock[]; total?: number };
      if (scopeTab === 'fixed') {
        res = await chatMemoryApi.agentFixed(agentFilter);
      } else {
        res = await chatMemoryApi.teamAssets(activeTeamId);
      }
      if (seq !== fetchSeqRef.current) return; // superseded by a later request
      const mapped: MemoryBlock[] = res.items.map((b) => ({
        id: b.id,
        title: b.title,
        summary: b.summary ?? '',
        tags: [],
        updated_at_ms: b.updated_at_ms,
        agent_id: b.agent_id ?? undefined,
        uploaded_by_user_id: b.uploaded_by_user_id,
        scope: b.scope,
        layer_counts: b.layer_counts,
        bound_agent_count: b.bound_agent_count,
        layers: { L0: [], L1: [], L2: [], L3: [] },
        // Initially fill only the **real** counts (>0) returned by the backend; layers that are 0 / not yet persisted stay undefined = "unknown".
        // Badges for unknown layers show a placeholder; the real count is requested on demand when the user switches to that layer tab,
        // avoiding pinging the other 3 layers just by selecting a block (pure prefetching of things the user hasn't looked at).
        layerCounts: buildInitialLayerCounts(b.layer_counts),
      }));
      setBlocks(mapped);
    } catch (e: unknown) {
      if (seq !== fetchSeqRef.current) return;
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.loadFailed'));
      setBlocks([]);
    } finally {
      if (seq === fetchSeqRef.current) setBlocksLoading(false);
    }
    // Note: setSelectedId is no longer called here - previously fetchBlocks' useCallback depended
    // on selectedId, causing the whole list to be re-fetched every time a block was selected (the main cause of lag).
    // Default selection is now handled by the separate effect below.
  }, [activeTeamId, scopeTab, agentFilter, t]);

  // Trigger fetchBlocks: depends on the raw params + fetchBlocks, deduplicated by key to avoid repeated triggers in a short time.
  // Previously, a plain `useEffect(() => fetchBlocks(), [fetchBlocks])` fired multiple times as the fetchBlocks reference changed
  // (agentFilter and other deps sync asynchronously), causing the same endpoint to be requested repeatedly.
  const fetchKeyRef = useRef<string>('');
  useEffect(() => {
    // Only the fixed tab fetches by agentFilter; the team tab's data source (teamAssets) is independent of the selected
    // agent. If agentFilter were part of the team key, after ownedTeamAgents loads asynchronously
    // agentFilter changes from '' to the first agent, changing the key and triggering a **fully duplicate**
    // teamAssets request (one extra call on entering the page).
    const key =
      scopeTab === 'fixed'
        ? `${activeTeamId}|${scopeTab}|${agentFilter}`
        : `${activeTeamId}|${scopeTab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void fetchBlocks();
  }, [activeTeamId, scopeTab, agentFilter, fetchBlocks]);

  // After the list changes, clear the selection only if the selected block is no longer in the list.
  // Don't auto-select the first item on page entry (consistent with skill behavior); details load after the user clicks.
  useEffect(() => {
    if (selectedId && !blocks.some((b) => b.id === selectedId)) {
      setSelectedId(null);
    }
  }, [blocks, selectedId]);

  // ── Layer pagination ──
  const selected = useMemo(
    () => (selectedId ? (blocks.find((b) => b.id === selectedId) ?? null) : null),
    [selectedId, blocks],
  );
  const layerPage = selected?.id ? (layerPages[selected.id]?.[layer] ?? 0) : 0;
  const pageSize = layerPageSize(layer);
  /** Total count of the current layer "within the current time window"; falls back to the overall total when no window cache exists (L2/L3 always equal the overall total) */
  const windowTotal = selected?.id
    ? (windowTotals[selected.id]?.[layer] ?? getLayerCount(selected, layer))
    : 0;

  // ── Layer counts: fetch all four layer counts in parallel when a block is selected ──
  // Confirmed by business: layer_counts returned by teamAssets / agentFixed / myAgents are unreliable,
  // so the L0/L1/L2/L3 layer endpoints must be called for the selected block to get accurate counts.
  // This was removed during an earlier API optimization, which made badge counts wrong.
  const layerCountSeqRef = useRef(0);
  // Track the last handled refreshNonce, to distinguish "selected block changed" from "manual refresh":
  // only on manual refresh (nonce changed) is the layerCounts cache ignored and all four counts force-refetched.
  const layerCountNonceRef = useRef(refreshNonce);
  useEffect(() => {
    if (!selected?.id) return;
    const blockId = selected.id;
    const seq = ++layerCountSeqRef.current;
    const forceRefresh = layerCountNonceRef.current !== refreshNonce;
    layerCountNonceRef.current = refreshNonce;

    const layers: MemoryLayer[] = ['L0', 'L1', 'L2', 'L3'];
    layers.forEach((l) => {
      // Don't re-request layers that already have a real count; force refetch on manual refresh.
      if (!forceRefresh && selected.layerCounts[l] !== undefined) return;

      chatMemoryApi
        .layer(blockId, l, 1, 0)
        .then((res) => {
          if (seq !== layerCountSeqRef.current) return; // superseded by a later selection
          setBlocks((prev) =>
            prev.map((b) =>
              b.id === blockId ? { ...b, layerCounts: { ...b.layerCounts, [l]: res.total } } : b,
            ),
          );
        })
        .catch(() => {
          // A single layer's count failure doesn't block other layers; ignore silently
        });
    });
  }, [selected?.id, refreshNonce]);

  // When switching blocks, reset the time filter to the default "previous day ~ now" (confirmed by business: reset on every open)
  useEffect(() => {
    setTimeRange(defaultTimeRange());
    setRangeTooLarge(false);
  }, [selected?.id]);

  // When the block / time range changes, the in-window total cache is invalidated (paging and totals must be recomputed for the new window)
  useEffect(() => {
    setWindowTotals({});
  }, [selected?.id, timeRange.start, timeRange.end]);

  useEffect(() => {
    if (!selected?.id) {
      setLayerLoading(false);
      return;
    }
    let cancelled = false;
    setLayerLoading(true);
    // Time filter applies to L0 / L1 only; L2 / L3 are aggregated outputs, no time params passed
    const useTimeFilter = layer === 'L0' || layer === 'L1';
    const timeStart = useTimeFilter ? timeRange.start || undefined : undefined;
    const timeEnd = useTimeFilter ? timeRange.end || undefined : undefined;
    chatMemoryApi
      .layer(
        selected.id,
        layer,
        pageSize,
        layerPage * pageSize,
        undefined,
        undefined,
        timeStart,
        timeEnd,
      )
      .then((res) => {
        if (cancelled) return;
        setRangeTooLarge(false);
        // With a time filter, res.total is the count "within the current time window"; store it separately for pagination
        // (layerCounts is still the overall total and must not be touched). L2/L3 have no time dimension, window total = overall total.
        setWindowTotals((prev) => ({
          ...prev,
          [selected.id]: { ...(prev[selected.id] ?? {}), [layer]: res.total },
        }));
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== selected.id) return b;
            const updated = {
              ...b,
              layers: { ...b.layers },
              // Note: with a time-range query, res.total is the count "within the range", not the overall total.
              // The overall total was already fetched with a limit=1 request when the block was selected and stored in layerCounts;
              // it must not be overwritten here, otherwise the badge count / L0 load-more check will be wrong.
              // Only sync the overall total when there's no time filter (L2/L3, or L0/L1 after clearing the time range).
              ...(!useTimeFilter
                ? { layerCounts: { ...b.layerCounts, [layer]: res.total } }
                : {}),
            };
            if (res.layer === 'L0') {
              updated.layers.L0 = res.items;
              // On first-screen load / reload after a time-filter change: records in window -> reset "reached earliest",
              // no records -> set it (the block has no data in earlier time either, so auto-expansion stops here).
              // This is the convergence condition for auto-expanding the time range, avoiding infinite backward expansion.
              updated.l0Ended = res.items.length === 0;
            } else if (res.layer === 'L1') updated.layers.L1 = res.items.map(mapLayerItem);
            else if (res.layer === 'L2') updated.layers.L2 = res.items.map(mapLayerItem);
            else if (res.layer === 'L3') updated.layers.L3 = res.items.map(mapLayerItem);
            return updated;
          }),
        );
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Range too large: don't show an error toast; let BlockDetail render the "too many memories" guidance
        if (isRangeTooLargeError(e)) {
          setRangeTooLarge(true);
          return;
        }
        tea.notify.error(e instanceof Error ? e.message : t('memory.notify.layerFailed'));
      })
      .finally(() => {
        if (!cancelled) setLayerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, layer, layerPage, pageSize, timeRange.start, timeRange.end, refreshNonce, t]);

  const handleLayerPageChange = useCallback(
    (nextPage: number) => {
      if (!selected?.id) return;
      setLayerPages((prev) => ({
        ...prev,
        [selected.id]: { ...(prev[selected.id] ?? {}), [layer]: Math.max(0, nextPage) },
      }));
    },
    [selected?.id, layer],
  );

  // ── L0 load more (triggered by pull / scroll to top) ──
  // L0 always consumes page 0 (the newest batch); "load more" uses the last message's timestamp as a cursor
  // (before_ts) to request older messages, instead of using the array length as offset.
  // Reason: VDB's scan+skip on large offsets is expensive; filtering by timestamp reduces the query from O(offset+limit)
  // to O(limit). The array keeps the backend's newest->oldest order; the render layer reverses it to oldest->newest, so appended items appear at the top.
  const [l0MoreLoading, setL0MoreLoading] = useState(false);
  const handleL0LoadMore = useCallback(async () => {
    if (!selected?.id || layer !== 'L0' || l0MoreLoading) return;
    const items = selected.layers.L0;
    const total = selected.layerCounts.L0 ?? items.length;
    // Already confirmed earliest within the current time window: send no more requests (belt and braces; normally BlockDetail hides the entry)
    if (selected.l0Ended) return;
    if (items.length >= total) return;
    // Cursor: array is newest->oldest, the last item is the oldest loaded message
    const lastItem = items[items.length - 1];
    const beforeTs = lastItem?.created_at;
    setL0MoreLoading(true);
    try {
      // When beforeTs is set, offset is 0 (backend filters by time_end); first screen without beforeTs uses offset=0.
      // Pass through the timeStart lower bound: loading older messages must not exceed the user's filter range, consistent with the first screen.
      const timeStart = timeRange.start || undefined;
      const res = await chatMemoryApi.layer(
        selected.id,
        'L0',
        pageSize,
        0,
        undefined,
        beforeTs,
        timeStart,
      );
      const noMore = res.items.length === 0;
      setBlocks((prev) =>
        prev.map((b) => {
          if (b.id !== selected.id) return b;
          // Defensive dedup: don't render the same message twice when pages overlap due to concurrency/refresh
          const existing = new Set(b.layers.L0.map((m) => m.id));
          const more = res.items.filter((m) => !existing.has(m.id));
          // Note: under cursor pagination the backend's total is the filtered remaining count (time_end < beforeTs),
          // not the overall total. Keep the overall total from the first screen to avoid the illusion of "total shrinking after load more".
          return {
            ...b,
            layers: { ...b.layers, L0: [...b.layers.L0, ...more] },
            // Nothing new this time (empty after dedup) = reached earliest within the current window; set flag to hide the "load earlier" entry
            l0Ended: b.l0Ended || more.length === 0,
          };
        }),
      );
      // Reached earliest in window -> auto-expand the time range backward (24h earlier), triggering an L0 reload,
      // so users can keep seeing older memories without manually changing the filter (design intent: the time filter should not
      // hinder browsing history). If still no data after reload, the effect sets l0Ended to stop expanding.
      // count is only an extreme fallback against infinite loops; the normal path converges via "empty after expansion -> l0Ended".
      if (noMore && timeRange.start && l0AutoExpandCountRef.current < 30) {
        l0AutoExpandCountRef.current += 1;
        const newStart = new Date(new Date(timeRange.start).getTime() - 24 * 60 * 60 * 1000);
        setL0MoreLoading(false);
        setTimeRange((prev) => ({ ...prev, start: newStart.toISOString() }));
        return;
      }
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.layerFailed'));
    } finally {
      setL0MoreLoading(false);
    }
  }, [selected, layer, l0MoreLoading, pageSize, timeRange.start, t]);

  const handleLayerItemLoad = useCallback(
    async (itemId: string) => {
      if (!selected?.id || layer !== 'L2') return;
      const current = selected.layers.L2.find((item) => item.id === itemId);
      if (!current) return;
      if (current.body.trim()) {
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== selected.id) return b;
            return {
              ...b,
              layers: {
                ...b.layers,
                L2: b.layers.L2.map((item) =>
                  item.id === itemId ? { ...item, body: '', tags: [] } : item,
                ),
              },
            };
          }),
        );
        return;
      }
      setLayerItemLoadingId(itemId);
      try {
        const res = await chatMemoryApi.layer(selected.id, 'L2', 1, 0, itemId);
        const loaded = res.items[0] ? mapLayerItem(res.items[0]) : null;
        if (!loaded) return;
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== selected.id) return b;
            return {
              ...b,
              layers: {
                ...b.layers,
                L2: b.layers.L2.map((item) => (item.id === itemId ? { ...item, ...loaded } : item)),
              },
            };
          }),
        );
      } catch (e: unknown) {
        tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.l2Failed'));
      } finally {
        setLayerItemLoadingId(null);
      }
    },
    [selected?.id, selected?.layers.L2, layer, t],
  );

  // ── Edit: save a single layer's content (Owner-only; on success, optimistically update the entry body) ──
  // L1 = overwrite content; L2 = overwrite the whole scenario body (BFF strips META before writing, kernel rebuilds META);
  // L3 = overwrite the whole core persona. Throws on failure, letting the caller (edit dialog) keep the input and show a hint.
  const handleSaveLayerItem = useCallback(
    async (targetLayer: 'L1' | 'L2' | 'L3', itemId: string, content: string) => {
      if (!selected?.id) return;
      await chatMemoryApi.updateLayer(selected.id, targetLayer, {
        id: itemId,
        content,
      });
      setBlocks((prev) =>
        prev.map((b) => {
          if (b.id !== selected.id) return b;
          return {
            ...b,
            layers: {
              ...b.layers,
              [targetLayer]: b.layers[targetLayer].map((item) =>
                item.id === itemId ? { ...item, body: content } : item,
              ),
            },
          };
        }),
      );
      tea.notify.success(t('memory.notify.editSuccess'));
    },
    [selected?.id, t],
  );

  // ── Search: L0 (conversation) / L1 (atomic memory) semantic / keyword retrieval ──
  // Cross-session recall, returning scored hits; result state is managed by BlockDetail,
  // this only provides the request function (depends on the currently selected block).
  const searchLayer = useCallback(
    async (targetLayer: 'L0' | 'L1', query: string): Promise<ChatMemorySearchHit[]> => {
      if (!selected?.id) return [];
      const res = await chatMemoryApi.searchLayer(selected.id, targetLayer, query, 30);
      return res.items ?? [];
    },
    [selected?.id],
  );

  // ── Filtering and helpers ──
  const filtered = useMemo(() => {
    if (scopeTab === 'fixed')
      return agentFilter ? blocks.filter((b) => b.agent_id === agentFilter) : [];
    return blocks;
  }, [blocks, scopeTab, agentFilter]);

  function agentLabel(id?: string): string {
    if (!id) return '';
    const a = teamAgents.find((x) => x.agent_id === id);
    return a ? a.name : id;
  }

  function selfChatMemoryAgentId(b: MemoryBlock): string | undefined {
    if (!activeTeamId) return undefined;
    const prefix = `chat_memory-${activeTeamId}-`;
    if (b.id.startsWith(prefix)) return b.id.slice(prefix.length) || undefined;
    return b.agent_id;
  }

  function isSelfChatMemory(b: MemoryBlock): boolean {
    // It counts as self only when "this chat_memory is the own memory of the **agent currently being viewed**" - unbinding not allowed.
    // Previous bug: any asset named `chat_memory-{team}-{agentX}` was judged as self,
    // so after another agent's memory was borrowed into the current agent (e.g. test3 borrowed test-bugfix's),
    // it was also misjudged as self, and the "unbind" button never showed.
    // Under the fixed tab, agentFilter is the current agent; team/personal tabs don't involve "unbind" semantics,
    // so keep the original prefix check as a fallback.
    if (!activeTeamId) return false;
    if (scopeTab === 'fixed' && agentFilter) {
      return b.id === `chat_memory-${activeTeamId}-${agentFilter}`;
    }
    const ownerAgentId = selfChatMemoryAgentId(b);
    return !!ownerAgentId && b.id === `chat_memory-${activeTeamId}-${ownerAgentId}`;
  }

  function allocatableAgents(b: MemoryBlock) {
    // Doc §4.5 allocate permission rules:
    //   1. agent.owner = me (can only allocate to agents you own, otherwise 403 NOT_YOUR_AGENT)
    //   3. an agent's own chat_memory can't be allocated to itself
    // So the data source is ownedTeamAgents, excluding the block's own agent.
    const ownerAgentId = selfChatMemoryAgentId(b);
    return ownedTeamAgents
      .filter((a) => a.agent_id !== ownerAgentId)
      .map((a) => ({ agent_id: a.agent_id, name: a.name }));
  }

  // ── Actions ──
  async function handleDeleteBlock(id: string) {
    const block = blocks.find((b) => b.id === id);
    const teamId = activeTeamId;
    const agentId = block?.agent_id;
    if (!teamId || !agentId) return;
    await confirmThenRun(
      {
        message: t('memory.confirm.unbind'),
        description: t('memory.confirm.unbind.desc'),
        okText: t('memory.confirm.unbind.ok'),
      },
      async () => {
        await chatMemoryApi.unbind(teamId, id, agentId);
        setBlocks((prev) => prev.filter((b) => b.id !== id));
        if (selectedId === id) setSelectedId(null);
        tea.notify.success(t('memory.notify.unbound'));
      },
      (e) => tea.notify.error((e as Error)?.message || t('memory.notify.unbindFailed')),
    );
  }

  async function handleImport({
    agent_id,
    messages,
  }: {
    agent_id: string;
    messages: Array<{ role: string; content: string }>;
  }) {
    try {
      if (!activeTeamId || !agent_id) {
        tea.notify.warning(t('memory.notify.selectAgent'));
        return;
      }
      await chatMemoryApi.import({ teamId: activeTeamId, agentId: agent_id, messages });
      tea.notify.success(t('memory.notify.importSuccess', { count: messages.length }));
      setShowImport(false);
      fetchBlocks();
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.importFailed'));
    }
  }

  // Shared/private toggle: originally unique to the personal tab; after removing the personal tab it moved to
  // asset items in the "Agent assets (fixed)" tab (only the owner can toggle, see ChatMemoryPanel rendering).
  async function handleToggleScope(block: MemoryBlock, newScope: 'team' | 'private') {
    if (block.scope === newScope) return;
    // Confirm before switching to private: other agents that have borrowed this memory will no longer be able to use it.
    // The message is just for awareness and doesn't list affected agents (the kernel doesn't prune proactively, so no exact count is needed).
    if (newScope === 'private') {
      const ok = await tea.confirm({
        message: t('memory.confirm.private'),
        description: t('memory.confirm.private.desc'),
        okText: t('memory.confirm.private.ok'),
      });
      if (!ok) return;
    }
    try {
      await chatMemoryApi.patchScope(block.id, newScope);
      tea.notify.success(
        newScope === 'team' ? t('memory.notify.scopeTeam') : t('memory.notify.scopePrivate'),
      );
      fetchBlocks();
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.scopeFailed'));
    }
  }

  // Manual refresh of the current layer of the selected block: invalidate the window-total cache and increment the nonce,
  // triggering the main load effect to refetch the current layer and the four-layer count effect to force-refetch counts.
  const refreshLayer = useCallback(() => {
    if (!selected?.id) return;
    // Invalidate the current block's window-total cache (windowTotal falls back to the overall total until the main load effect refills it)
    setWindowTotals((prev) => {
      if (!(selected.id in prev)) return prev;
      const next = { ...prev };
      delete next[selected.id];
      return next;
    });
    // On refresh, reset the time filter to "now ~ previous day": otherwise newly written L0/L1 memories would
    // be filtered out because timeRange.end stays at page-load time, showing up as "refresh doesn't show new data".
    setTimeRange(defaultTimeRange());
    setRangeTooLarge(false);
    // Increment nonce: triggers the main load effect (refetch current layer data) and the four-layer count effect (force-refetch counts)
    setRefreshNonce((n) => n + 1);
  }, [selected?.id]);

  return {
    // context
    activeTeam,
    activeTeamId,
    currentUserId,
    ownedTeamAgents,
    teamAgents,
    scopeTabLabels,
    // state
    blocks,
    blocksLoading,
    selectedId,
    setSelectedId,
    layer,
    setLayer,
    layerPages,
    layerLoading,
    layerItemLoadingId,
    l0MoreLoading,
    timeRange,
    setTimeRange,
    rangeTooLarge,
    showImport,
    setShowImport,
    showAllocate,
    setShowAllocate,
    scopeTab,
    setScopeTab,
    agentFilter,
    setAgentFilter,
    // computed
    selected,
    layerPage,
    pageSize,
    windowTotal,
    filtered,
    // handlers
    fetchBlocks,
    refreshLayer,
    handleLayerPageChange,
    handleL0LoadMore,
    handleLayerItemLoad,
    handleSaveLayerItem,
    searchLayer,
    handleDeleteBlock,
    handleImport,
    handleToggleScope,
    // helpers
    agentLabel,
    allocatableAgents,
    isSelfChatMemory,
  };
}

export type ChatMemoryStore = ReturnType<typeof useChatMemory>;
