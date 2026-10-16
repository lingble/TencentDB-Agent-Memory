/**
 * SourceFetcher interface layer — protocol-agnostic abstraction for source fetching and security validation.
 *
 * Responsibility: abstract "fetch code from some source (git/local/ftp) into a local directory" into a unified interface;
 * security validation (protocol allowlist + SSRF protection) lives in each implementation's validate().
 * Concrete implementations (e.g. GitSourceFetcher) depend on simple-git, but that dependency does not leak into this interface layer.
 */

import type { SshFetchOptions } from "./ssh-options.js";

export type SourceType = "git" | "local" | "ftp";

export interface FetchResult {
  /** Local directory where the source is written (absolute path). */
  localPath: string;
  /** Current version identifier (for git, the first 12 chars of the commit hash; null if unavailable). */
  version: string | null;
  /** Source protocol type. */
  sourceType: SourceType;
}

/**
 * Fetch options (protocol-specific).
 *
 * **Optional** for backward compatibility with existing callers and unit tests — public/private HTTPS repos
 * pass undefined and behave exactly as before.
 */
export interface GitFetchOptions {
  /**
   * SSH fetch credentials. When present, `GIT_SSH_COMMAND` is injected (private key path + known_hosts).
   * Only meaningful when sourceUrl is `git@` / `ssh://`; ignored for HTTPS.
   */
  ssh?: SshFetchOptions;
}

/**
 * Source fetcher interface. Implementers are responsible for:
 *   1. Validating sourceUrl safety (protocol allowlist, SSRF, etc.)
 *   2. Fetching/syncing source into localPath
 *   3. Returning a version identifier
 *
 * Implementations:
 *   - GitSourceFetcher: simple-git; supports public/private HTTPS and SSH (GIT_SSH_COMMAND)
 *   - LocalSourceFetcher / FtpSourceFetcher: future extensions
 */
export interface ISourceFetcher {
  /** Initial fetch: download the source into localPath. */
  fetch(sourceUrl: string, branch: string, localPath: string, opts?: GitFetchOptions): Promise<FetchResult>;

  /** Incremental sync: update an existing localPath to the latest version. */
  sync(sourceUrl: string, branch: string, localPath: string, opts?: GitFetchOptions): Promise<FetchResult>;

  /** Validate that sourceUrl is allowed (protocol allowlist + SSRF protection). Throws if invalid. */
  validate(sourceUrl: string): void;

  /** Supported protocol type. */
  readonly supportedType: SourceType;
}
