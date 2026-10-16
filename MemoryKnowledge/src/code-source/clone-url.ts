/**
 * clone-url — low-level URL basic-auth utility + provider-aware dispatch entry point.
 *
 * Layers:
 *   - `injectBasicAuth`: pure `https://<user>:<pass>@host/...` encoding, no business logic
 *   - `buildCloneUrl`: entry point. If provider.applyToCloneUrl overrides → use the provider;
 *     otherwise delegate to provider.authMethod.buildCloneUrl (bearer/basic handled separately)
 */

import type { CredentialPayload, ICodeSourceProvider } from "./types.js";

export class CloneUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloneUrlError";
  }
}

/**
 * Low-level URL basic-auth encoding utility (no business logic, does not branch on kind).
 *
 * Input `{user, pass}` and repo URL → output `https://<user>:<pass>@host/...`.
 * Both user and pass are URL-encoded; only https is allowed.
 */
export function injectBasicAuth(
  repoUrl: string,
  auth: { user: string; pass: string },
): string {
  const cleanUrl = stripCredentials(repoUrl);
  const url = tryParse(cleanUrl);
  if (!url) throw new CloneUrlError(`invalid repo URL: ${repoUrl}`);
  if (url.protocol !== "https:") {
    throw new CloneUrlError(`repo URL must be https:// (got ${url.protocol}//)`);
  }
  if (!auth.user) throw new CloneUrlError("basic-auth user is required");
  if (!auth.pass) throw new CloneUrlError("basic-auth pass is required");
  url.username = encodeURIComponent(auth.user);
  url.password = encodeURIComponent(auth.pass);
  return url.toString();
}

/**
 * Strip credentials from a URL (the clean address written back to .git/config after clone).
 * Idempotent: a clean address is returned unchanged.
 *
 * ⚠ **SSH addresses must be returned unchanged**: the `git` in `git@` / `ssh://git@` is the SSH login user,
 * not a credential. Clearing username via `new URL()` would drop it too, producing
 * `ssh://host:2222/path.git` — GitLab/GitHub SSH endpoints only accept the `git` user,
 * so the clone would always fail auth (shows up as "SSH auth failed" even though the public key is fine).
 *
 * We don't import source-fetcher's isSshUrl to avoid a circular dependency (source-fetcher ← code-source);
 * a local check with the same rules is used here.
 */
export function stripCredentials(repoUrl: string): string {
  const v = (repoUrl ?? "").trim();
  // SSH：scp 写法 `git@host:path` 与标准 `ssh://` 写法都没有 HTTP 凭据可剥。
  if (v.startsWith("git@") || v.startsWith("ssh://")) return repoUrl;

  const url = tryParse(v);
  if (!url) return repoUrl;
  url.username = "";
  url.password = "";
  return url.toString();
}

function tryParse(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/**
 * Provider-aware dispatch entry point.
 *
 * Priority:
 *   1. `provider.applyToCloneUrl` (provider takes over completely)
 *   2. `provider.authMethod.buildCloneUrl` (default, dispatched by auth method)
 */
export function buildCloneUrl(
  provider: ICodeSourceProvider,
  repoUrl: string,
  cred: CredentialPayload,
): string {
  if (provider.applyToCloneUrl) {
    return provider.applyToCloneUrl(repoUrl, cred);
  }
  return provider.authMethod.buildCloneUrl(repoUrl, cred, provider.cloneUsername);
}
