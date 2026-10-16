/**
 * CodeSourceRegistry — provider registry.
 *
 * Responsibilities:
 *   1. Select enabled providers from the built-in set based on `CODE_SOURCE_ENABLED`
 *   2. Provide `get(id)` so the business layer can obtain a provider instance
 *   3. Provide `list()` to produce metadata for the frontend dropdown and form (including the auth method's form fields)
 *
 * **The registry knows nothing about any specific platform or auth method** — both live only in their own directories.
 *
 * Deployment config:
 *   CODE_SOURCE_ENABLED=<id1>,<id2>
 *   CODE_SOURCE_<UPPER_ID>_SITE_BASE_URL=...
 */

import { BUILTIN_PROVIDERS, ALWAYS_ON_PROVIDERS } from "./providers/index.js";
import type { CodeSourceMeta, ICodeSourceProvider } from "./types.js";
import { bearerAuthMethod } from "./auth-methods/bearer.js";

function env(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function envKey(id: string, suffix: string): string {
  return `CODE_SOURCE_${id.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

function joinSitePath(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function enabledIds(): string[] {
  const raw = env("CODE_SOURCE_ENABLED");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Generate frontend form metadata from the provider + deployment config.
 *
 * Token page URL = deployment-configured site root + provider's built-in site path.
 * Site root not configured → the "How to get a token?" link is not shown.
 */
function toMeta(provider: ICodeSourceProvider): CodeSourceMeta {
  const siteBase = env(envKey(provider.id, "SITE_BASE_URL"));
  const tokenPath = provider.sitePaths.tokenDoc;
  const tokenDocUrl =
    siteBase && tokenPath ? joinSitePath(siteBase, tokenPath) : siteBase ?? undefined;
  return {
    id: provider.id,
    auth_method: provider.authMethod.kind,
    form_fields: provider.authMethod.formFields,
    token_doc_url: tokenDocUrl,
  };
}

export class CodeSourceRegistry {
  private readonly providers = new Map<string, ICodeSourceProvider>();

  /**
   * @param ids explicit enabled list (for test injection); omitted → read from `CODE_SOURCE_ENABLED`
   * @param builtins built-in providers (for test injection); omitted → use BUILTIN_PROVIDERS
   */
  constructor(ids?: string[], builtins: readonly ICodeSourceProvider[] = BUILTIN_PROVIDERS) {
    const enabledSet = new Set(ids ?? enabledIds());
    // 协议级来源（ssh）恒启用：它是传输协议而非代码平台，
    // 用户填了 ssh 地址就该能用，不该受部署的 CODE_SOURCE_ENABLED 名单限制。
    for (const p of ALWAYS_ON_PROVIDERS) {
      this.providers.set(p.id, p);
    }
    for (const p of builtins) {
      if (enabledSet.has(p.id)) this.providers.set(p.id, p);
    }
    // Declared enabled but not built in → placeholder (bearer by default; register() must supply the real implementation)
    for (const id of enabledSet) {
      if (!this.providers.has(id)) {
        this.providers.set(id, {
          id,
          authMethod: bearerAuthMethod,
          sitePaths: {},
        });
      }
    }
  }

  register(provider: ICodeSourceProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): ICodeSourceProvider | undefined {
    return this.providers.get(id);
  }

  list(): CodeSourceMeta[] {
    return Array.from(this.providers.values()).map(toMeta);
  }
}
