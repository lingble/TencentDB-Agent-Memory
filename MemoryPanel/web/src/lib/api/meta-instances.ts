/**
 * api/meta-instances.ts — instance selection before login (GET /api/v1/meta/instances).
 */
import { request, dedupeInFlight } from './base';

/**
 * Instance metadata visible to the client.
 *   - `api_key` (a real secret) is not sent.
 *   - `gateway_endpoint` is the backend → kernel forwarding address, and also the "client access baseUrl".
 *     It is not a secret; each instance has its own, so the frontend must not hard-code it.
 *   - `proxy_endpoint` is optional. In local deployments core and proxy are separate, and clients need to connect to
 *     the proxy, so this field must be configured explicitly. Used only by the frontend "client access address" card; backend
 *     forwarding always goes through `gateway_endpoint` and is unaffected by it.
 */
export interface MetadataInstance {
  instance_id: string;
  name: string;
  gateway_endpoint: string;
  proxy_endpoint?: string;
}

/** Panel-level capability flags (delivered alongside the instance list, used to control menu/route visibility). */
export interface PanelCapabilities {
  /** Whether the "Observability" entry is enabled (panel env PANEL_FEATURE_ANALYTICS_ENABLED, off by default). */
  analyticsEnabled: boolean;
}

/** Fallback when an older Panel doesn't send capabilities (conservative: don't show the entry). */
const DEFAULT_CAPABILITIES: PanelCapabilities = { analyticsEnabled: false };

export const metaInstancesApi = {
  /** Instance selection before login; GET /api/v1/meta/instances, public, no auth, no pagination */
  list: () =>
    dedupeInFlight('meta/instances', () =>
      request<{ instances: MetadataInstance[] }>('GET', '/api/v1/meta/instances').then((r) => r.instances),
    ),

  /**
   * Panel capability flags. Uses the same dedup key as list(): concurrent calls share a single network request,
   * and each extracts the fields it needs from the response (list takes instances, this function takes capabilities).
   * Older Panel responses lack this field → fall back to disabled.
   */
  capabilities: () =>
    dedupeInFlight('meta/instances', () =>
      request<{ capabilities?: PanelCapabilities }>('GET', '/api/v1/meta/instances').then(
        (r) => r.capabilities ?? DEFAULT_CAPABILITIES,
      ),
    ),
};
