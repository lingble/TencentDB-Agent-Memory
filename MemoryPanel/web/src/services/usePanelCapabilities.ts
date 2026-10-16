/**
 * usePanelCapabilities / useAnalyticsChConfigured - visibility check for the "Observability" entry.
 *
 * Two conditions (both required):
 *   1. Panel env switch: PANEL_FEATURE_ANALYTICS_ENABLED (delivered with the capabilities of GET /meta/instances).
 *      Off by default -> menu/route not shown, and no CH probe request is sent.
 *   2. Runtime CH probe: once the switch is on, call GET /api/v1/analytics/config (transparent panel proxy
 *      -> kernel /v3/analytics/config). The entry is auto-hidden when ClickHouse is not configured.
 *
 * Probe results are cached at module level: the env switch does not change within a session; the CH probe and the
 * useAnalyticsMetrics probe inside AnalyticsPage use the same endpoint (deduplicated inside analyticsApi via dedupeInFlight),
 * so no duplicate network requests are made.
 */
import { useEffect, useState } from 'react';
import { metaInstancesApi } from '@/lib/api/meta-instances';
import { analyticsApi } from '@/lib/api/analytics';

/** Cache of the env switch state (session-level, null = not yet fetched). */
let analyticsEnabledCache: boolean | null = null;

/**
 * Panel "Observability" env switch.
 * Returns null when not yet fetched (renderers may treat it as invisible or keep the current state);
 * false = switch off or fetch failed (conservatively hidden); true = switch on (still needs to pass the CH probe).
 */
export function usePanelAnalyticsEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(analyticsEnabledCache);

  useEffect(() => {
    if (analyticsEnabledCache !== null) return;
    let alive = true;
    void metaInstancesApi
      .capabilities()
      .then((caps) => {
        analyticsEnabledCache = caps.analyticsEnabled;
        if (alive) setEnabled(caps.analyticsEnabled);
      })
      .catch(() => {
        // Treat fetch failure as off (conservatively hidden, without blocking other panel features)
        analyticsEnabledCache = false;
        if (alive) setEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return enabled;
}

/**
 * Whether analytics ClickHouse is configured on the kernel side (runtime probe).
 * Only sent when enabled=true; null = probing (callers may treat it as "visible" first and converge after probing).
 */
export function useAnalyticsChConfigured(enabled: boolean): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    void analyticsApi
      .config()
      .then((cfg) => {
        if (alive) setConfigured(cfg.configured && cfg.reachable !== false);
      })
      .catch(() => {
        // Treat probe failure (network/permission) as not configured: entry hidden, in-page notice handled by AnalyticsPage
        if (alive) setConfigured(false);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return configured;
}
