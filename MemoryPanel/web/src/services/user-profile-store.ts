/**
 * user-profile-store.ts - user display name cache.
 *
 * Fetches display_name from the backend usersApi.get(), with an in-memory cache to avoid duplicate requests.
 */

import { useState, useEffect, useCallback } from 'react';

// In-memory cache: user_id -> display_name
const _displayNameCache = new Map<string, string>();
const _fetching = new Set<string>();
const _subscribers = new Set<() => void>();

function notify() { _subscribers.forEach((fn) => fn()); }

/** Batch-write display names into the cache (e.g. when team-member/list already includes username). */
export function seedDisplayNameCache(entries: Array<{ user_id: string; username?: string }>): void {
  let changed = false;
  for (const { user_id, username } of entries) {
    if (!user_id || !username?.trim()) continue;
    const name = username.trim();
    if (_displayNameCache.get(user_id) === name) continue;
    _displayNameCache.set(user_id, name);
    changed = true;
  }
  if (changed) notify();
}

/**
 * Subscribe to the display name of a given user. Uses the in-memory cache first; fetches asynchronously from the backend when not cached.
 */
export function useUserDisplayName(user_id: string | null | undefined): string {
  const [, force] = useState(0);
  useEffect(() => {
    const sub = () => force((n) => n + 1);
    _subscribers.add(sub);
    return () => { _subscribers.delete(sub); };
  }, []);

  if (!user_id) return '';
  const cached = _displayNameCache.get(user_id);
  if (cached) return cached;

  // Not cached -> fetch asynchronously
  if (!_fetching.has(user_id)) {
    _fetching.add(user_id);
    import('@/lib/teamApi').then(({ usersApi }) => {
      usersApi.get(user_id)
        .then((u) => {
          const name = u.display_name || u.username || user_id;
          _displayNameCache.set(user_id, name);
          notify();
        })
        .catch(() => { /* fail silently */ })
        .finally(() => { _fetching.delete(user_id); });
    });
  }

  return user_id; // show user_id until the fetch completes
}

/**
 * Resolver for batch scenarios (e.g. a list tooltip joining multiple usernames).
 * Returns a stable function reference; fetching of uncached ids is triggered during render, and once the cache is ready the subscription triggers a re-render.
 * Shares the same cache/subscription as useUserDisplayName, so both resolve identically.
 */
export function useDisplayNameResolver(): (userId: string) => string {
  const [, force] = useState(0);
  useEffect(() => {
    const sub = () => force((n) => n + 1);
    _subscribers.add(sub);
    return () => { _subscribers.delete(sub); };
  }, []);

  return useCallback((userId: string) => {
    if (!userId) return '';
    const cached = _displayNameCache.get(userId);
    if (cached) return cached;
    if (!_fetching.has(userId)) {
      _fetching.add(userId);
      import('@/lib/teamApi').then(({ usersApi }) => {
        usersApi.get(userId)
          .then((u) => {
            const name = u.display_name || u.username || userId;
            _displayNameCache.set(userId, name);
            notify();
          })
          .catch(() => { /* fail silently */ })
          .finally(() => { _fetching.delete(userId); });
      });
    }
    return userId;
  }, []);
}
