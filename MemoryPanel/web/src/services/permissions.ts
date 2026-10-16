/**
 * permissions.ts - the single authoritative implementation of global permission checks.
 *
 * Extracted from the former demoStore.ts. isGlobalAdmin is the site-wide sole entry point for the "global admin"
 * check (unrelated to the team/agent/task backend implementation; a pure frontend auth state check).
 */

/**
 * Global admin check: admins have all permissions and can see everything.
 *
 * The sole authoritative source: `user.user_type === 'system_admin'` in the auth/verify response,
 * written to `AuthState.isAdmin` by LoginGate at login.
 *
 * The `username === 'admin'` string fallback is no longer kept - it was a leftover from the early demo phase
 * that misjudged regular users whose display_name / username happened to be "admin" as global admins,
 * especially when "the user belongs to no team" or "the user is the only one in the team",
 * where roleInTeam returns null and the UI renders with admin logic (e.g. ResourcePage shows AdminResourceLock),
 * so normal/member users saw the admin lock page.
 */
export function isGlobalAdmin(_currentUser: string, isAdminFlag?: boolean): boolean {
  return isAdminFlag === true;
}
