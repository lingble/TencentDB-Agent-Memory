/**
 * iWiki provider — one of the external wiki sources, using the MCP protocol.
 *
 * Auth: personal token (Bearer), injected by the caller; the token application page URL comes from deployment config
 * (see sitePaths.tokenDoc, full-URL form); **no concrete domains are written in code**.
 *
 * Supports two crawl strategies (see CrawlMode), default tree (see defaultCrawlMode below):
 *   - tree: expand level by level via the hierarchy API (complete structure, but slow recursion for large spaces)
 *   - links: discover documents by parsing hyperlinks in bodies (no hierarchy API needed, more generic and cheaper,
 *     but only finds linked pages)
 */

import { bearerAuthMethod } from "../../../code-source/auth-methods/bearer.js";
import type {
  CrawlOptions,
  RemotePageContent,
  RemotePageRef,
  ResolvedRoot,
  SourceContext,
  WikiSourceProvider,
} from "../../types.js";
import { DEFAULT_LINKS_MAX_DEPTH } from "../../types.js";
import { getDocument, getMetadata, getSpaceRoot } from "./mcp-client.js";
import { crawlTree } from "./crawlers/tree.js";
import { crawlLinks } from "./crawlers/links.js";

/** Single-document URL looks like <site>/p/<id> or /pages/<id> */
const DOC_URL_RE = /(?:\/(?:p|pages?)\/)([^/?#]+)/i;
/** Space URL looks like <site>/spaces/<spaceKey> */
const SPACE_URL_RE = /\/spaces?\/([^/?#]+)/i;

export const iwikiProvider: WikiSourceProvider = {
  id: "iwiki",
  authMethod: bearerAuthMethod,
  sitePaths: {
    // The token is issued by **another system** (Taihu PAT, different domain from iwiki), and the token page is shared by multiple sources
    // (TAPD's Taihu token method uses it too) — so it points to the **globally shared** TAI_PAT_URL:
    // that env var holds a full URL, used as-is by the code with no path joining and no built-in domain.
    tokenDoc: { tokenUrlEnv: "TAI_PAT_URL" },
  },

  /**
   * Defaults to tree: matches the platform's directory structure with full coverage, meeting the default expectation of "import a whole space/directory".
   *
   * Cost: the hierarchy API is level-by-level, so recursion over large spaces is slow (observed ~3–4 minutes for 5748 nodes).
   * To just "grab a set of related docs from an entry page", callers can pass `{ mode: "links", maxDepth: 1 }` explicitly
   * to use hyperlinks (faster, no hierarchy API needed, but only covers linked pages).
   */
  defaultCrawlMode: "tree",

  async resolveRoot(ctx: SourceContext, inputUrl: string): Promise<ResolvedRoot> {
    const docMatch = DOC_URL_RE.exec(inputUrl);
    const spaceMatch = SPACE_URL_RE.exec(inputUrl);

    // /p/<docid>: may be a regular document or a **directory page** (in iWiki, directories also have /p/ links).
    // Observed: metadata.content_type === "FOLDER" means a directory.
    // Early versions always treated it as a single document → directory pages returned only themselves and lost all children, showing up as "child documents not displayed".
    if (docMatch?.[1]) {
      const docId = docMatch[1];
      // Fetch metadata first to get the title (getDocument body may be large)
      let title = docId;
      let isFolder = false;
      try {
        const meta = await getMetadata(ctx, docId);
        if (meta.title) title = meta.title;
        isFolder = meta.contentType === "FOLDER";
      } catch {
        /* Metadata failure is non-blocking; fall back to treating it as a regular document */
      }

      if (!isFolder) {
        return { rootType: "doc", rootId: docId, displayName: title, estimatedCount: 1 };
      }

      // Directory root: the root itself is the top-level node, expanded level by level below it
      return {
        rootType: "dir",
        rootId: docId,
        displayName: title,
        estimatedCount: -1, // actual count is known only after expansion
        rootDocId: docId,
      };
    }

    // Space: /spaces/<spaceKey>
    if (spaceMatch?.[1]) {
      const spaceKey = spaceMatch[1];
      const roots = await getSpaceRoot(ctx, spaceKey);
      return {
        rootType: "dir",
        rootId: spaceKey,
        displayName: spaceKey,
        estimatedCount: roots.length,
      };
    }

    throw new Error(
      // Don't hard-code the site domain (internal address) in the hint: only describe the path shape
      `Cannot parse an iWiki space or document from the URL (expected a path like /spaces/<spaceKey> or /p/<docid>)`,
    );
  },

  async listPages(
    ctx: SourceContext,
    root: ResolvedRoot,
    opts?: CrawlOptions,
  ): Promise<RemotePageRef[]> {
    const mode = opts?.mode ?? iwikiProvider.defaultCrawlMode ?? "tree";

    // Single-document root: under either strategy it's just itself (links mode continues expanding its links below)
    if (root.rootType === "doc" && mode === "tree") {
      return [
        {
          externalId: root.rootId,
          title: root.displayName,
          path: root.displayName,
          parentId: null,
          isDir: false,
        },
      ];
    }

    if (mode === "links") {
      // Entry pages: single-document root = itself; directory root (incl. space root) = entry page under that root
      // A space root has no single entry page, so fall back to using the space's root-level pages as entries
      const entries =
        root.rootType === "doc"
          ? [root.rootId]
          : root.rootDocId
            ? [root.rootDocId]
            : (await getSpaceRoot(ctx, root.rootId)).map((n) => String(n.docid));

      const maxDepth = Math.max(1, opts?.maxDepth ?? DEFAULT_LINKS_MAX_DEPTH);
      return crawlLinks(ctx, entries, maxDepth);
    }

    // tree strategy: the directory root is itself a document (/p/<docid> and a FOLDER) → use it as the top-level node
    if (root.rootDocId) {
      const self = {
        docid: Number(root.rootDocId),
        title: root.displayName,
        has_children: true,
      };
      return crawlTree(ctx, [self]);
    }

    // Space: get the root level first, then expand level by level
    const roots = await getSpaceRoot(ctx, root.rootId);
    return crawlTree(ctx, roots);
  },

  async fetchPage(ctx: SourceContext, pageId: string): Promise<RemotePageContent> {
    const doc = await getDocument(ctx, pageId);
    // Note: getDocument returns only the body, no title (confirmed in practice).
    // We **must not** fall back to pageId for the title here — otherwise the upper layer would treat it as the real title
    // and the on-disk filename degrades to <docid>.md. Leave it empty for the upper layer to fill from the listing-phase title.
    return {
      externalId: pageId,
      title: doc.title,
      path: doc.title,
      isDir: false,
      markdown: doc.markdown,
      fidelity: doc.markdown ? "lossless" : "lossy",
    };
  },
};
