/**
 * code-constants - constants, types and pure utility functions for the Code asset page.
 * Split out of CodeSourcesPanel.tsx.
 *
 * Common asset types and formatShortTime have moved to @/lib/asset-common; they are re-exported here
 * to keep the existing import paths unchanged.
 */
export type { SubView, ViewMode, StatusFilter, ScopeTab } from '@/lib/asset-common';
export { formatShortTime } from '@/lib/asset-common';

/**
 * Check whether this is a valid HTTP(S) Git repo URL (regex match).
 * Requirements: http/https scheme, host contains a dot (real domain), path has no spaces and ends with .git.
 * Regex instead of URL parsing - new URL() accepts spaces in the path (e.g. /a b/repo.git)
 * and doesn't enforce the .git suffix, neither of which meets the strict constraints of code graph registration.
 * SSH (git@...) is not treated as true here - SSH is checked by isSshGitUrl / isValidGitUrl.
 */
const GIT_HTTP_URL_RE = /^https?:\/\/[^\s/]+\.[^\s/]+\/[^\s]+\.git$/i;
export function isValidGitHttpUrl(raw: string): boolean {
  return GIT_HTTP_URL_RE.test(raw.trim());
}

/**
 * SSH Git repo URL regex. Two forms:
 *   - scp form: `git@host:namespace/repo.git` (host may be a domain or an internal hostname)
 *   - standard form: `ssh://[user@]host[:port]/namespace/repo.git` (port optional, default 22)
 *
 * Constraints match the HTTPS version: no spaces in the path, ends with .git.
 * `git://` (plaintext, no auth) and file:// (local path) are not allowed.
 */
const GIT_SSH_SCP_RE = /^git@[^\s/:@]+:[^\s]+\.git$/i;
const GIT_SSH_URL_RE = /^ssh:\/\/(?:[^\s/@]+@)?[^\s/:@]+(?::\d+)?\/[^\s]+\.git$/i;

export function isSshGitUrl(raw: string): boolean {
  const v = (raw ?? '').trim();
  return GIT_SSH_SCP_RE.test(v) || GIT_SSH_URL_RE.test(v);
}

/** Unified URL check for the registration form: passes if either HTTP(S) or SSH is valid. */
export function isValidGitUrl(raw: string): boolean {
  return isValidGitHttpUrl(raw) || isSshGitUrl(raw);
}

/** id of the SSH source in the "source" dropdown (kept in sync with KS's SSH_PROVIDER_ID). */
export const SSH_SOURCE_ID = 'ssh';

/**
 * Extract a readable repo name from a Git URL.
 *
 * repo_name may be empty (old data), in which case falling back to the URL looks very long.
 * Here the last two path segments of the URL are extracted in `namespace/repo` format:
 *   https://<host>/namespace/repo.git → namespace/repo
 *   https://<host>/org/project.git → org/project
 *   https://<host>/group/sub/repo.git → sub/repo
 * If there is only one path segment, return it directly (without the .git suffix).
 * On parse failure return the original URL (fallback).
 */
export function formatRepoName(repoName: string, repoUrl: string): string {
  if (repoName && !repoName.startsWith('http')) return repoName;
  const url = repoName || repoUrl;
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (segments.length >= 2) return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    if (segments.length === 1) return segments[0];
  } catch {
    // fallback
  }
  return url;
}
