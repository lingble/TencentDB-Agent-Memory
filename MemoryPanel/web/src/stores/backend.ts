/**
 * stores/backend.ts - global backend data store (zustand).
 *
 * Replaces the module-level variables in backendStore.ts (_cachedTeams / _cachedAgentsMap / _inflightTeams ...).
 *
 * Core design:
 *   - teamsLoaded / agentsLoadedTeamIds: mark "already loaded",
 *     so components don't re-fetch on every mount.
 *   - invalidate(): call after write operations; clears all caches + broadcasts BACKEND_REFRESH_EVENT.
 *   - invalidateTeam(teamId): on team switch, clears only the current team's agents/tasks cache.
 *   - useTeams / useAgents / useTasks: read data from the store + trigger fetch; multiple components share the same state.
 */

import { create } from 'zustand';
import { useEffect, useState } from 'react';
import {
  teamsApi,
  membersApi,
  agentsApi,
  tasksApi,
  type TeamMember as BackendMember,
} from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import i18n from '@/i18n';
import { seedDisplayNameCache } from '@/services/user-profile-store';

// Re-import pure functions (adapters / types) from backendStore.ts to avoid circular dependencies
import {
  type Team,
  type Agent,
  type Task,
  adaptTeam,
  adaptMember,
  adaptAgent,
  adaptTask,
  readActiveTeamId,
  writeActiveTeamId,
  ensureValidActiveTeamId,
} from '@/services/backendStore';

// ========================= Event constants =========================

const BACKEND_REFRESH_EVENT = 'tdai-memory.backend-refresh';
const LOCAL_CHANGE_EVENT = 'tdai-memory.demo-store-change';

function emitBackendRefresh() {
  try { window.dispatchEvent(new Event(BACKEND_REFRESH_EVENT)); } catch { /* ignore */ }
}

// ========================= Store types =========================

interface BackendState {
  // Data
  teams: Team[];
  activeTeamId: string | null;
  agentsByTeam: Record<string, Agent[]>;
  // Overall total (the total returned by the kernel); frontend pagination computes page count from it
  tasksTotalByTeam: Record<string, number>;
  // Backend pagination cache: tasksPagesByTeam[teamId]["offset:limit"] = Task[]
  tasksPagesByTeam: Record<string, Record<string, Task[]>>;
  // loaded flags (avoid duplicate fetches)
  teamsLoaded: boolean;
  teamsLoading: boolean;
  agentsLoadedTeamIds: Set<string>;
  // in-flight dedup
  inflightTeams: Promise<void> | null;
  inflightAgents: Record<string, Promise<Agent[]>>;
  inflightTasks: Record<string, Promise<Task[]> | undefined>;
  /**
   * Epoch counter: incremented on clearAll (logout / 401) / invalidate.
   * refreshTeams / fetchAgents / fetchTasks capture the current epoch when started; after await returns,
   * if the epoch changed (a logout/cache clear happened meanwhile), the result is discarded - preventing an old session's
   * in-flight request from writing the previous user's teams/agents/tasks back into the store, or writing an old team
   * back to localStorage activeTeamId, which would make a newly logged-in user briefly/persistently see old data.
   */
  epoch: number;

  // actions
  fetchTeams: () => Promise<void>;
  /**
   * Force-refetch the team list (ignores the teamsLoaded cache, keeps in-flight dedup).
   * With `silent: true`, teamsLoading is not flipped in the UI layer - used for background freshness cases like
   * opening a dropdown, so consumers such as TeamManagementPanel don't fall entirely into a
   * loading placeholder because teamsLoading=true (showing up as "clicking the dropdown refreshes the page").
   */
  refreshTeams: (opts?: { silent?: boolean }) => Promise<void>;
  fetchAgents: (teamId: string) => Promise<Agent[]>;
  fetchTasks: (teamId: string, params?: { limit?: number; offset?: number; force?: boolean }) => Promise<Task[]>;
  setActiveTeamId: (teamId: string | null) => void;
  invalidate: () => void;
  invalidateTeam: (teamId: string) => void;
  clearAll: () => void;
}

// ========================= Store implementation =========================

export const useBackendStore = create<BackendState>((set, get) => ({
  teams: [],
  activeTeamId: readActiveTeamId(),
  agentsByTeam: {},
  tasksTotalByTeam: {},
  tasksPagesByTeam: {},
  teamsLoaded: false,
  teamsLoading: false,
  agentsLoadedTeamIds: new Set(),
  inflightTeams: null,
  inflightAgents: {},
  inflightTasks: {},
  epoch: 0,

  fetchTeams: async () => {
    const state = get();
    // Already loaded -> don't fetch again (only refetch after invalidate / clearAll)
    if (state.teamsLoaded) return;
    await get().refreshTeams();
  },

  refreshTeams: async (opts?: { silent?: boolean }) => {
    const state = get();
    // in-flight dedup: send only once when multiple components mount simultaneously
    if (state.inflightTeams) { await state.inflightTeams; return; }

    const silent = opts?.silent === true;
    // Capture the epoch at start: if a logout/cache clear happens meanwhile (epoch increments), this result must be discarded
    const epoch = state.epoch;
    const promise = (async () => {
      // Silent refresh doesn't flip teamsLoading - consumers (TeamManagementPanel etc.) rely on it
      // to show a loading placeholder; flipping it in background-freshness cases like opening the dropdown would cause
      // "clicking the dropdown flashes the whole page into loading and back".
      if (!silent) set({ teamsLoading: true });
      try {
        const backendTeams = await teamsApi.list();
        // Fetch members in bulk (N+1 -> N, but this is a backend API limitation, no batch endpoint)
        const memberResults = await Promise.all(
          backendTeams.map((t) => membersApi.list(t.team_id).catch(() => [] as BackendMember[]))
        );
        // Stale-session result returned after logout/cache clear: discard, to prevent old teams being written back to the store,
        // and to prevent ensureValidActiveTeamId writing the old team back to localStorage activeTeamId.
        if (get().epoch !== epoch) return;
        const adapted = backendTeams.map((bt, i) =>
          adaptTeam(bt, memberResults[i].map(adaptMember))
        );
        seedDisplayNameCache(adapted.flatMap((t) => t.members));
        ensureValidActiveTeamId(adapted);
        set({
          teams: adapted,
          teamsLoaded: true,
          teamsLoading: false,
          activeTeamId: readActiveTeamId(),
        });
      } catch (err) {
        if (get().epoch !== epoch) return;
        console.error('[backend store] refreshTeams failed:', err);
        set({ teamsLoading: false });
        tea.notify.error(i18n.t('backend.loadTeamsFailed'));
      } finally {
        // Only clear "our own" in-flight marker: a stale request must not clear a newer request's reference
        set((s) => (s.inflightTeams === promise ? { inflightTeams: null } : {}));
      }
    })();

    set({ inflightTeams: promise });
    await promise;
  },

  fetchAgents: async (teamId: string) => {
    const state = get();
    // Already loaded -> return cache directly
    if (state.agentsLoadedTeamIds.has(teamId)) {
      return state.agentsByTeam[teamId] ?? [];
    }
    // in-flight dedup
    if (state.inflightAgents[teamId] != null) {
      return state.inflightAgents[teamId];
    }

    const epoch = state.epoch;
    const promise = (async () => {
      try {
        const backendAgents = await agentsApi.list(teamId);
        // Stale-session result returned after logout/cache clear: discard, don't write to the store
        if (get().epoch !== epoch) return [];
        const adapted = backendAgents.map((ba, i) => adaptAgent(ba, i));
        set((s) => ({
          agentsByTeam: { ...s.agentsByTeam, [teamId]: adapted },
          agentsLoadedTeamIds: new Set(s.agentsLoadedTeamIds).add(teamId),
          inflightAgents: Object.fromEntries(
            Object.entries(s.inflightAgents).filter(([k]) => k !== teamId)
          ),
        }));
        return adapted;
      } catch (err) {
        if (get().epoch !== epoch) return [];
        console.error('[backend store] fetchAgents failed:', err);
        set((s) => ({
          inflightAgents: Object.fromEntries(
            Object.entries(s.inflightAgents).filter(([k]) => k !== teamId)
          ),
        }));
        tea.notify.error(i18n.t('backend.loadAgentsFailed'));
        return [];
      }
    })();

    set((s) => ({ inflightAgents: { ...s.inflightAgents, [teamId]: promise } }));
    return promise;
  },

  fetchTasks: async (teamId: string, params?: { limit?: number; offset?: number; force?: boolean }) => {
    const state = get();
    const limit = params?.limit ?? 20;
    const offset = params?.offset ?? 0;
    // Cache key: at (offset, limit) granularity (teamId is already isolated at the tasksPagesByTeam[teamId] level)
    const cacheKey = `${offset}:${limit}`;
    // The in-flight key must include teamId - when two teams fetch concurrently with the same paging params,
    // sharing offset:limit as the key would make the later team await the earlier team's request,
    // neither writing its cache nor actually sending a request, leaving the page empty forever.
    const inflightKey = `${teamId}:${cacheKey}`;
    // Cached and not a forced refresh -> return directly
    if (!params?.force && state.tasksPagesByTeam[teamId]?.[cacheKey]) {
      return state.tasksPagesByTeam[teamId][cacheKey];
    }
    // in-flight dedup
    if (state.inflightTasks[inflightKey]) { await state.inflightTasks[inflightKey]; return get().tasksPagesByTeam[teamId]?.[cacheKey] ?? []; }

    const epoch = state.epoch;
    const promise = (async () => {
      try {
        const { items: tasksWithAgents, total } = await tasksApi.listWithAgents(teamId, { limit, offset });
        // Stale-session result returned after logout/cache clear: discard, don't write to the store
        if (get().epoch !== epoch) return [];
        const adapted = tasksWithAgents.map((t) =>
          adaptTask(t, t.agents.filter((a) => a.status === 'active').map((a) => a.agent_id))
        );
        set((s) => {
          const teamPages = s.tasksPagesByTeam[teamId] ?? {};
          return {
            tasksPagesByTeam: { ...s.tasksPagesByTeam, [teamId]: { ...teamPages, [cacheKey]: adapted } },
            tasksTotalByTeam: { ...s.tasksTotalByTeam, [teamId]: total },
            inflightTasks: Object.fromEntries(
              Object.entries(s.inflightTasks).filter(([k]) => k !== inflightKey)
            ),
          };
        });
        return adapted;
      } catch (err) {
        console.error('[backend store] fetchTasks failed:', err);
        set((s) => ({
          inflightTasks: Object.fromEntries(
            Object.entries(s.inflightTasks).filter(([k]) => k !== inflightKey)
          ),
        }));
        tea.notify.error(i18n.t('backend.loadTasksFailed'));
        return [];
      }
    })();

    set((s) => ({ inflightTasks: { ...s.inflightTasks, [inflightKey]: promise } }));
    return promise;
  },

  setActiveTeamId: (teamId) => {
    writeActiveTeamId(teamId);
    set({ activeTeamId: teamId });
  },

  // Call after write operations: clear all caches + broadcast refresh
  invalidate: () => {
    set((s) => ({
      teams: [],
      teamsLoaded: false,
      teamsLoading: false,
      agentsByTeam: {},
      tasksTotalByTeam: {},
      tasksPagesByTeam: {},
      agentsLoadedTeamIds: new Set(),
      inflightTeams: null,
      inflightAgents: {},
      inflightTasks: {},
      // Results of in-flight requests started before the write are stale and must be discarded
      epoch: s.epoch + 1,
    }));
    emitBackendRefresh();
  },

  // Call on team switch: clear only the current team's agents/tasks cache
  invalidateTeam: (teamId) => {
    set((s) => {
      const agentsLoadedTeamIds = new Set(s.agentsLoadedTeamIds);
      agentsLoadedTeamIds.delete(teamId);
      const agentsByTeam = { ...s.agentsByTeam };
      delete agentsByTeam[teamId];
      const tasksPagesByTeam = { ...s.tasksPagesByTeam };
      delete tasksPagesByTeam[teamId];
      const tasksTotalByTeam = { ...s.tasksTotalByTeam };
      delete tasksTotalByTeam[teamId];
      return { agentsLoadedTeamIds, agentsByTeam, tasksPagesByTeam, tasksTotalByTeam };
    });
    emitBackendRefresh();
  },

  // Call on logout / 401: clear all caches without broadcasting an event
  clearAll: () => {
    set((s) => ({
      teams: [],
      // Also clear activeTeamId in the store (writeActiveTeamId(null) only clears localStorage;
      // this is a fallback for in-memory state, avoiding a leftover old team when no useTeams listener is mounted)
      activeTeamId: null,
      teamsLoaded: false,
      teamsLoading: false,
      agentsByTeam: {},
      tasksTotalByTeam: {},
      tasksPagesByTeam: {},
      agentsLoadedTeamIds: new Set(),
      inflightTeams: null,
      inflightAgents: {},
      inflightTasks: {},
      // Increment epoch: so stale-session in-flight results are discarded when they return
      epoch: s.epoch + 1,
    }));
  },
}));

// ========================= React Hooks =========================

/**
 * useTeams - read the team list + activeTeamId from the store.
 *
 * Multiple components calling useTeams() trigger only one fetchTeams (teamsLoaded flag + in-flight dedup).
 * Call invalidate() after writes -> teamsLoaded=false -> refetch on the next component mount/render.
 * Switch team via setActiveTeamId -> writes localStorage + updates state.
 */
export function useTeams(): {
  teams: Team[];
  activeTeamId: string | null;
  activeTeam: Team | null;
  loading: boolean;
} {
  const teams = useBackendStore((s) => s.teams);
  const teamsLoaded = useBackendStore((s) => s.teamsLoaded);
  const teamsLoading = useBackendStore((s) => s.teamsLoading);
  const activeTeamId = useBackendStore((s) => s.activeTeamId);
  const fetchTeams = useBackendStore((s) => s.fetchTeams);

  useEffect(() => {
    if (!teamsLoaded && !teamsLoading) {
      void fetchTeams();
    }
  }, [teamsLoaded, teamsLoading, fetchTeams]);

  // Listen for localStorage changes (triggered when TeamSwitcher writes activeTeamId)
  const [, force] = useState(0);
  useEffect(() => {
    const onLocalChange = () => {
      useBackendStore.setState({ activeTeamId: readActiveTeamId() });
      force((n) => n + 1);
    };
    window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
    return () => window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
  }, []);

  const activeTeam = teams.find((t) => t.team_id === activeTeamId) ?? null;
  return { teams, activeTeamId, activeTeam, loading: teamsLoading };
}

const EMPTY_AGENTS: Agent[] = [];
const EMPTY_TASKS: Task[] = [];

/**
 * useAgents - read the agent list of a given team from the store.
 *
 * Multiple components calling with the same teamId trigger only one fetch.
 * Refetches only after invalidate() or invalidateTeam(teamId).
 */
export function useAgents(teamId: string | null | undefined): {
  agents: Agent[];
  loading: boolean;
} {
  // Cache the previous teamId in a ref, so the selector doesn't return a different reference each time
  const agents = useBackendStore((s) =>
    teamId ? (s.agentsByTeam[teamId] ?? EMPTY_AGENTS) : EMPTY_AGENTS
  );
  const loaded = useBackendStore((s) => (teamId ? s.agentsLoadedTeamIds.has(teamId) : true));
  const fetchAgents = useBackendStore((s) => s.fetchAgents);

  useEffect(() => {
    if (!teamId) return;
    if (!loaded) {
      void fetchAgents(teamId);
    }
  }, [teamId, loaded, fetchAgents]);

  return { agents, loading: !!teamId && !loaded };
}

/**
 * useTasks - read the task list of a given team from the store.
 */
export function useTasks(teamId: string | null | undefined, page: number = 1, pageSize: number = 12): {
  tasks: Task[];
  total: number;
  loading: boolean;
} {
  const offset = (page - 1) * pageSize;
  const cacheKey = `${offset}:${pageSize}`;
  const tasks = useBackendStore((s) =>
    teamId ? (s.tasksPagesByTeam[teamId]?.[cacheKey] ?? EMPTY_TASKS) : EMPTY_TASKS
  );
  const total = useBackendStore((s) =>
    teamId ? (s.tasksTotalByTeam[teamId] ?? 0) : 0
  );
  const loaded = useBackendStore((s) =>
    teamId ? !!s.tasksPagesByTeam[teamId]?.[cacheKey] : true
  );
  const fetchTasks = useBackendStore((s) => s.fetchTasks);

  useEffect(() => {
    if (!teamId || loaded) return;
    void fetchTasks(teamId, { limit: pageSize, offset });
  }, [teamId, offset, pageSize, loaded, fetchTasks]);

  return { tasks, total, loading: !!teamId && !loaded };
}

/**
 * readActiveTeamAgents - synchronously read the cached agent list (doesn't trigger a request).
 * For cases like SkillsPanel that only need a "reference list".
 */
export function readActiveTeamAgents(teamId: string | null): Array<{ id: string; name: string }> {
  if (!teamId) return [];
  const cached = useBackendStore.getState().agentsByTeam[teamId];
  if (cached) return cached.map((a) => ({ id: a.agent_id, name: a.name }));
  // Cache miss: trigger a background fetch
  void useBackendStore.getState().fetchAgents(teamId);
  return [];
}

// ========================= Export invalidate / clearAll (for mutations) =========================

export function invalidateBackendCache(): void {
  useBackendStore.getState().invalidate();
}

export function clearBackendCache(): void {
  useBackendStore.getState().clearAll();
}

export function invalidateTeamCache(teamId: string): void {
  useBackendStore.getState().invalidateTeam(teamId);
}
