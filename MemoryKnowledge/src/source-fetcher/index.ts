/**
 * source-fetcher barrel — public exports of the source fetching interface layer.
 */

export type { ISourceFetcher, FetchResult, SourceType, GitFetchOptions } from "./types.js";
export {
  GitSourceFetcher,
  isGitAuthError,
  explainGitAuthError,
  isSshAuthError,
  type GitSourceFetcherOptions,
} from "./git-fetcher.js";
export { SourceFetcherRegistry } from "./registry.js";
export {
  isSshUrl,
  parseSshHost,
  buildSshCommand,
  type SshFetchOptions,
} from "./ssh-options.js";
