/**
 * useSkillDetailCache - on-demand cache for skill data-plane details.
 *
 * Background: the asset list returned by asset/list-accessible only contains asset-layer fields
 *(version is always 1, no owner_agent_id); the skill data plane's real version and
 * owner_agent_id require calling getSkill(). The old implementation, after the list loaded, fired N concurrent
 * getSkill() calls, one per skill (N+1), fetching all details before the user opened any item.
 *
 * This hook makes it on-demand: the list renders with asset-layer defaults first; when the user selects a skill
 * only that one's data-plane details are fetched and cached, and later hits on the same skill read from the cache.
 *
 * Usage (parent component):
 *   const { getFromCache, preload, applyCachedDetail } = useSkillDetailCache(activeTeamId);
 *   useEffect(() => { if (selectedId) void preload(selectedId); }, [selectedId]);
 *   List rendering: const s = applyCachedDetail(skill);
 */

import { useRef, useState, useCallback } from 'react';
import { getSkill } from '@/lib/api/skill-api';

export interface CachedSkillDetail {
  version: number;
  owner_agent_id: string;
}

export function useSkillDetailCache(teamId: string | null | undefined) {
  /** skill_id → fetched data-plane details (version + owner_agent_id). */
  const cacheRef = useRef(new Map<string, CachedSkillDetail>());

  /** Set of skill_ids with requests in flight, preventing concurrent duplicate requests for the same skill. */
  const inFlightRef = useRef(new Set<string>());

  /** Incremented after each cache write; the parent depends on it to recompute list items in useMemo. */
  const [cacheVersion, setCacheVersion] = useState(0);

  /** Read the cache synchronously (does not trigger a request). */
  const getFromCache = useCallback((skillId: string): CachedSkillDetail | undefined => {
    return cacheRef.current.get(skillId);
  }, []);

  /** Preload one skill's data-plane details (idempotent; skipped if cached or already in flight). */
  const preload = useCallback(async (skillId: string) => {
    if (!teamId || !skillId) return;
    if (cacheRef.current.has(skillId) || inFlightRef.current.has(skillId)) return;
    inFlightRef.current.add(skillId);
    try {
      const full = await getSkill({
        skill_id: skillId,
        team_id: teamId,
        include_content: false,
        include_manifest: false,
      });
      cacheRef.current.set(skillId, {
        version: full.version,
        owner_agent_id: full.owner_agent_id,
      });
      setCacheVersion((n) => n + 1);
    } catch {
      // Fail silently: the list keeps the asset defaults (v1 / empty owner_agent_id)
    } finally {
      inFlightRef.current.delete(skillId);
    }
  }, [teamId]);

  /**
   * Overwrite the skill object's version / owner_agent_id fields with the latest cached values.
   * On a cache miss, return it unchanged without affecting rendering.
   */
  const applyCachedDetail = useCallback(<T extends { skill_id: string; version: number; owner_agent_id: string }>(
    skill: T,
  ): T => {
    const cached = cacheRef.current.get(skill.skill_id);
    if (!cached) return skill;
    return { ...skill, version: cached.version, owner_agent_id: cached.owner_agent_id };
  }, []);

  return { getFromCache, preload, applyCachedDetail, cacheRef, cacheVersion };
}
