/**
 * frontmatter.ts — parsing and construction of YAML frontmatter.
 *
 * Output pages must carry valid YAML frontmatter (relied on by the existing manager scanWikiDir/BM25/graph):
 *   type (required) / title / sources (our extension) / description / tags / timestamp (OKF recommended)
 *
 * Provides:
 *   - parseFrontmatter: splits page content into a frontmatter object + body (for merging/reading locked).
 *   - buildPage: assembles frontmatter fields + body into compliant page content (used when producing/rewriting).
 *   - isLocked / readSources: convenience readers used by the merge logic.
 *
 * Parses with the repo's existing `yaml` dependency; tolerant consumption (bad frontmatter doesn't throw, treated as empty).
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface PageFrontmatter {
  type: string;
  title?: string;
  description?: string;
  sources?: string[];
  tags?: string[];
  timestamp?: string;
  locked?: boolean;
  /** Preserve any extra fields so they survive round-trips (OKF tolerant-consumption spirit). */
  [key: string]: unknown;
}

export interface ParsedPage {
  frontmatter: PageFrontmatter;
  body: string;
  /** Whether a frontmatter block was successfully parsed. */
  hasFrontmatter: boolean;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Splits page content into frontmatter + body. Returns a `{type:"other"}` placeholder when there is no frontmatter.
 * Degrades gracefully on parse failure (bad YAML) without throwing.
 */
export function parseFrontmatter(content: string): ParsedPage {
  const text = content ?? "";
  const m = text.match(FM_RE);
  if (!m) {
    return { frontmatter: { type: "other" }, body: text, hasFrontmatter: false };
  }
  const yamlText = m[1];
  const body = text.slice(m[0].length);
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return { frontmatter: { type: "other" }, body, hasFrontmatter: false };
  }
  if (!parsed || typeof parsed !== "object") {
    return { frontmatter: { type: "other" }, body, hasFrontmatter: false };
  }
  const fm = parsed as Record<string, unknown>;
  const type = typeof fm.type === "string" && fm.type.trim() ? fm.type : "other";
  return { frontmatter: { ...fm, type } as PageFrontmatter, body, hasFrontmatter: true };
}

/** Whether the target page was manually locked by the user (page/write injects locked:true). Ingest must skip locked pages. */
export function isLocked(content: string): boolean {
  const { frontmatter } = parseFrontmatter(content);
  return frontmatter.locked === true;
}

/** Reads the page's declared sources list (relied on by raw/rm cascade). */
export function readSources(content: string): string[] {
  const { frontmatter } = parseFrontmatter(content);
  const s = frontmatter.sources;
  if (Array.isArray(s)) return s.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Assembles frontmatter + body into compliant page content.
 *
 * - `type` is required; defaults to "other" when missing (OKF: consumers tolerate unknown types).
 * - Never writes the `locked` field (only page/write injects it; pages we produce never carry locked).
 * - Fixed field order (type→title→description→sources→tags→timestamp→others) for stable readability.
 */
export function buildPage(frontmatter: PageFrontmatter, body: string): string {
  const fm: Record<string, unknown> = {};
  fm.type = (frontmatter.type ?? "other").toString();
  if (frontmatter.title != null) fm.title = frontmatter.title;
  if (frontmatter.description != null) fm.description = frontmatter.description;
  if (frontmatter.sources != null) fm.sources = frontmatter.sources;
  if (frontmatter.tags != null) fm.tags = frontmatter.tags;
  if (frontmatter.timestamp != null) fm.timestamp = frontmatter.timestamp;
  // Pass through other custom fields (excluding locked / already-handled fields)
  for (const [k, v] of Object.entries(frontmatter)) {
    if (["type", "title", "description", "sources", "tags", "timestamp", "locked"].includes(k)) continue;
    if (v != null) fm[k] = v;
  }

  const yamlText = stringifyYaml(fm).trimEnd();
  const cleanBody = (body ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
  return `---\n${yamlText}\n---\n\n${cleanBody}\n`;
}
