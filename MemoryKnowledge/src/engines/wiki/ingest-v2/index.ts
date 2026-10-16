/**
 * index.ts — ingest engine entry point.
 *
 * Two-stage model (wiki-ingest-optimization):
 *   1. extractSource() — pure LLM extraction, returns a Map of candidate pages (can run concurrently)
 *   2. commitCandidates() — serial merge + write to disk + index.md/log.md finalization
 *
 * ingestSource() is kept as a thin wrapper (= extract + commit in series), so existing unit tests/external callers are unchanged. */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { LimitFunction } from "p-limit";
import { createLlmClient, type LlmClient, type RawLlmConfig } from "./llm.js";
import { loadTemplate } from "./template.js";
import {
  buildSystemPrompt,
  buildGeneratePrompt,
  buildAnalysisSystemPrompt,
  buildAnalysisPrompt,
  buildGenerateFromAnalysisPrompt,
  type ExistingPageInfo,
} from "./prompts.js";
import { parseFileBlocks } from "./file-protocol.js";
import { parseFrontmatter, buildPage } from "./frontmatter.js";
import { mergePage, type MergeOptions } from "./merge.js";
import { chunkText } from "./chunker.js";
import { slugify, dirForType } from "./slug.js";
import { isInsideRoot } from "./safe-path.js";
import { rebuildIndexFile } from "./index-builder.js";
import { appendIngestLog, appendIngestLogBatch } from "./log-writer.js";
import { createLogger } from "../../../logger.js";

const log = createLogger("wiki-ingest");

/** Dumps the raw output to disk when generate parsing fails, to help debug the FILE protocol (does not change the success path). */
export function dumpGenerateFailure(args: {
  projectPath: string;
  sourceName: string;
  chunkTag: string;
  output: string;
  reason: string;
}): string | null {
  const { projectPath, sourceName, chunkTag, output, reason } = args;
  try {
    const debugDir = join(projectPath, "_debug");
    mkdirSync(debugDir, { recursive: true });
    const safeSource = sourceName.replace(/[^\w.\-]+/g, "_");
    const safeChunk = chunkTag.replace(/[^\w.\-#]+/g, "_");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(debugDir, `generate-fail-${safeSource}-${safeChunk}-${ts}.txt`);
    const header = [
      `# generate failure dump`,
      `# source=${sourceName}`,
      `# chunk=${chunkTag}`,
      `# reason=${reason}`,
      `# outputChars=${output.length}`,
      `# dumpedAt=${new Date().toISOString()}`,
      ``,
      ``,
    ].join("\n");
    writeFileSync(file, header + output, "utf-8");
    return file;
  } catch (err) {
    log.warn("Failed to dump raw generate failure output to disk", { source: sourceName, error: String(err) });
    return null;
  }
}

/** Structural files that ingest may not write/overwrite (PRD §3.7-2). */
const STRUCTURAL_FILES = new Set([
  "wiki/index.md",
  "wiki/schema.md",
  "wiki/purpose.md",
  "wiki/log.md",
  "wiki/overview.md",
]);

/** Rough context budget (characters): leaves headroom for the prompt scaffolding and output. */
const SOURCE_CHAR_BUDGET = 28_000;

export interface IngestOptions {
  /** Injected LLM client (for tests); if omitted, a real client is built from llmConfig. */
  llm?: LlmClient;
  /** When merging, use append mode if the old page body exceeds this many characters (OQ-1); merge default if omitted. */
  mergeFullRewriteMaxChars?: number;
  /**
   * Ingest flow (OQ-4):
   *   - "two-stage" (default): analyze first (extraction plan), then generate FILE blocks; more stable quality.
   *   - "single-stage": produce FILE blocks directly from the full source (one fewer LLM call, saves tokens).
   */
  mode?: "two-stage" | "single-stage";
}

export interface CommitResult {
  written: string[];
  /** Per-page failure records from the merge stage (do not affect other pages) */
  mergeErrors: Array<{ relPath: string; source: string; error: string }>;
}

export interface CommitOptions extends MergeOptions {
  /** Global LLM semaphore (LLM merge calls inside mergePage are rate-limited by it) */
  globalLlmLimit?: LimitFunction;
  /** Skip writing the batch log (when called via the thin wrapper, the outer layer writes the single-source log itself) */
  skipLog?: boolean;
}

/**
 * Stage 1: calls the LLM on a single source file to generate candidate wiki pages (in memory only, nothing written to disk).
 * Safe to call concurrently.
 *
 * Empty-candidate semantics: candidates.size === 0 is treated as failure (throw), consistent with existing behavior.
 */
export async function extractSource(
  projectPath: string,
  sourcePath: string,
  llmConfig: RawLlmConfig,
  existingPages: ExistingPageInfo[],
  options: IngestOptions = {},
): Promise<Map<string, string>> {
  if (!existsSync(sourcePath)) throw new Error(`Source file does not exist: ${sourcePath}`);
  const sourceText = readFileSync(sourcePath, "utf-8");
  const sourceName = basename(sourcePath);
  if (!sourceText.trim()) throw new Error(`Source file is empty: ${sourceName}`);

  const llm = options.llm ?? createLlmClient(llmConfig);
  const template = loadTemplate(projectPath);
  const systemPrompt = buildSystemPrompt(template);
  const mode = options.mode ?? "two-stage";

  const chunks =
    sourceText.length > SOURCE_CHAR_BUDGET
      ? chunkText(sourceText, { targetChars: SOURCE_CHAR_BUDGET })
      : [sourceText];

  log.info("extractSource started", {
    source: sourceName,
    sourceChars: sourceText.length,
    mode,
    chunks: chunks.length,
    existingPages: existingPages.length,
    templateCustomized: template.customized,
  });

  const candidates = new Map<string, string>();
  const warnings: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkLabel = chunks.length > 1 ? `${sourceName} (chunk ${i + 1}/${chunks.length})` : sourceName;
    const tag = chunks.length > 1 ? `${sourceName}#${i + 1}` : sourceName;

    let out: string;
    if (mode === "two-stage") {
      log.debug("Stage A analysis started", { chunk: tag });
      const analysis = await llm.chat({
        system: buildAnalysisSystemPrompt(template),
        prompt: buildAnalysisPrompt({ sourceName: chunkLabel, sourceText: chunks[i], existingPages }),
        label: `analysis:${tag}`,
      });
      log.debug("Stage A analysis completed", { chunk: tag, analysisChars: analysis.length, empty: !analysis.trim() });
      log.debug("Stage A analysis preview", { chunk: tag, preview: analysis.slice(0, 200) });
      const genPrompt = analysis.trim()
        ? buildGenerateFromAnalysisPrompt({ sourceName: chunkLabel, sourceText: chunks[i], analysis, existingPages })
        : buildGeneratePrompt({ sourceName: chunkLabel, sourceText: chunks[i], existingPages });
      if (!analysis.trim()) log.warn("Analysis empty, falling back to single-stage generation", { chunk: tag });
      out = await llm.chat({ system: systemPrompt, prompt: genPrompt, label: `generate:${tag}` });
    } else {
      const prompt = buildGeneratePrompt({ sourceName: chunkLabel, sourceText: chunks[i], existingPages });
      out = await llm.chat({ system: systemPrompt, prompt, label: `generate:${tag}` });
    }

    const { files, warnings: w } = parseFileBlocks(out);
    warnings.push(...w);
    log.debug("FILE block parsing", { chunk: tag, outChars: out.length, files: files.length, warnings: w.length });
    if (files.length === 0 && out.trim()) {
      const dumpPath = dumpGenerateFailure({
        projectPath,
        sourceName,
        chunkTag: tag,
        output: out,
        reason: w.length ? `parse_empty warnings=${w.length}` : "parse_empty files=0",
      });
      if (dumpPath) log.warn("generate produced no valid FILE blocks, output dumped to disk", { source: sourceName, dumpPath });
    }
    for (const f of files) {
      const canonicalPath = canonicalizePagePath(f.path, f.content);
      if (STRUCTURAL_FILES.has(canonicalPath)) {
        warnings.push(`Skipped structural file: ${canonicalPath}`);
        continue;
      }
      candidates.set(canonicalPath, ensureSources(f.content, sourceName));
    }
  }

  if (candidates.size === 0) {
    log.error("No valid wiki pages generated", { source: sourceName, warnings });
    throw new Error(
      `No valid wiki pages generated (no files generated): ${sourceName}${warnings.length ? ` [${warnings.join("; ")}]` : ""}`,
    );
  }

  log.info("extractSource completed", { source: sourceName, candidates: candidates.size, warnings: warnings.length });
  return candidates;
}

/**
 * Stage 2: serial write to disk + finalization.
 * - Groups candidate pages from all sources by relPath and merges page by page.
 * - try/catch per page: a single page's merge failure doesn't block other pages.
 * - mergePage may call the LLM internally; this is rate-limited globally via globalLlmLimit.
 * - After everything is written, runs rebuildIndexFile + appendIngestLogBatch once.
 */
export async function commitCandidates(
  projectPath: string,
  allCandidates: Array<{ sourceFilename: string; candidates: Map<string, string> }>,
  /** May be omitted when there are no candidate pages (index rebuild only); if candidates exist but it's missing, those pages are recorded in mergeErrors. */
  llm: LlmClient | undefined,
  options?: CommitOptions,
): Promise<CommitResult> {
  const { globalLlmLimit, skipLog, ...mergeOpts } = options ?? {};

  const byPage = new Map<string, Array<{ source: string; content: string }>>();
  for (const { sourceFilename, candidates } of allCandidates) {
    for (const [relPath, content] of candidates) {
      if (!byPage.has(relPath)) byPage.set(relPath, []);
      byPage.get(relPath)!.push({ source: sourceFilename, content });
    }
  }

  const written: string[] = [];
  const mergeErrors: CommitResult["mergeErrors"] = [];

  for (const [relPath, entries] of byPage) {
    const fullPath = join(projectPath, relPath);
    // Final boundary gate: relPath is derived indirectly from LLM output, so confirm it doesn't escape the project directory.
    // Must happen before the readFileSync below — otherwise out-of-bounds file content would be read into the merge prompt and leaked.
    if (!isInsideRoot(projectPath, fullPath)) {
      for (const entry of entries) {
        mergeErrors.push({
          relPath,
          source: entry.source,
          error: `path escapes project root: ${relPath}`,
        });
      }
      log.error("Blocked out-of-bounds write path", { relPath, projectPath });
      continue;
    }
    let existing = existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : null;

    for (const entry of entries) {
      if (!llm) {
        mergeErrors.push({
          relPath,
          source: entry.source,
          error: "LLM client unavailable",
        });
        continue;
      }
      try {
        const decision = globalLlmLimit
          ? await globalLlmLimit(() => mergePage(existing, entry.content, llm, mergeOpts))
          : await mergePage(existing, entry.content, llm, mergeOpts);
        if (decision.action === "skip") {
          log.debug("Skipped page (locked)", { relPath, source: entry.source });
          continue;
        }
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, decision.content, "utf-8");
        existing = decision.content;
        if (!written.includes(relPath)) written.push(relPath);
        log.debug("Wrote to disk", { relPath, source: entry.source, bytes: decision.content.length });
      } catch (err) {
        mergeErrors.push({ relPath, source: entry.source, error: String(err) });
        log.error("Page merge failed", { relPath, source: entry.source, error: String(err) });
      }
    }
  }

  try {
    rebuildIndexFile(projectPath);
  } catch (err) {
    log.warn("index.md rebuild failed (main flow unaffected)", { error: String(err) });
  }

  try {
    if (!skipLog) {
      appendIngestLogBatch(projectPath, {
        sourcesProcessed: allCandidates.map((c) => c.sourceFilename),
        pagesWritten: written,
        mergeErrors: mergeErrors.map((e) => `${e.relPath} (from ${e.source}): ${e.error}`),
      });
    }
  } catch (err) {
    log.warn("log.md write failed (main flow unaffected)", { error: String(err) });
  }

  return { written, mergeErrors };
}

/**
 * Full single-source flow (extract + merge + index.md + log.md),
 * equivalent to extractSource → commitCandidates run in series.
 * Existing unit tests and direct external callers need no changes.
 */
export async function ingestSource(
  projectPath: string,
  sourcePath: string,
  llmConfig: RawLlmConfig,
  options: IngestOptions = {},
): Promise<string[]> {
  const existingPages = scanExistingPages(projectPath);
  const candidates = await extractSource(projectPath, sourcePath, llmConfig, existingPages, options);
  const llm = options.llm ?? createLlmClient(llmConfig);
  const sourceName = basename(sourcePath);
  const { written } = await commitCandidates(
    projectPath,
    [{ sourceFilename: sourceName, candidates }],
    llm,
    { fullRewriteMaxChars: options.mergeFullRewriteMaxChars, skipLog: true },
  );
  if (written.length === 0) {
    log.warn("No pages written (all skipped as locked)", { source: sourceName });
    return [];
  }
  try {
    appendIngestLog(projectPath, sourceName, written.length);
  } catch (err) {
    log.warn("log.md append failed", { error: err instanceof Error ? err.message : String(err) });
  }
  log.info("ingestSource completed", { source: sourceName, written: written.length });
  return written;
}

/** Scans wiki/ for condensed info about existing pages (for the LLM to decide create vs. update). Excludes structural files. */
export function scanExistingPages(projectPath: string): ExistingPageInfo[] {
  const wikiDir = join(projectPath, "wiki");
  if (!existsSync(wikiDir)) return [];
  const out: ExistingPageInfo[] = [];
  walk(wikiDir, wikiDir, out);
  return out;
}

function walk(baseDir: string, dir: string, out: ExistingPageInfo[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry !== "media") walk(baseDir, full, out);
    } else if (entry.endsWith(".md")) {
      const rel = `wiki/${full.slice(baseDir.length + 1).replace(/\\/g, "/")}`;
      if (STRUCTURAL_FILES.has(rel)) continue;
      try {
        const content = readFileSync(full, "utf-8");
        const { frontmatter } = parseFrontmatter(content);
        out.push({
          relPath: rel,
          title: typeof frontmatter.title === "string" ? frontmatter.title : basename(entry, ".md"),
          type: frontmatter.type,
          description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
        });
      } catch {
        /* skip bad pages */
      }
    }
  }
}

/**
 * Ensures the candidate page's frontmatter sources includes at least the current source filename (§3.7-3 / AC-10).
 * The LLM may omit or get sources wrong, so the current source is forcibly added here.
 */
export function ensureSources(content: string, sourceName: string): string {
  const parsed = parseFrontmatter(content);
  const cur = Array.isArray(parsed.frontmatter.sources)
    ? parsed.frontmatter.sources.filter((x): x is string => typeof x === "string")
    : [];
  if (cur.includes(sourceName)) return content;
  return buildPage({ ...parsed.frontmatter, sources: [...cur, sourceName] }, parsed.body);
}

/**
 * OQ-6: normalizes the page write path to keep dedup stable.
 *
 * The path chosen by the LLM (e.g. `wiki/entity/redis.md`) may not match our directory convention (`wiki/entities/redis.md`),
 * or it may give different slugs for the same entity across ingests, breaking the "same entity → same path" dedup invariant.
 *
 * Strategy: prefer deriving the canonical path from the page frontmatter's `type` + `title` via `pageRelPath`
 * (directory determined by type, filename by the title slug, consistent with dedup matching logic).
 * When frontmatter lacks type/title, fall back to "normalizing the directory segment of the LLM's original path" —
 * i.e. normalize the directory via `dirForType` (entity→entities) and keep the original slug as the filename.
 *
 * @param llmPath  path declared by the LLM in the FILE block (already passed the normalizeWikiPath allowlist check)
 * @param content  full page content (including frontmatter)
 * @returns normalized wiki-relative path (always starts with `wiki/`)
 */
export function canonicalizePagePath(llmPath: string, content: string): string {
  const { frontmatter } = parseFrontmatter(content);
  const type = typeof frontmatter.type === "string" ? frontmatter.type.trim() : "";
  const title = typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";

  if (type && title) {
    const slug = slugify(title);
    if (slug) return `wiki/${dirForType(type)}/${slug}.md`;
  }

  const segments = llmPath.split("/");
  const fileName = segments[segments.length - 1];
  if (segments.length >= 3) {
    const dirSeg = segments[1];
    const canonicalDir = type ? dirForType(type) : dirForType(dirSeg);
    const middle = segments.slice(2, -1);
    return ["wiki", canonicalDir, ...middle, fileName].join("/");
  }
  return llmPath;
}
