/**
 * safe-path.ts — boundary check for on-disk write paths.
 *
 * Ingest write paths are derived indirectly from LLM output (FILE block path + frontmatter type).
 * A mistake anywhere in that derivation chain could produce a relative path that escapes the
 * project directory. This provides a final gate independent of the derivation logic: only accept
 * paths that "still lie within root after resolving to an absolute path".
 */

import { resolve, sep } from "node:path";

/**
 * Whether candidate, once resolved, still lies within root (root itself counts).
 *
 * Both sides go through resolve before comparing, so `..`, `.`, and repeated separators are collapsed;
 * the prefix comparison also appends a separator so `/data/proj-evil` is not considered inside `/data/proj`.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep);
}
