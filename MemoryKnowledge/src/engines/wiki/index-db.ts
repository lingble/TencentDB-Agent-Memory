/**
 * Per-wiki `index.db` connection management (design 006).
 *
 * Each wiki has its own SQLite file `index.db` in that wiki's data directory (same directory and
 * lifecycle as the `.md` content), holding all of the wiki's private index data:
 *   - `wiki_fts`   FTS5 pre-tokenized inverted index (BM25 full-text search)
 *   - `page_meta`  page metadata (title/type/rel_path/snippet; body is not stored in the DB, it stays on disk)
 *   - `graph_edge` knowledge graph directed edges (for multi-hop BFS)
 *   - `source`     source files as first-class entities (incremental detection + lifecycle; DDL created this round, read/write methods in phase 003)
 *
 * Connection strategy (design §4):
 *   - Write (ingest/sync: rebuild FTS5 + graph_edge + update source): **dedicated connection**, done within a transaction
 *     → `wal_checkpoint(TRUNCATE)` → `close()`; not pooled, avoiding races with LRU eviction from the read pool.
 *   - Read (search/graph): uses the **LRU connection pool**; hot wikis stay resident, cold wikis are evicted.
 *
 * Memory cap = POOL_MAX × cache_size (~600MB), decoupled from the total number of wikis; opening a SQLite connection
 * takes sub-milliseconds and data is lazily loaded per page, not "fully loaded into memory on open" — which is exactly why it fixes the MiniSearch 20GB OOM.
 *
 * fd constraint (design §4.3): with WAL each connection uses 3 fds (db+wal+shm); `POOL_MAX × 3 + headroom` must be ≤ ulimit -n.
 * POOL_MAX is tied to the deployment ulimit; default 300 (~900 fds, ulimit -n ≥ 2048 recommended).
 */

import Database from "better-sqlite3";
import { LRUCache } from "lru-cache";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Read connection pool cap. Tied to the deployment ulimit (WAL uses 3 fds per connection; requires ulimit -n ≥ POOL_MAX*3 + headroom).
 * Can be overridden via environment variable (only for tests or special deployments); default 300.
 */
const POOL_MAX = (() => {
  const raw = process.env.KNOWLEDGE_WIKI_POOL_MAX;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 300;
})();

/** Per-connection page cache cap (KB); cache_size uses a negative number to mean KB. */
const CACHE_KB = 2000;

/** Evicts/closes a read connection: checkpoint to merge the WAL first, then close. Fails silently (the connection may be broken). */
function disposeDb(db: Database.Database): void {
  try {
    if (db.open) {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    }
  } catch {
    /* best-effort: the connection may already be closed or the file deleted */
  }
}

/**
 * Read connection LRU pool (lru-cache, MIT): hot wiki connections stay resident, cold wikis are evicted.
 * Both eviction (exceeding max) and explicit `delete` (wiki deletion) trigger `dispose` → checkpoint + close.
 */
const readPool = new LRUCache<string, Database.Database>({
  max: POOL_MAX,
  dispose: (db) => disposeDb(db),
});

/** Pragmas applied uniformly whenever a connection is opened (design §4.2). */
function applyPragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL"); // multiple readers, single writer; ingest doesn't block reads during search
  db.pragma("synchronous = NORMAL"); // safe and fast under WAL
  db.pragma(`cache_size = -${CACHE_KB}`); // per-connection page cache cap (negative = KB)
  db.pragma("busy_timeout = 5000"); // wait at most 5s for the write lock, avoiding sporadic SQLITE_BUSY
}

/** Creates the 4 tables (idempotent). Only called from initIndexDb (explicit wiki creation). */
function initSchema(db: Database.Database): void {
  // ① BM25: FTS5 virtual table. Stores pre-tokenized space-separated token strings; Chinese bigram logic stays in JS tokenize(),
  //    FTS5 uses unicode61 to split only on spaces/punctuation (matches the config validated in __tests__/bm25-comparison).
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
       page_id UNINDEXED,
       title_tok,
       content_tok,
       tokenize = 'unicode61 remove_diacritics 0'
     );`,
  );

  // ② Page metadata (returned in search results; excludes the body, which lives in the on-disk .md).
  db.exec(
    `CREATE TABLE IF NOT EXISTS page_meta (
       page_id   TEXT PRIMARY KEY,
       title     TEXT,
       type      TEXT,
       rel_path  TEXT,
       snippet   TEXT
     );`,
  );

  // ③ Graph directed edges (for multi-hop BFS; read into memory at query time to build a small graph — graph data is small).
  db.exec(
    `CREATE TABLE IF NOT EXISTS graph_edge (
       source_id TEXT NOT NULL,
       target_id TEXT NOT NULL,
       PRIMARY KEY (source_id, target_id)
     );`,
  );

  // ④ Source management table (003: source files as first-class entities). DDL is created this round to keep the schema stable;
  //    read/write methods (readSources/writeSource/markIngested/deleteSource) are completed in phase 003.
  db.exec(
    `CREATE TABLE IF NOT EXISTS source (
       filename          TEXT PRIMARY KEY,
       sha256            TEXT NOT NULL,
       size              INTEGER NOT NULL,
       status            TEXT NOT NULL,
       created_at        TEXT NOT NULL,
       updated_at        TEXT NOT NULL,
       last_modified_by  TEXT,
       ingested_at       TEXT,
       ingest_error      TEXT
     );`,
  );
}

function dbPath(wikiDir: string): string {
  return join(wikiDir, "index.db");
}

/**
 * ★ Explicit DB creation: called once from the wiki creation API to create the 4 tables. Idempotent (IF NOT EXISTS).
 * Afterwards getReadDb / withWriteDb only open the existing DB and never create tables.
 */
export function initIndexDb(wikiDir: string): void {
  const db = new Database(dbPath(wikiDir));
  applyPragmas(db);
  try {
    initSchema(db);
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

/**
 * Read connection (search/graph): pooled and reused. The DB must already have been created by initIndexDb.
 * DB missing → throws (treated as "wiki not created properly / data corrupted"; no silent lazy creation).
 */
export function getReadDb(wikiId: string, wikiDir: string): Database.Database {
  let db = readPool.get(wikiId);
  if (!db || !db.open) {
    const path = dbPath(wikiDir);
    if (!existsSync(path)) {
      throw new Error(`index.db missing (wiki not created?): ${wikiId}`);
    }
    db = new Database(path, { readonly: false });
    applyPragmas(db);
    readPool.set(wikiId, db);
  }
  return db;
}

/**
 * Write connection (ingest/sync/rawWrite): created separately; after the transaction completes, checkpoint + close; not pooled.
 * The rebuild inside `fn` (FTS5 + graph_edge + page_meta + source) completes atomically in a single transaction.
 */
export function withWriteDb<T>(wikiDir: string, fn: (db: Database.Database) => T): T {
  const path = dbPath(wikiDir);
  if (!existsSync(path)) {
    throw new Error(`index.db missing (wiki not created?): ${wikiDir}`);
  }
  const db = new Database(path);
  applyPragmas(db);
  try {
    const out = db.transaction(fn)(db);
    db.pragma("wal_checkpoint(TRUNCATE)");
    return out;
  } finally {
    db.close();
  }
}

/** Wiki deletion: close the read connection first (dispose does checkpoint+close internally); the caller then rmSyncs the directory. */
export function evictWikiDb(wikiId: string): void {
  readPool.delete(wikiId);
}

/** Number of connections currently in the read pool (for tests/observability). */
export function readPoolSize(): number {
  return readPool.size;
}

// ═══════════════════════════════════════════════════════════════════
// source table read/write (design 003: source files as first-class entities + incremental extraction)
// ═══════════════════════════════════════════════════════════════════

/** Lifecycle status of a single source file (file granularity; unrelated to the wiki-level status). */
export type SourceStatus = "uploaded" | "ingested" | "failed";

/** A row of the source table (returned by rawLs, used for incremental detection). */
export interface SourceRow {
  filename: string;
  sha256: string;
  size: number;
  status: SourceStatus;
  created_at: string;
  updated_at: string;
  last_modified_by: string | null;
  ingested_at: string | null;
  ingest_error: string | null;
}

/** Computes the content SHA-256 (incremental detection and source registration share the same sha). */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Computes the SHA-256 over the **raw bytes**, used to register binary source files (docx/pdf/...) and to decide
 * whether they changed.
 *
 * Relation to `sha256()`: for plain text `sha256Bytes(Buffer.from(s,'utf-8')) === sha256(s)`, so the two are
 * equivalent and the sha of existing md/txt sources does not change, which avoids a full re-run.
 * They are two functions so that "by bytes" and "by utf-8 string" stay explicit and nobody breaks existing behaviour.
 */
export function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Registers a source on rawWrite (design §3.4: query then update, not a blind UPSERT). Must be called inside a withWriteDb transaction.
 * - New file → INSERT, status=uploaded, last_modified_by=creator;
 * - sha changed → UPDATE, **keep created_at**, reset to uploaded, record the last modifier, clear ingest_error;
 * - sha unchanged → idempotent, nothing changes (re-upload of identical content, option a).
 */
export function upsertSource(
  db: Database.Database,
  entry: { filename: string; sha256: string; size: number; userId?: string | null },
): "created" | "updated" | "unchanged" {
  const now = new Date().toISOString();
  const old = db.prepare("SELECT sha256 FROM source WHERE filename = ?").get(entry.filename) as
    | { sha256: string }
    | undefined;
  if (!old) {
    db.prepare(
      `INSERT INTO source(filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error)
       VALUES (?, ?, ?, 'uploaded', ?, ?, ?, NULL, NULL)`,
    ).run(entry.filename, entry.sha256, entry.size, now, now, entry.userId ?? null);
    return "created";
  }
  if (old.sha256 !== entry.sha256) {
    db.prepare(
      `UPDATE source SET sha256 = ?, size = ?, status = 'uploaded', updated_at = ?, last_modified_by = ?, ingest_error = NULL
       WHERE filename = ?`,
    ).run(entry.sha256, entry.size, now, entry.userId ?? null, entry.filename);
    return "updated";
  }
  return "unchanged";
}

/** Reads all source rows (rawLs), sorted by filename. */
export function listSources(db: Database.Database): SourceRow[] {
  return db
    .prepare(
      `SELECT filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error
       FROM source ORDER BY filename`,
    )
    .all() as SourceRow[];
}

/** Reads the filename → {sha256, status} mapping (for incremental detection). */
export function readSourceStates(
  db: Database.Database,
): Map<string, { sha256: string; status: SourceStatus }> {
  const rows = db.prepare("SELECT filename, sha256, status FROM source").all() as Array<{
    filename: string;
    sha256: string;
    status: SourceStatus;
  }>;
  const m = new Map<string, { sha256: string; status: SourceStatus }>();
  for (const r of rows) m.set(r.filename, { sha256: r.sha256, status: r.status });
  return m;
}

/** Deletes source rows (rawRm / file gone at ingest time). Call inside a transaction. */
export function deleteSources(db: Database.Database, filenames: string[]): void {
  if (filenames.length === 0) return;
  const stmt = db.prepare("DELETE FROM source WHERE filename = ?");
  for (const fn of filenames) stmt.run(fn);
}

/**
 * Records a single source's extraction result after ingest (design §3.6 step 6, called within the same transaction as the index rebuild).
 * - Existing row: only update status/ingested_at/ingest_error; **do not touch** created_at/updated_at/sha256/size
 *   (sha is maintained by rawWrite and content is unchanged; updated_at means "content changed", and extraction isn't a content change);
 * - No row (source file written to disk directly without rawWrite): INSERT with current on-disk values (created_at=updated_at=now).
 * ok=true → ingested + ingested_at; ok=false → failed + ingest_error.
 */
export function recordSourceIngestResult(
  db: Database.Database,
  entry: { filename: string; sha256: string; size: number; ok: boolean; error?: string | null },
): void {
  const now = new Date().toISOString();
  const status: SourceStatus = entry.ok ? "ingested" : "failed";
  const ingestedAt = entry.ok ? now : null;
  const ingestError = entry.ok ? null : (entry.error ?? "unknown").slice(0, 500);
  const exists = db.prepare("SELECT 1 FROM source WHERE filename = ?").get(entry.filename);
  if (exists) {
    db.prepare(
      "UPDATE source SET status = ?, ingested_at = ?, ingest_error = ? WHERE filename = ?",
    ).run(status, ingestedAt, ingestError, entry.filename);
  } else {
    db.prepare(
      `INSERT INTO source(filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(entry.filename, entry.sha256, entry.size, status, now, now, ingestedAt, ingestError);
  }
}

/**
 * Incremental classification (design §3.6 step 3; pure function, easy to unit test):
 * compares "on-disk source files" with "last state in the source table" to decide what happens to each file.
 * - toIngest: new || not successfully extracted (status≠ingested, incl. uploaded/failed) || sha changed → needs extraction;
 * - skipped : status=ingested and sha unchanged → skip the LLM (saves tokens);
 * - deleted : in the table but gone from disk → pending cascade deletion + delete the source row.
 */
export function classifySources(
  disk: Array<{ filename: string; sha256: string }>,
  oldStates: Map<string, { sha256: string; status: SourceStatus }>,
): { toIngest: string[]; skipped: string[]; deleted: string[] } {
  const diskNames = new Set(disk.map((d) => d.filename));
  const deleted = [...oldStates.keys()].filter((fn) => !diskNames.has(fn));
  const toIngest: string[] = [];
  const skipped: string[] = [];
  for (const d of disk) {
    const prev = oldStates.get(d.filename);
    if (!prev || prev.status !== "ingested" || prev.sha256 !== d.sha256) toIngest.push(d.filename);
    else skipped.push(d.filename);
  }
  return { toIngest, skipped, deleted };
}
