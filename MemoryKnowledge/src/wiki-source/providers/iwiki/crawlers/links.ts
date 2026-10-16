/**
 * One crawl strategy: discover documents by parsing **hyperlinks in page bodies** (crawler-like).
 *
 * Applies when: no platform hierarchy API is needed — works on any platform where bodies can be fetched.
 * Traits:
 *   - Only discovers pages "linked from the entry page" (no guarantee of covering the whole space)
 *   - Requires fetching bodies to parse links (extra request overhead)
 *   - Follows only one level by default (the entry page's direct links) to avoid request explosion
 */

import type { RemotePageRef, SourceContext } from "../../../types.js";
import { getDocument, getMetadata } from "../mcp-client.js";

/**
 * Extract document ids from the body (deduplicated, order preserved).
 *
 * Regexes are **created inside the function**: a regex with the `g` flag holds lastIndex state,
 * and sharing it at module level contaminates repeated calls / alternating regex matches (this once yielded dirty ids like "2)").
 */
export function extractDocIds(markdown: string): string[] {
  // markdown link syntax: `[title](https://.../p/123)` — the id excludes `/?#)` and whitespace
  const mdLinkRe = /\((?:https?:\/\/[^)\s]*?)?\/(?:p|pages?)\/([^/?#)\s]+)\)/gi;
  // Bare URL: `.../p/123` anywhere
  const bareUrlRe = /\/(?:p|pages?)\/([^/?#)\s]+)/gi;

  const out: string[] = [];
  const seen = new Set<string>();

  const collect = (re: RegExp) => {
    for (let m = re.exec(markdown); m; m = re.exec(markdown)) {
      const id = m[1];
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  };

  collect(mdLinkRe);
  collect(bareUrlRe);
  return out;
}

/**
 * Starting from entry pages, discover documents level by level via body hyperlinks.
 *
 * @param rootIds   list of entry page ids
 * @param maxDepth  max levels; 1 = only documents directly linked from the entry pages (default)
 */
export async function crawlLinks(
  ctx: SourceContext,
  rootIds: string[],
  maxDepth: number,
): Promise<RemotePageRef[]> {
  const out: RemotePageRef[] = [];
  const visited = new Set<string>(rootIds);

  // Start with the entry pages themselves
  let frontier: Array<{ id: string; parentId: string | null; depth: number }> = rootIds.map(
    (id) => ({ id, parentId: null, depth: 0 }),
  );

  while (frontier.length > 0) {
    const next: typeof frontier = [];

    for (const item of frontier) {
      // Prefer the title from metadata (getDocument returns only the body, no title)
      let title = item.id;
      let markdown = "";
      try {
        const [meta, doc] = await Promise.all([
          getMetadata(ctx, item.id).catch(() => undefined),
          getDocument(ctx, item.id),
        ]);
        if (meta?.title) title = meta.title;
        markdown = doc.markdown ?? "";
      } catch {
        // Failing to fetch a single page should not abort the whole crawl
        continue;
      }

      out.push({
        externalId: item.id,
        title,
        path: title,
        parentId: item.parentId,
        isDir: false,
      });

      // Stop expanding once max depth is reached
      if (item.depth >= maxDepth) continue;

      for (const childId of extractDocIds(markdown)) {
        if (visited.has(childId)) continue;
        visited.add(childId);
        next.push({ id: childId, parentId: item.id, depth: item.depth + 1 });
      }
    }

    frontier = next;
  }

  return out;
}
