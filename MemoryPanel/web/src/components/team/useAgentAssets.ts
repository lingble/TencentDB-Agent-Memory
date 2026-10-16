/**
 * Data hooks:
 *   - loadAgentOverview / syncChatMemoryBindings: single-call asset overview endpoint
 *   - useTeamAssets: fetch team-level skill/code_graph/wiki/chat_memory lists
 *   - useAgentMountedCounts: batch-fetch each agent's mounted asset counts, and
 *     automatically refetch after BACKEND_REFRESH_EVENT
 */

import { useState, useMemo, useEffect, useCallback } from 'react';
import { chatMemoryApi } from '@/lib/teamApi';
import { getPanelSession } from '@/lib/panelSession';
import type { Agent as StoreAgent } from '@/services';
import {
  MAX_IMPORTED_CHAT_MEMORIES,
  importedChatMemoryIds,
  type MountableAsset,
  type AgentMountedCounts,
  type AgentOverviewPayload,
  type AgentOverviewEnvelope,
} from './types';

export async function loadAgentOverview(teamId: string, agentIds: string[] = []): Promise<AgentOverviewPayload> {
  const session = getPanelSession();
  if (!session) throw new Error('no active panel session');
  const res = await fetch('/api/v1/agent-overview/bootstrap', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Tdai-Service-Id': session.instanceId,
      'X-Tdai-User-Key': session.userKey,
    },
    body: JSON.stringify({ team_id: teamId, agent_ids: agentIds }),
  });
  const env = (await res.json()) as AgentOverviewEnvelope;
  if (!res.ok || env.code !== 0) throw new Error(env.message || 'AGENT_OVERVIEW_FAILED');
  return env.data;
}

export async function syncChatMemoryBindings(teamId: string, agentId: string, nextIds: string[]): Promise<void> {
  const imported = importedChatMemoryIds(teamId, agentId, nextIds);
  if (imported.length > MAX_IMPORTED_CHAT_MEMORIES) {
    throw new Error('IMPORT_LIMIT_EXCEEDED');
  }
  await chatMemoryApi.setAgentFixed(teamId, agentId, imported);
}

/** Team assets hook: fetch Skill / CodeGraph / Wiki / ChatMemory from the real API */
export function useTeamAssets(teamId: string) {
  const [skills, setSkills] = useState<MountableAsset[]>([]);
  const [codeGraphs, setCodeGraphs] = useState<MountableAsset[]>([]);
  const [wikis, setWikis] = useState<MountableAsset[]>([]);
  const [chatMemories, setChatMemories] = useState<MountableAsset[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!teamId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const overview = await loadAgentOverview(teamId);
      setSkills(overview.assets.skills);
      setCodeGraphs(overview.assets.codeGraphs);
      setWikis(overview.assets.wikis);
      setChatMemories(overview.assets.chatMemories);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  return { loading, skills, codeGraphs, wikis, chatMemories };
}

export function useAgentMountedCounts(
  teamId: string | null,
  agents: StoreAgent[],
): { counts: Record<string, AgentMountedCounts>; countsLoading: boolean } {
  const [counts, setCounts] = useState<Record<string, AgentMountedCounts>>({});
  const [countsLoading, setCountsLoading] = useState(true);
  const agentsKey = useMemo(() => agents.map((a) => a.agent_id).join('|'), [agents]);

  // List counts use the backend agent-overview/bootstrap counts directly - it reads the real source
  // (skill table owner_agent_id + agent-fixed-asset table), consistent with the details dialog and runtime.
  // metadata_json.ui is no longer used as a fallback: .ui is a deprecated shadow store that would make display != reality.
  // Refreshes with silent=true (BACKEND_REFRESH_EVENT) don't flip loading, avoiding full-screen skeleton flicker after actions.
  const load = useCallback((silent: boolean) => {
    if (!teamId || agents.length === 0) {
      setCounts({});
      setCountsLoading(false);
      return () => {};
    }
    if (!silent) setCountsLoading(true);
    let cancelled = false;
    loadAgentOverview(teamId, agents.map((agent) => agent.agent_id))
      .then((overview) => {
        if (!cancelled) setCounts(overview.counts);
      })
      .catch(() => {
        if (!cancelled) setCounts({});
      })
      .finally(() => {
        if (!cancelled) setCountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, agentsKey]);

  // Initial / agent-change load: flip countsLoading, driving the skeleton to cover the whole bootstrap loading period
  useEffect(() => {
    return load(false);
  }, [load]);

  // After saving, invalidateBackendCache() broadcasts BACKEND_REFRESH_EVENT, silently refetching counts,
  // updating in place while keeping old values, without flashing skeletons
  useEffect(() => {
    if (!teamId || agents.length === 0) return;
    const handler = () => { load(true); };
    window.addEventListener('tdai-memory.backend-refresh', handler);
    return () => window.removeEventListener('tdai-memory.backend-refresh', handler);
  }, [load, teamId, agents.length]);

  return { counts, countsLoading };
}
