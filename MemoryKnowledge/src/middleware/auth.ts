/**
 * Service-to-service auth middleware.
 *
 * Model (aligned with the MemoryCore gateway's Layer 1 Bearer semantics):
 *   - KNOWLEDGE_SERVICE_KEY empty     → auth disabled, everything allowed (backward compatible for local/dev deployments);
 *   - KNOWLEDGE_SERVICE_KEY non-empty → all endpoints under /v3 except the read-only allowlist require
 *     `Authorization: Bearer <serviceKey>`; missing/wrong always yields 401 (fail-closed).
 *
 * The read-only allowlist (Agent-facing surface) stays open:
 *   tools/list, tools/call (Agent self-discovery and read-only tool execution), wiki/code-graph queries,
 *   source-credential/status (metadata without secrets), source-provider list,
 *   auto-sync/status.
 * Note: although llm-binding status/list do not echo the api_key in plaintext, they expose binding
 * existence and base_url (reconnaissance value), so they are not allowed — the only caller, Panel, always sends the key.
 * Write/admin surfaces (wiki ingest, raw/page write, llm-binding/set, source-credential/put,
 * auto-sync/trigger, etc.) always require the key — new endpoints are protected by default.
 *
 * /health, /docs, /openapi.json are mounted outside the api sub-app (server.ts) and are unaffected by this middleware.
 */

import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { wrapError } from "../api-helpers.js";
import { createLogger } from "../logger.js";

const log = createLogger("auth");

export interface KnowledgeAuthConfig {
  serviceKey: string;
}

/**
 * Timing-safe string comparison. When lengths differ, still compares against itself once
 * to avoid leaking the key length through response timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * Read-only allowlist (paths relative to apiPrefix, e.g. "/tools/list").
 * These endpoints require no auth even when the key is enabled.
 */
const READONLY_POST_PATHS: ReadonlySet<string> = new Set([
  // Agent self-discovery + read-only tool execution (search_wiki / query_code_graph, etc.)
  "/tools/list",
  "/tools/call",
  // wiki queries
  "/wiki/get",
  "/wiki/list",
  "/wiki/raw/ls",
  "/wiki/raw/read",
  "/wiki/page/ls",
  "/wiki/page/read",
  "/wiki/graph",
  "/wiki/search",
  // code-graph queries
  "/code-graph/list",
  "/code-graph/get",
  // Note: all of /internal/llm-binding/* require the key (including status/list) —
  // although they do not echo the api_key in plaintext, they expose binding existence and base_url;
  // the only caller is Panel (sends KNOWLEDGE_AUTH_TOKEN), see ensure-knowledge-llm-binding.
]);

const READONLY_GET_PATHS: ReadonlySet<string> = new Set([
  "/source-credential/status", // metadata, no secret
  "/auto-sync/status",
]);

/** Everything under source-provider is a read-only GET list endpoint; allowed by prefix. */
const READONLY_GET_PREFIXES: readonly string[] = ["/source-provider"];

export function isReadonlyPath(method: string, path: string): boolean {
  if (method === "POST") return READONLY_POST_PATHS.has(path);
  if (method === "GET") {
    return READONLY_GET_PATHS.has(path) || READONLY_GET_PREFIXES.some((p) => path.startsWith(p));
  }
  return false;
}

/** Pure function: check whether the Authorization header is `Bearer <serviceKey>`. */
export function verifyBearer(authHeader: string | undefined, serviceKey: string): boolean {
  if (!authHeader) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
  if (!m) return false;
  return safeEqual(m[1], serviceKey);
}

/**
 * Hono middleware factory. Mounted on the /v3 sub-app (server.ts);
 * c.req.path is the full path, so apiPrefix is stripped before matching the allowlist.
 */
export function createServiceAuthMiddleware(
  cfg: KnowledgeAuthConfig,
  apiPrefix: string,
): MiddlewareHandler {
  return async (c, next) => {
    // No key configured = auth disabled (backward compatible; a posture warning is logged separately at startup)
    if (!cfg.serviceKey) return next();

    const full = c.req.path;
    const path = full.startsWith(apiPrefix) ? full.slice(apiPrefix.length) : full;
    if (isReadonlyPath(c.req.method, path)) return next();

    if (verifyBearer(c.req.header("authorization"), cfg.serviceKey)) return next();

    log.warn(`rejected unauthenticated request: ${c.req.method} ${full}`);
    return c.json(wrapError(401, "unauthorized: valid service key required"), 401);
  };
}
