/**
 * useCurrentRole — get the role of the currently logged-in user
 *
 * Returns 'admin' | 'member' | 'reviewer' | null (null = not logged in).
 *
 * Role model (the single authoritative definition; don't revert to "determine admin from the team member table"):
 *   - admin is a **global role**, unrelated to creating/joining any team (even with no team at all, it's always admin).
 *     admin's job is managing teams (creating teams, adding members), not managing specific resources.
 *   - member is a **team-level role**, i.e. a member of some team, responsible for managing resources within the team (agent/skill/wiki/code/memory).
 *   - So the check order must be: first check whether the user is a global admin; only if not, look up their member role in the active team.
 *     The reverse ("check the team member table first, treat as no role if not found") is wrong: it causes an "admin account with no team
 *     to be misjudged as non-admin (or even null)".
 */
import { useMemo } from 'react';
import { useTeams, roleInTeam, isGlobalAdmin } from '@/services';
import { useAuthStore } from '@/stores/auth';

export type TeamRole = 'admin' | 'member' | 'reviewer';

export function useCurrentRole(): TeamRole | null {
  const { auth } = useAuthStore();
  const { activeTeam } = useTeams();
  return useMemo(() => {
    if (!auth) return null;
    // Global admin: independent of team, always admin (doesn't depend on activeTeam / team.members lookup results)
    // isAdmin comes from auth/verify's user_type === 'system_admin', the single authoritative field.
    if (isGlobalAdmin(auth.user, auth.isAdmin)) return 'admin';
    // Non-admin: the role depends on their member record in the current active team (usually 'member')
    return roleInTeam(activeTeam, auth.user_id);
  }, [activeTeam, auth]);
}
