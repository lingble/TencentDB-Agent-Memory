/**
 * WikiSourceRegistry — wiki provider registry.
 *
 * Symmetric with CodeSourceRegistry: the registry knows nothing about any specific platform;
 * platform differences live only in `providers/<id>/`.
 *
 * Deployment config (same naming pattern):
 *   WIKI_SOURCE_ENABLED=iwiki
 *   WIKI_SOURCE_<UPPER_ID>_<ENDPOINT_SUFFIX>=https://...  # service endpoint (suffix declared by provider, default MCP_URL)
 *   WIKI_SOURCE_<UPPER_ID>_SITE_BASE_URL=https://.../     # site root (used to build the token page URL)
 *
 * Display names are not configurable: the frontend uses i18n via `wiki.source.<id>`.
 *
 * The registry **knows nothing about any specific platform**: the built-in list comes from providers/index.ts,
 * and endpoint config names are declared by each provider → onboarding a REST-style platform needs no change here.
 */

import type { SourceContext, WikiSourceMeta, WikiSourceProvider } from "./types.js";
import { BUILTIN_PROVIDERS } from "./providers/index.js";

/** Default endpoint config name suffix: MCP-protocol style. */
const DEFAULT_ENDPOINT_SUFFIX = "MCP_URL";

function env(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function envKey(id: string, suffix: string): string {
  return `WIKI_SOURCE_${id.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

function joinSitePath(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function enabledIds(): string[] {
  const raw = env("WIKI_SOURCE_ENABLED");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the token application page URL.
 *
 * - Provider declares `tokenUrlEnv` → **use that env var's full URL directly**, no joining.
 *   The env var name is **global** (e.g. `TAI_PAT_URL`), not prefixed per source —
 *   so multiple sources can point to the same token page and the address is changed in one place.
 * - Provider declares `path` → joined onto the deployment-configured `WIKI_SOURCE_<ID>_SITE_BASE_URL`.
 *
 * The address always comes from deployment config: **internal domains are never hard-coded**.
 */
function resolveTokenDocUrl(provider: WikiSourceProvider): string | undefined {
  const tokenDoc = provider.sitePaths.tokenDoc;

  // Full URL (no joining): used when multiple sources share the same token page.
  if (tokenDoc && "tokenUrlEnv" in tokenDoc) return env(tokenDoc.tokenUrlEnv);

  if (tokenDoc && "path" in tokenDoc) {
    const siteBase = env(envKey(provider.id, "SITE_BASE_URL"));
    return siteBase ? joinSitePath(siteBase, tokenDoc.path) : undefined;
  }
  return undefined;
}

function toMeta(provider: WikiSourceProvider): WikiSourceMeta {
  return {
    id: provider.id,
    auth_method: provider.authMethod.kind,
    form_fields: provider.authMethod.formFields,
    token_doc_url: resolveTokenDocUrl(provider),
  };
}

export class WikiSourceRegistry {
  private readonly providers = new Map<string, WikiSourceProvider>();

  constructor(
    ids?: string[],
    builtins: readonly WikiSourceProvider[] = BUILTIN_PROVIDERS,
  ) {
    const enabledSet = new Set(ids ?? enabledIds());
    const known = new Set(builtins.map((p) => p.id));
    // Enabling an id that is not built in is a config error: throw immediately rather than silently adding a placeholder
    const unknown = [...enabledSet].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `WIKI_SOURCE_ENABLED contains unknown source(s): ${unknown.join(", ")}. ` +
          `Available: ${[...known].join(", ") || "(none)"}.`,
      );
    }
    for (const p of builtins) {
      if (enabledSet.has(p.id)) this.providers.set(p.id, p);
    }
  }

  register(provider: WikiSourceProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): WikiSourceProvider | undefined {
    return this.providers.get(id);
  }

  list(): WikiSourceMeta[] {
    return Array.from(this.providers.values()).map(toMeta);
  }

  /**
   * Build the fetch context: combine the deployment-configured service endpoint + supplied credentials into a SourceContext.
   *
   * The endpoint config name is declared by the provider (`endpointEnvSuffix`, default `MCP_URL`),
   * so both MCP-style and REST-style platforms work; the registry assumes no specific protocol.
   *
   * Endpoint not configured → throws (internal infrastructure must be configured explicitly; no built-in default).
   */
  contextFor(
    id: string,
    secret: string,
    username?: string,
  ): { provider: WikiSourceProvider; ctx: SourceContext } {
    const provider = this.get(id);
    if (!provider) throw new Error(`wiki source provider '${id}' is not registered`);
    const suffix = provider.endpointEnvSuffix ?? DEFAULT_ENDPOINT_SUFFIX;
    const key = envKey(id, suffix);
    const endpoint = env(key);
    if (!endpoint) {
      throw new Error(
        `missing ${key}: endpoint must be configured explicitly (declared by provider '${id}')`,
      );
    }
    return {
      provider,
      ctx: { secret, username, endpoint },
    };
  }
}
