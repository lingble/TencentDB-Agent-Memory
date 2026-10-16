/**
 * file-protocol.ts — parses the FILE block protocol in LLM output and validates write paths.
 *
 * The LLM cannot write files freely; it outputs a text protocol with boundary markers, which we parse and write to disk:
 *
 *   <<<FILE path="wiki/sources/redis.md">>>
 *   ---
 *   type: source
 *   ...
 *   ---
 *   body...
 *   <<<END>>>
 *
 * A single response may contain multiple FILE blocks. Parsing must be fault-tolerant (INTERFACE §5.1 / §7):
 *   - Discard unclosed blocks (common on truncation/token overrun).
 *   - Invalid paths (outside wiki/, containing .., absolute) are skipped and recorded, without throwing.
 */

export interface ParsedFile {
  /** Normalized relative path, guaranteed to be inside wiki/ (e.g. "wiki/entities/redis.md"). */
  path: string;
  /** Full file content (including frontmatter). */
  content: string;
}

export interface ParseResult {
  files: ParsedFile[];
  /** Reasons blocks were skipped/discarded, for logging and debugging. */
  warnings: string[];
}

/**
 * Opening tag: standard is >>>; the model occasionally drops a > producing >>.
 * Accept ≥2 trailing >, to avoid "long output but files=0".
 */
const OPEN_RE = /<<<FILE\s+path\s*=\s*"([^"]*)"\s*>>+/g;
/**
 * Closing tag: standard is <<<END>>>; the model occasionally splits it into <<<\nEND>>>.
 * Only whitespace (including newlines) around END is relaxed; a literal END is still required.
 */
const CLOSE_RE = /<<<\s*END\s*>>>/g;

/**
 * Validates and normalizes the path declared by a FILE block.
 * Returns the normalized path (POSIX style, wiki/ prefix) or null (invalid, should be skipped).
 *
 * Rules:
 *   - Must be a relative path (absolute paths / drive letters rejected).
 *   - No segment after splitting may be ".." or "." (prevents traversal).
 *   - After normalization it must start with "wiki/" (only writes to wiki/** allowed).
 */
export function normalizeWikiPath(raw: string): string | null {
  if (!raw) return null;
  // Unify separators to /
  let p = raw.trim().replace(/\\/g, "/");
  if (!p) return null;
  // Reject absolute paths and Windows drive letters
  if (p.startsWith("/") || /^[a-zA-Z]:\//.test(p)) return null;
  // Strip redundant ./ prefixes
  p = p.replace(/^(\.\/)+/, "");
  const segments = p.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  // Prevent traversal: reject if any segment is .. or .
  for (const seg of segments) {
    if (seg === ".." || seg === ".") return null;
  }
  const normalized = segments.join("/");
  // Allowlist: only writes to wiki/** (and not the "wiki" directory itself)
  if (normalized !== "wiki" && !normalized.startsWith("wiki/")) return null;
  if (normalized === "wiki") return null;
  return normalized;
}

/**
 * Parses a chunk of LLM output text and extracts all valid FILE blocks.
 *
 * @param text raw LLM response text
 * @returns list of valid files + warnings (skipped blocks)
 */
export function parseFileBlocks(text: string): ParseResult {
  const files: ParsedFile[] = [];
  const warnings: string[] = [];
  if (!text) return { files, warnings };

  OPEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = OPEN_RE.exec(text)) !== null) {
    const rawPath = match[1];
    const bodyStart = OPEN_RE.lastIndex;
    CLOSE_RE.lastIndex = bodyStart;
    const closeMatch = CLOSE_RE.exec(text);

    if (!closeMatch) {
      // unclosed block → discard (usually truncated output)
      warnings.push(`Unclosed FILE block discarded: path="${rawPath}"`);
      break;
    }

    // Prevent the next match from spanning past this block's END
    const closeIdx = closeMatch.index;
    const rawContent = text.slice(bodyStart, closeIdx);
    OPEN_RE.lastIndex = closeIdx + closeMatch[0].length;

    const normPath = normalizeWikiPath(rawPath);
    if (!normPath) {
      warnings.push(`Invalid path skipped: "${rawPath}"`);
      continue;
    }

    // Strip extra blank lines at the start/end of block content, preserving frontmatter structure.
    const content = stripBlockEdges(rawContent);
    if (!content.trim()) {
      warnings.push(`Empty FILE block skipped: "${normPath}"`);
      continue;
    }

    files.push({ path: normPath, content });
  }

  return { files, warnings };
}

/** Strips the leading newline and trailing whitespace of a block, ensuring it ends with a single newline. */
function stripBlockEdges(raw: string): string {
  // Strip the first newline immediately following >>>
  let s = raw.replace(/^\r?\n/, "");
  // Strip trailing whitespace
  s = s.replace(/\s+$/, "");
  if (!s) return "";
  return s + "\n";
}
