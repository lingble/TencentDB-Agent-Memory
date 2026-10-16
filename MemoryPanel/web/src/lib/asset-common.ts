/**
 * asset-common - shared types and pure utility functions for the asset (Wiki / Code / Skill / Memory) pages.
 *
 * These types and utilities used to be duplicated in wiki-constants.ts / code-constants.ts /
 * memory types.ts; they're consolidated here, and page files re-export them to keep
 * the original import paths unchanged.
 */

/** List view toggle: cards / table */
export type ViewMode = 'card' | 'list';

/** List status filter */
export type StatusFilter = 'all' | 'ready' | 'processing' | 'error';

/** Asset page sub-view: list / detail */
export type SubView = 'list' | 'detail';

/** Asset scope: team pool / fixed assets */
export type ScopeTab = 'team' | 'fixed';

/**
 * ISO time string → panel display format (local time zone, 'MM/DD HH:MM').
 * Empty or invalid input → returns '—'.
 * Previously implemented identically in wiki-constants.ts and code-constants.ts; consolidated here.
 */
export function formatShortTime(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
