/**
 * slug.ts — entity name → stable filename slug
 *
 * Foundation of dedup (merge on duplicate): ingesting the same entity name twice must yield the same slug,
 * so the second ingest hits the existing `wiki/<type>/<slug>.md` and merges instead of creating a new page.
 *
 * Rules (PRD FR-4 / INTERFACE §2, sources mix Chinese and English):
 *   - English/digits: lowercase; spaces and punctuation become hyphens; strip leading/trailing/repeated hyphens.
 *   - Chinese (CJK): keep the characters themselves, only remove spaces (no pinyin conversion, nothing dropped).
 *   - Mixed: process each part by the rules above, then join (`Redis 主从` → `redis-主从`).
 */

// CJK Unified Ideographs (including Extension A); common Chinese punctuation is not included (punctuation is treated as a separator).
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function isCjkChar(ch: string): boolean {
  return CJK_RE.test(ch);
}

function isAlnumChar(ch: string): boolean {
  return /[a-zA-Z0-9]/.test(ch);
}

/**
 * Normalizes an entity name/title into a stable slug.
 *
 * Strategy: scan character by character, splitting into alternating "CJK segment" and "Latin/digit segment" tokens;
 * segments are joined with hyphens; Latin segments are lowercased; all other characters (spaces, punctuation) are segment boundaries.
 */
export function slugify(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";

  const tokens: string[] = [];
  let buf = "";
  let bufKind: "cjk" | "latin" | null = null;

  const flush = () => {
    if (buf) {
      tokens.push(bufKind === "latin" ? buf.toLowerCase() : buf);
      buf = "";
    }
    bufKind = null;
  };

  for (const ch of trimmed) {
    if (isCjkChar(ch)) {
      if (bufKind !== "cjk") flush();
      bufKind = "cjk";
      buf += ch;
    } else if (isAlnumChar(ch)) {
      if (bufKind !== "latin") flush();
      bufKind = "latin";
      buf += ch;
    } else {
      // space / punctuation / other → segment boundary
      flush();
    }
  }
  flush();

  // Join with hyphens; strip repeated/leading/trailing hyphens.
  return tokens.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Given a page type and title, returns the path relative to the wiki (without the leading `wiki/`).
 * E.g. type="entity", title="Redis Cluster" → "entities/redis-cluster.md"
 *
 * The type → directory mapping follows the existing manager's directory conventions (entities/concepts/sources/...).
 */
const TYPE_DIR: Record<string, string> = {
  source: "sources",
  entity: "entities",
  concept: "concepts",
  comparison: "comparisons",
  synthesis: "synthesis",
  thesis: "synthesis",
  methodology: "concepts",
  finding: "synthesis",
};

/**
 * Valid range of type values: type is an OKF classification label, not a path, so it can only be an identifier.
 * Any value containing `/`, `.` (including `..`) or other characters is not a valid classification and goes to the other directory.
 */
const SAFE_TYPE_RE = /^[a-z0-9_-]+$/;

/** Maps type to a directory name; unknown but valid types use themselves as a generic directory, invalid values go to other. */
export function dirForType(type: string): string {
  const key = (type ?? "").trim().toLowerCase();
  // hasOwn instead of index lookup: prevents "__proto__"/"constructor" from hitting members on the Object prototype chain.
  if (Object.hasOwn(TYPE_DIR, key)) return TYPE_DIR[key];
  if (!SAFE_TYPE_RE.test(key)) return "other";
  return key;
}

/**
 * Computes a page's wiki-relative path (with the `wiki/` prefix), used for writing to disk and dedup matching.
 * @param type Page type (source/entity/concept/...)
 * @param title Entity name/title
 */
export function pageRelPath(type: string, title: string): string {
  const slug = slugify(title);
  const dir = dirForType(type);
  return `wiki/${dir}/${slug}.md`;
}
