/**
 * Wiki import runner — fetch remote documents → write to disk (does not trigger ingest).
 *
 * Rules from doc §3.1 step ⑤:
 *   - Batched fetch: 20 per batch (fetchPages batch preferred, falling back to one by one if unsupported)
 *   - On-disk filename `<title>.md`: readability first; duplicate/empty titles are deduplicated or fall back to the external id (see buildFilename)
 *   - Batched writes: ≤10 files / ≤5MB (constrained by wikiService.rawWriteMany)
 *   - Inter-document delay: WIKI_IMPORT_PAGE_DELAY_MS (default 200ms, to avoid external API rate limits)
 */

import type { WikiSourceRegistry } from "./registry.js";
import type { RemotePageContent, SourceContext, WikiSourceProvider } from "./types.js";
import type { RawWriteManyItem, WriteOutcome } from "../store/wiki-service.js";

/**
 * Minimal interface of the wiki service used for writing to disk (easy to stub in tests).
 *
 * The real WikiService.rawWriteMany returns WriteOutcome<RawWriteManyItem[]>:
 *   - success → array of written items (length = number of files written)
 *   - wiki not found → null
 *   - currently processing → "processing"
 */
/**
 * Reuse the real WriteOutcome to avoid a local enum missing failure states
 * (the real definition includes null / "processing" / "invalid_path" / "forbidden_path" / "too_large").
 */
export type RawWriteOutcome = WriteOutcome<RawWriteManyItem[]>;

export interface WikiServiceLike {
  rawWriteMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    files: Array<{ filename: string; content: string }>,
  ): RawWriteOutcome | Promise<RawWriteOutcome>;

  /**
   * Stable filename mapping (optional). Implemented by WikiService: persists externalId → filename
   * into the wiki directory so that **imports across rounds** reuse the same filename.
   *
   * Why: on-disk filenames come from titles, and titles change. Scheduled sync re-fetches everything each round,
   * and usedNames dedup is only valid within a single round, so a remote rename leads to:
   *   new title → new file; another doc still using the old title → reuses the old name and overwrites → content mix-up + leftovers.
   *
   * Not implemented (test stub / legacy implementation) → falls back to the old title-based behavior.
   */
  readImportNameMap?(
    serviceId: string,
    teamId: string,
    wikiId: string,
    providerId: string,
  ): Record<string, string>;
  writeImportNameMap?(
    serviceId: string,
    teamId: string,
    wikiId: string,
    providerId: string,
    map: Record<string, string>,
  ): void;
}

const BATCH_SIZE = 20;
const WRITE_BATCH_FILES = 10;
const WRITE_BATCH_BYTES = 5 * 1024 * 1024;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

export interface ImportParams {
  registry: WikiSourceRegistry;
  wikiService: WikiServiceLike;
  providerId: string;
  secret: string;
  username?: string;
  serviceId: string;
  teamId: string;
  wikiId: string;
  sourceUrl: string;
  /** Pages to import; omitted → all non-directory nodes. */
  pageIds?: string[];
}

export interface ImportResult {
  imported: number;
  skippedDirs: number;
  failed: Array<{ id: string; error: string }>;
  warnings: string[];
}

export async function runImport(p: ImportParams): Promise<ImportResult> {
  const { provider, ctx } = p.registry.contextFor(p.providerId, p.secret, p.username);

  const root = await provider.resolveRoot(ctx, p.sourceUrl);
  const all = await provider.listPages(ctx, root);

  // Directory nodes are not downloadable
  const targets = p.pageIds?.length
    ? all.filter((n) => !n.isDir && p.pageIds!.includes(n.externalId))
    : all.filter((n) => !n.isDir);
  const skippedDirs = all.length - targets.length;

  const pageDelayMs = Number(process.env.WIKI_IMPORT_PAGE_DELAY_MS ?? 200) || 0;

  const failed: Array<{ id: string; error: string }> = [];
  const warnings: string[] = [];
  let imported = 0;
  // Kept for the whole import round, so different batches don't produce same-named files that overwrite each other
  const usedNames = new Set<string>();
  // Titles from the listing phase (listPages) are reliable, while content from fetchPage often lacks a title
  // (many platforms' content APIs return only the body, no title), so these titles are used as the fallback when writing.
  const titleById = new Map(targets.map((t) => [t.externalId, t.title]));

  // ── Stable filenames: externalId → filename (reused across rounds) ──
  // Titles change and cannot serve as identity; previously imported documents always reuse their historical filename.
  const canUseMap =
    typeof p.wikiService.readImportNameMap === "function" &&
    typeof p.wikiService.writeImportNameMap === "function";
  const nameByExternalId: Record<string, string> | null = canUseMap
    ? p.wikiService.readImportNameMap!(p.serviceId, p.teamId, p.wikiId, p.providerId)
    : null;
  if (nameByExternalId) {
    // Reserve historical filenames first: prevents new documents from generating the same name and displacing old ones
    for (const fn of Object.values(nameByExternalId)) {
      if (fn) usedNames.add(fn);
    }
  }

  for (const batch of chunk(targets, BATCH_SIZE)) {
    const ids = batch.map((t) => t.externalId);

    let contents: RemotePageContent[];
    if (provider.fetchPages) {
      try {
        contents = await provider.fetchPages(ctx, ids);
      } catch (err) {
        // Batch failed → fall back to one by one
        warnings.push(
          `batch fetch failed, falling back to per-page: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        contents = await fetchOneByOne(provider, ctx, ids, failed, pageDelayMs);
      }
    } else {
      contents = await fetchOneByOne(provider, ctx, ids, failed, pageDelayMs);
    }

    for (const c of contents) {
      if (c.fidelity === "lossy") warnings.push(`${c.externalId}: content lossy`);
    }

    // Write to disk: filename uses the title (readable); the external id is only a fallback for name collisions
    const files = contents
      .filter((c) => c.markdown)
      .map((c) => {
        // c.title may be empty (provider returns only the body); fall back to the listing-phase title
        const title = c.title || titleById.get(c.externalId);
        // Previously imported → reuse historical filename: remote renames won't mix up content or create junk files
        const known = nameByExternalId?.[c.externalId];
        const filename = known || buildFilename(title, c.externalId, usedNames);
        if (nameByExternalId) nameByExternalId[c.externalId] = filename;
        return { filename, content: c.markdown };
      });

    for (const writeBatch of packByLimit(files, WRITE_BATCH_FILES, WRITE_BATCH_BYTES)) {
      const res = await p.wikiService.rawWriteMany(
        p.serviceId,
        p.teamId,
        p.wikiId,
        writeBatch,
      );
      // WriteOutcome: array = success; anything else is a failure state (null / processing / invalid_path / forbidden_path / too_large)
      if (!Array.isArray(res)) {
        if (res === "processing") {
          warnings.push(`wiki ${p.wikiId} is processing, batch skipped`);
          continue;
        }
        throw new Error(`rawWriteMany failed for wiki ${p.wikiId}: ${String(res)}`);
      }
      imported += res.length;
    }
  }

  // Persist the mapping: files are already written; a save failure does not block this round's result (only affects reuse next round)
  if (canUseMap && nameByExternalId) {
    p.wikiService.writeImportNameMap!(
      p.serviceId,
      p.teamId,
      p.wikiId,
      p.providerId,
      nameByExternalId,
    );
  }

  return { imported, skippedDirs, failed, warnings };
}

async function fetchOneByOne(
  provider: WikiSourceProvider,
  ctx: SourceContext,
  ids: string[],
  failed: Array<{ id: string; error: string }>,
  delayMs: number,
): Promise<RemotePageContent[]> {
  const out: RemotePageContent[] = [];
  for (const id of ids) {
    try {
      out.push(await provider.fetchPage(ctx, id));
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
    await delay(delayMs);
  }
  return out;
}

/**
 * Generate the on-disk filename: `<title>.md` (readable, so users can recognize it in the raw list).
 *
 * The readability advantage over "naming by external id" comes at the cost that title changes produce new filenames.
 * Three layers of protection prevent renames/duplicates from losing files or overwriting each other:
 *   1. Sanitize: strip path separators and control characters, preventing directory traversal and illegal filenames
 *   2. Truncate: overly long titles are cut to 120 chars (filesystems commonly cap at 255 bytes; leaves room for multi-byte CJK)
 *   3. Dedupe: append -2 / -3… on collisions; an empty title falls back to the page's external id
 *
 * `usedNames` is held by the caller across batches, guaranteeing uniqueness within an import round.
 */
function buildFilename(
  title: string | undefined,
  externalId: string,
  usedNames: Set<string>,
): string {
  const cleaned = (title ?? "")
    // Strip path separators and Windows reserved characters, preventing directory traversal
    .replace(/[/\\:*?"<>|]/g, "")
    // Strip control characters (newlines/tabs, etc.) so filenames contain no invisible characters
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/^\.+/, "") // avoid special names like . / ..
    .slice(0, 120) // filesystems commonly cap at 255 bytes; leaves room for multi-byte CJK
    .trim();

  const base = cleaned || externalId;
  let name = `${base}.md`;
  let n = 2;
  while (usedNames.has(name)) {
    name = `${base}-${n}.md`;
    n += 1;
  }
  usedNames.add(name);
  return name;
}

/** Split into packages under dual limits of "file count + byte size". */
function packByLimit(
  files: Array<{ filename: string; content: string }>,
  maxFiles: number,
  maxBytes: number,
): Array<Array<{ filename: string; content: string }>> {
  const out: Array<Array<{ filename: string; content: string }>> = [];
  let cur: Array<{ filename: string; content: string }> = [];
  let curBytes = 0;

  for (const f of files) {
    const size = Buffer.byteLength(f.content, "utf-8");
    if (
      cur.length > 0 &&
      (cur.length + 1 > maxFiles || curBytes + size > maxBytes)
    ) {
      out.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += size;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
