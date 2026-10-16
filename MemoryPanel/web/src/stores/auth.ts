/**
 * Auth Store (zustand)
 *
 * Integrates with the new panel Control (no Cookie, stateless proxy; see design doc 09 §3.3).
 * Login credentials (instance_id + user_key) are cached in localStorage (lib/panelSession.ts);
 * "log out" / "session expired" only clear the local cache; Control has no logout API and no server-side session table.
 *
 * Multi-tab sync: listens for localStorage changes via the storage event.
 *   - Another tab logs in → this tab automatically restores the logged-in state (checkSession)
 *   - Another tab logs out / 401 → this tab automatically exits to LoginGate
 *
 * auth has three states:
 *   - null      checking login state (on App startup checkSession reads the localStorage cache)
 *   - undefined confirmed not logged in → render LoginGate
 *   - AuthState logged in → render the main UI
 */
import { create } from 'zustand';
import { readAuth, clearAuth, resumeSession, type AuthState } from '@/components/LoginGate';
import { onUnauthorized } from '@/lib/teamApi';
import { clearBackendCache, writeActiveTeamId } from '@/services';

const PANEL_SESSION_KEY = 'tdai-panel.session';

interface AuthStore {
  auth: AuthState | null | undefined;
  /** Written after successful login (LoginGate's onLoggedIn callback) */
  setAuth: (auth: AuthState) => void;
  /** Log out: clear the local localStorage session and return to LoginGate (no backend call) */
  logout: () => Promise<void>;
  /** Read the localStorage cache on App startup; regardless of the result, auth advances from null to a definite state */
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  auth: null,

  setAuth: (auth) => {
    set({ auth });
  },

  logout: async () => {
    // The new panel has no server-side session, so logging out just clears the local cache; no backend logout API is needed (or exists).
    // Clear the module-level backend cache (teams/agents/tasks) so a newly logged-in user doesn't briefly see the previous user's lists.
    // Use clearBackendCache rather than invalidateBackendCache: the latter broadcasts an event that triggers mounted pages'
    // refetch listeners, which would still send requests with the old session Header and pull the old data back;
    // here we only clear the cache, letting components naturally do their first fetch when they mount for the new user.
    clearBackendCache();
    // activeTeamId may point to a team only the old user had access to; clear it so the new user doesn't end up with a team they lack permission for.
    writeActiveTeamId(null);
    clearAuth();
    set({ auth: undefined });
  },

  checkSession: async () => {
    const cached = readAuth();
    if (cached) {
      set({ auth: cached });
      return;
    }
    const auth = await resumeSession();
    set({ auth: auth ?? undefined });
  },
}));

/**
 * Cross-tab sync: listen for localStorage storage events.
 *
 * The storage event only fires when "another tab" modifies localStorage (writes in this tab don't trigger it),
 * which makes it ideal for cross-tab state sync.
 *
 *   - Another tab logs in (writes tdai-panel.session) → this tab restores the logged-in state
 *   - Another tab logs out / 401 (deletes tdai-panel.session) → this tab exits to LoginGate
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== PANEL_SESSION_KEY) return;

    if (e.newValue === null) {
      // Another tab logged out → this tab logs out too
      clearBackendCache();
      writeActiveTeamId(null);
      clearAuth();
      useAuthStore.setState({ auth: undefined });
    } else {
      // Another tab logged in → this tab restores the logged-in state
      void useAuthStore.getState().checkSession();
    }
  });
}

// When any meta request returns HTTP 401 (e.g. a Control validation error mapped to that code), clear the session globally and return to the login page.
// Under the new panel this isn't the main logout path (explicit logout goes through logout()); it's only a fallback.
// Clear the cache like logout() does, otherwise after re-login following a 401 the previous user's lists would briefly show.
// Only needs to be registered once, when the store module loads.
onUnauthorized(() => {
  clearBackendCache();
  writeActiveTeamId(null);
  clearAuth();
  useAuthStore.setState({ auth: undefined });
});
