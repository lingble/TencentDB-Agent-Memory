/**
 * wiki-source — abstraction over external wiki sources.
 *
 * Symmetric with code-source:
 *   - **Provider (wiki platform)** → `providers/<id>.ts`: platform constants + fetch implementation
 *   - Auth reuses the AuthMethod from `code-source/auth-methods/` (form metadata + injection conventions)
 *
 * Differences (vs. codegraph):
 *   - A wiki requires **listing the document tree + fetching content page by page**; a single URL is not enough
 *   - So a provider must implement resolveRoot / listPages / fetchPage
 *   - Contract defined in doc §2.1; implemented on the KS side, Panel only calls the API
 */

import type { AuthMethod } from "../code-source/auth-methods/types.js";

/** Source metadata for the frontend dropdown. */
export interface WikiSourceMeta {
  id: string;
  auth_method: AuthMethod["kind"];
  form_fields: ReadonlyArray<{ name: string; secret: boolean; required: boolean }>;
  token_doc_url?: string;
}

/**
 * Token application page location.
 *
 * **The address always comes from deployment config**; internal domains are never hard-coded. Two forms:
 *
 * - `{ tokenUrlEnv }` (**preferred**): the env var holds the **full URL**, used as-is without joining.
 *   For cases where the token page is on a different domain than the source, or **shares the same token page with other sources**
 *   (e.g. iWiki and TAPD both use the Taihu PAT page → both point to the same `TAI_PAT_URL`).
 * - `{ path }`: on-site relative path, joined onto `WIKI_SOURCE_<ID>_SITE_BASE_URL`.
 *
 * With the full-URL form, multiple sources can point to **the same env var**, so changing the address happens in one place and nothing is missed.
 */
export type TokenDoc =
  | { tokenUrlEnv: string }
  | { path: string };

/**
 * Crawl strategy: decides "starting from the import root, how documents are discovered".
 *
 * - `"tree"`: use the platform's **hierarchy API** (parent → child), expanding by directory structure.
 *     Pros: complete structure, consistent with the platform's directories;
 *     Cons: requires a hierarchy API on the platform, usually level-by-level (many recursive calls and slow for large spaces).
 *
 * - `"links"`: discover documents by parsing **hyperlinks in page bodies** (crawler-like).
 *     Pros: no hierarchy API needed; works on any platform where bodies can be fetched;
 *     Cons: only finds linked pages, and requires fetching bodies (extra request overhead).
 */
export type CrawlMode = "tree" | "links";

/** Default crawl depth for the links strategy (one level, following only the entry page's direct links). */
export const DEFAULT_LINKS_MAX_DEPTH = 1;

/** Crawl options. */
export interface CrawlOptions {
  mode?: CrawlMode;
  /** Max crawl depth; 1 = only documents directly linked from the entry page. Only meaningful for the links strategy. */
  maxDepth?: number;
}

/** Import root: directory or single document. */
export interface ResolvedRoot {
  rootType: "dir" | "doc";
  rootId: string;
  displayName: string;
  estimatedCount?: number;
  /**
   * When the directory root is itself a document id (on some platforms directory pages share
   * the same URL shape as normal documents, e.g. `/p/<id>`), record that id
   * so listPages can expand level by level from it.
   * Space roots (rootId is a space key) do not carry this field.
   */
  rootDocId?: string;
}

/** Remote node reference (flat, including directory nodes). */
export interface RemotePageRef {
  externalId: string;
  title: string;
  path: string;
  parentId?: string | null;
  /** true = directory, display only, not downloadable. */
  isDir?: boolean;
  version?: string;
  updatedAt?: string;
}

/**
 * Content of a single fetched page.
 *
 * `title` may be undefined: some providers' content APIs return only the body, not the title
 * (such platforms have been confirmed in practice). The upper layer then fills it in with the title from the listing phase (listPages);
 * providers **must not fall back to the id**, otherwise the on-disk filename degrades to `<id>.md`.
 */
export interface RemotePageContent extends Omit<RemotePageRef, "title" | "path"> {
  title?: string;
  path?: string;
  markdown: string;
  fidelity: "lossless" | "lossy";
  warnings?: string[];
}

/**
 * Fetch execution context.
 *
 * Credentials are **injected here**; providers never read the DB themselves,
 * which keeps providers purely functional and easy to test and reuse (including scheduled sync).
 */
export interface SourceContext {
  /** Plaintext credential (PAT, etc.). */
  secret: string;
  /** Username for basic auth (optional). */
  username?: string;
  /** MCP / API endpoint. */
  endpoint: string;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

/**
 * Wiki source provider contract (doc §2.1).
 *
 * One platform file = one implementation:
 *   - `id` / `authMethod` / `sitePaths`: platform constants
 *   - `resolveRoot` / `listPages` / `fetchPage`: platform fetch capabilities
 *   - `fetchPages`: optional batch; falls back to fetchPage one by one if not implemented
 */
export interface WikiSourceProvider {
  readonly id: string;
  readonly authMethod: AuthMethod;
  readonly sitePaths: {
    /** Token application page location (on-site path / cross-site path, see TokenDoc). */
    tokenDoc?: TokenDoc;
  };

  /**
   * **Config name suffix** for the service endpoint, forming `WIKI_SOURCE_<UPPER_ID>_<suffix>`.
   *
   * Defaults to `"MCP_URL"` (MCP-protocol style);
   * REST-style platforms can declare `"API_BASE_URL"` etc. so they are not forced to be called MCP.
   *
   * The address always comes from deployment config, with **no built-in default** (internal infrastructure must be configured explicitly).
   */
  readonly endpointEnvSuffix?: string;

  /** Resolve an address into an import root, automatically determining directory vs. document. */
  resolveRoot(ctx: SourceContext, inputUrl: string): Promise<ResolvedRoot>;

  /**
   * List nodes, returned flat with directory nodes retained.
   *
   * `opts` is optional: callers can specify a crawl strategy (see CrawlOptions).
   * Omitted → use the provider's default strategy (`defaultCrawlMode`, or `"tree"` if not declared).
   */
  listPages(
    ctx: SourceContext,
    root: ResolvedRoot,
    opts?: CrawlOptions,
  ): Promise<RemotePageRef[]>;

  /**
   * This provider's default crawl strategy. **Optional**; `"tree"` if not declared.
   *
   * Trade-offs:
   * - `tree` matches the platform's directory structure with full coverage, the natural default for "import a whole space/directory";
   *   but it requires a hierarchy API, usually level-by-level (recursion over large spaces is slow).
   * - `links` only needs to read bodies with fewer requests, suited to "grab a set of related docs from an entry page";
   *   but it only discovers linked pages.
   *
   * Callers can always override with `CrawlOptions.mode`.
   */
  readonly defaultCrawlMode?: CrawlMode;

  fetchPage(ctx: SourceContext, pageId: string): Promise<RemotePageContent>;

  /** Optional batch; falls back to fetchPage one by one if unsupported. */
  fetchPages?(ctx: SourceContext, ids: string[]): Promise<RemotePageContent[]>;
}
