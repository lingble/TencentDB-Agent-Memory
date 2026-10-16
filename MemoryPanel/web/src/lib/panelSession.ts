/**
 * Panel Session - new-panel frontend session cache (localStorage).
 *
 * Aligns with docs/architecture/09-new-panel-control-backend-design.md §3.3.2:
 * the new-panel Control is a stateless proxy that creates no Cookie/Session; login credentials
 * (instance_id + user_key) are held by the frontend itself, cached in localStorage
 * (shared across tabs, survives closing a tab), and read from here to inject headers on every meta request:
 *   - X-Tdai-Service-Id (= registry id = kernel x-tdai-service-id; early doc versions used
 *     the name `X-Metadata-Instance-Id`, renamed since meta-api.openapi.yaml v1.1.0;
 *     always follow the latest contract, otherwise Control returns 400 MISSING_INSTANCE_ID)
 *   - X-Tdai-User-Key (except for auth/verify)
 *
 * Previously used sessionStorage (tab-scoped), which required logging in again in new tabs.
 * With localStorage, login state is shared across tabs, and logout is synced via the storage event.
 */
import type { PublicUser } from './teamApi';

export interface PanelSession {
  /** Auth source; the default value means a legacy user_key session. */
  authMethod?: 'user_key' | 'idp';
  /** = registry id = kernel x-tdai-service-id; determined when selecting an instance on the login page */
  instanceId: string;
  /** Display only (the name in the instance list), optional */
  instanceName?: string;
  /** API key of a legacy user_key session; IdP Sessions use an empty-string placeholder and never receive a real user_key. */
  userKey: string;
  /** data.user from the auth/verify response (optional, used for display + as the source of owner_user_id/creator_user_id) */
  user?: PublicUser;
}

const STORAGE_KEY = 'tdai-panel.session';

/** Read the current session; returns null if there is no session or parsing fails (doesn't throw, callers treat it as logged out) */
export function getPanelSession(): PanelSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PanelSession;
  } catch {
    return null;
  }
}

/** Write the session after a successful login (auth/verify returns valid===true) */
export function setPanelSession(session: PanelSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* Private mode / storage quota error: fail silently, don't block the in-memory state of this post-login session */
  }
}

/** Clear the session on logout / 401 fallback */
export function clearPanelSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
