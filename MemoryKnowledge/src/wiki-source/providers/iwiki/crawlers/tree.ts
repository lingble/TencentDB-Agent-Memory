/**
 * One crawl strategy: expand the directory tree via the platform's **hierarchy API** (parent → child).
 *
 * Applies when: the platform offers a "get a node's direct children" API (iWiki's getSpacePageTree).
 * Traits: complete structure; but the API is level-by-level, so large spaces need many recursive calls and take long.
 */

import type { RemotePageRef, SourceContext } from "../../../types.js";
import { getSpacePageTree, type IWikiTreeNode } from "../mcp-client.js";

/** Recursion depth cap, preventing infinite expansion on malformed data. */
const MAX_DEPTH = 20;

/**
 * Recursively expand the whole tree (BFS) and return a flat list.
 *
 * Directory markers are kept: nodes with has_children=true are directories (not importable on their own).
 */
export async function crawlTree(
  ctx: SourceContext,
  roots: IWikiTreeNode[],
): Promise<RemotePageRef[]> {
  const out: RemotePageRef[] = [];
  const visited = new Set<number>();

  interface Todo {
    nodes: IWikiTreeNode[];
    parentId: number | null;
    parentPath: string;
    depth: number;
  }
  const queue: Todo[] = [{ nodes: roots, parentId: null, parentPath: "", depth: 0 }];

  while (queue.length > 0) {
    const { nodes, parentId, parentPath, depth } = queue.shift()!;
    if (depth > MAX_DEPTH) continue;

    for (const node of nodes) {
      const docid = Number(node.docid);
      if (!Number.isFinite(docid) || visited.has(docid)) continue;
      visited.add(docid);

      const title = node.title || String(docid);
      const path = parentPath ? `${parentPath}/${title}` : title;
      const isDir = node.has_children === true;

      out.push({
        externalId: String(docid),
        title,
        path,
        parentId: parentId === null ? null : String(parentId),
        isDir,
      });

      if (isDir) {
        // Fetch children level by level (the API returns only direct children)
        let children: IWikiTreeNode[];
        try {
          children = await getSpacePageTree(ctx, docid);
        } catch {
          // A single subtree failure should not abort the whole import
          continue;
        }
        if (children.length > 0) {
          queue.push({ nodes: children, parentId: docid, parentPath: path, depth: depth + 1 });
        }
      }
    }
  }
  return out;
}
