/**
 * asset-scope-store.ts - unified overlay for asset "configurable scope" (local localStorage).
 *
 * Extracted from the former demoStore.ts (separate responsibility: unrelated to how team/agent/task
 * entities are persisted; it is a generic product-semantics layer on top of the 5 asset kinds).
 *
 * Requirement: each owner can manage "their own assets", choosing whether the asset is
 *   - team    configurable within the team: team members can all configure / edit this asset
 *   - private private to self: only the owner (+ team admin / global admin) can configure / edit
 *
 * This layer covers all 5 asset kinds (agent / skill / code / wiki / memory). Different assets
 * have different underlying data sources (backendStore / mock / backend knowledgeApi), but "configurable scope"
 * is a unified product semantic, so it gets its own lightweight overlay: one record stored per `${kind}:${asset_id}`,
 * decoupled from the asset entity. Once the backend ships, swap in an asset_acl table with no UI change.
 */

import type { Team } from './backendStore';
import { isTeamAdmin, isTeamMember } from './backendStore';
import { emitChange, safeParse, useChangeNotifier } from './storage-utils';

const ASSET_SCOPES_KEY = 'tdai-memory.assetScopes.v1';

export type AssetKind = 'agent' | 'skill' | 'code' | 'wiki' | 'memory';
export type AssetConfigScope = 'team' | 'private';

export interface AssetScopeRecord {
  scope: AssetConfigScope;
  /** The asset's owner - who may change its configurable scope. For unowned assets the first setter becomes the owner. */
  owner_user_id: string;
  updated_at_ms: number;
}

type AssetScopeMap = Record<string, AssetScopeRecord>;

function scopeKey(kind: AssetKind, asset_id: string): string {
  return `${kind}:${asset_id}`;
}

function readAssetScopeMap(): AssetScopeMap {
  if (typeof window === 'undefined') return {};
  return safeParse<AssetScopeMap>(localStorage.getItem(ASSET_SCOPES_KEY), {});
}

function writeAssetScopeMap(map: AssetScopeMap): void {
  try {
    localStorage.setItem(ASSET_SCOPES_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
  emitChange();
}

/**
 * Read an asset's configurable scope.
 * Assets never explicitly set default to `team` (configurable within the team) - consistent with current behavior (shared team pool);
 * owner falls back to the asset entity's own owner (fallbackOwner).
 */
export function getAssetConfigScope(
  kind: AssetKind,
  asset_id: string,
  fallbackOwner = ''
): { scope: AssetConfigScope; owner_user_id: string } {
  const rec = readAssetScopeMap()[scopeKey(kind, asset_id)];
  if (rec) return { scope: rec.scope, owner_user_id: rec.owner_user_id || fallbackOwner };
  return { scope: 'team', owner_user_id: fallbackOwner };
}

/**
 * Set an asset's configurable scope.
 * Once determined, the owner is fixed (existing record → the asset's own owner → the current operator).
 * Callers should gate the UI with canManageAssetScope first; no duplicate auth check here (demo phase).
 */
export function setAssetConfigScope(
  kind: AssetKind,
  asset_id: string,
  scope: AssetConfigScope,
  actor: string,
  fallbackOwner = ''
): void {
  const map = readAssetScopeMap();
  const key = scopeKey(kind, asset_id);
  const owner = map[key]?.owner_user_id || fallbackOwner || actor;
  map[key] = { scope, owner_user_id: owner, updated_at_ms: Date.now() };
  writeAssetScopeMap(map);
}

/**
 * Who can change an asset's configurable scope:
 *   - global admin / team admin → can change (needed for governance)
 *   - the owner → can change ("manage your own assets")
 *   - unowned assets (empty ownerUserId, e.g. backend Code/Wiki have no owner concept)
 *     → any team member can set it, and the first setter becomes the owner
 */
export function canManageAssetScope(
  ownerUserId: string,
  team: Team | null | undefined,
  user_id: string,
  isAdmin?: boolean
): boolean {
  if (!user_id) return false;
  // Global admins no longer automatically get asset management privileges, same as regular members:
  // only the owner or a team admin can change an asset's configurable scope.
  // The isAdmin param is kept only for compatibility with existing call signatures (can be removed in a future cleanup).
  void isAdmin;
  if (team && isTeamAdmin(team, user_id)) return true;
  if (!ownerUserId) return isTeamMember(team, user_id);
  return ownerUserId === user_id;
}

/**
 * Subscribe to changes in the asset configurable-scope overlay.
 * Components use it to re-render automatically after setAssetConfigScope (the return value is an incrementing tick, only for triggering refreshes).
 */
export function useAssetConfigScopes(): number {
  return useChangeNotifier();
}
