/**
 * SyncTarget — discriminated union of auto-sync targets.
 *
 * wiki and codegraph share a single AutoSyncScheduler. A discriminated union is used instead of inheritance/generics:
 * adding a new target means adding a member, and the compiler forces every switch branch to handle it.
 *
 * Keys carry a kind prefix (`code-graph:<id>` / `wiki:<id>`), so they never collide —
 * even if two resource types happen to share an id, they won't dedupe each other.
 */

import type { CodeGraphRow, WikiRow } from "./types.js";

export type SyncTargetKind = "code-graph" | "wiki";

export type SyncTarget =
  | { kind: "code-graph"; key: string; serviceId: string; teamId: string; id: string; row: CodeGraphRow }
  | { kind: "wiki"; key: string; serviceId: string; teamId: string; id: string; row: WikiRow };

/** Unique key of a sync target (kind-prefixed, no collisions across types). */
export function targetKey(kind: SyncTargetKind, id: string): string {
  return `${kind}:${id}`;
}

export function toCodeGraphTarget(row: CodeGraphRow): SyncTarget {
  return {
    kind: "code-graph",
    key: targetKey("code-graph", row.code_graph_id),
    serviceId: row.service_id,
    teamId: row.team_id,
    id: row.code_graph_id,
    row,
  };
}

export function toWikiTarget(row: WikiRow): SyncTarget {
  return {
    kind: "wiki",
    key: targetKey("wiki", row.wiki_id),
    serviceId: row.service_id,
    teamId: row.team_id,
    id: row.wiki_id,
    row,
  };
}
