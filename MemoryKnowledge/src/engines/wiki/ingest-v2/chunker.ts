/**
 * chunker.ts — chunking for oversized sources.
 *
 * When a source's character count exceeds the model's context budget, the text is split into chunks
 * processed one by one, with a small overlap between chunks to preserve context continuity (INTERFACE §6).
 *
 * Split units (OQ-5 optimization): prefer splitting on markdown heading (`#`~`######`) boundaries
 * so each semantic section lands in a single chunk as much as possible; oversized sections fall back to
 * splitting on blank-line paragraphs, and paragraphs that are still too long are hard-cut. Avoids abrupt cuts mid-sentence/section.
 */

export interface ChunkOptions {
  /** Target max characters per chunk (default 12000). */
  targetChars?: number;
  /** Overlap characters between chunks (default 400). */
  overlapChars?: number;
}

const DEFAULT_TARGET = 12_000;
const DEFAULT_OVERLAP = 400;

/**
 * Splits text into an array of "split units": each unit is ideally one complete markdown section
 * (from one heading line up to the next heading line). A leading part without a heading is its own unit.
 * Units exceeding target are further split on blank-line paragraphs; paragraphs still too long are hard-cut.
 */
function splitIntoUnits(text: string, target: number): string[] {
  const lines = text.split("\n");
  // First split into sections by heading lines.
  const sections: string[] = [];
  let cur: string[] = [];
  const isHeading = (line: string) => /^#{1,6}\s+\S/.test(line);
  for (const line of lines) {
    if (isHeading(line) && cur.length > 0) {
      sections.push(cur.join("\n"));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) sections.push(cur.join("\n"));

  // Fallback split for oversized sections: first by blank-line paragraphs, then hard cut.
  const units: string[] = [];
  for (const sec of sections) {
    const s = sec.trim();
    if (!s) continue;
    if (s.length <= target) {
      units.push(s);
      continue;
    }
    for (const para of s.split(/\n\s*\n/)) {
      const p = para.trim();
      if (!p) continue;
      if (p.length <= target) {
        units.push(p);
      } else {
        for (let i = 0; i < p.length; i += target) units.push(p.slice(i, i + target));
      }
    }
  }
  return units;
}

/**
 * Aggregates text into chunks. Each chunk stays within targetChars where possible, grouped on markdown section boundaries.
 *
 * @returns Array of chunks; [] for empty input, a single-element array if under the threshold.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const target = Math.max(1000, opts.targetChars ?? DEFAULT_TARGET);
  const overlap = Math.max(0, Math.min(opts.overlapChars ?? DEFAULT_OVERLAP, Math.floor(target / 2)));

  const trimmed = (text ?? "").trim();
  if (!trimmed) return [];
  if (trimmed.length <= target) return [trimmed];

  const units = splitIntoUnits(trimmed, target);

  const chunks: string[] = [];
  let buf = "";
  for (const unit of units) {
    const candidate = buf ? `${buf}\n\n${unit}` : unit;
    if (candidate.length > target && buf) {
      chunks.push(buf);
      // Overlap: use the last `overlap` characters of the previous chunk as the start of the next
      const tail = overlap > 0 ? buf.slice(-overlap) : "";
      buf = tail ? `${tail}\n\n${unit}` : unit;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** Roughly estimates a string's token count (conservative len/3). Used to decide whether chunking is needed. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 3);
}
