/**
 * wiki-constants - constants, types and pure utility functions for the Wiki asset page.
 * Split out of WikiSourcesPanel.tsx, reused by the main panel / detail view / hooks.
 *
 * Generic asset types and formatShortTime have been consolidated into @/lib/asset-common; re-exported here
 * to keep the original import paths unchanged.
 */
import type { WikiDetail, WikiFileFormat } from '@/lib/api/knowledge-api';
export type { WikiFileFormat } from '@/lib/api/knowledge-api';
export type { SubView, ViewMode, StatusFilter } from '@/lib/asset-common';
export { formatShortTime } from '@/lib/asset-common';

/**
 * Fallback list: **used only when the backend endpoint is unavailable**.
 *
 * The normal path is fetching `formats` at start-up (see `wiki-format-store.ts`).
 * A snapshot is kept here so that uploads are not completely blocked when that call fails,
 * but it may drift from the backend registry — once the endpoint recovers, the endpoint wins.
 */
export const FALLBACK_FORMATS: WikiFileFormat[] = [
  { ext: 'md', sizeTier: 'text', preview: 'markdown', converter: 'passthrough' },
  { ext: 'markdown', sizeTier: 'text', preview: 'markdown', converter: 'passthrough' },
  { ext: 'txt', sizeTier: 'text', preview: 'native', converter: 'passthrough' },
  { ext: 'html', sizeTier: 'text', preview: 'native', converter: 'passthrough' },
  { ext: 'htm', sizeTier: 'text', preview: 'native', converter: 'passthrough' },
  { ext: 'csv', sizeTier: 'text', preview: 'converted', converter: 'officeparser' },
  { ext: 'docx', sizeTier: 'binary', preview: 'client', converter: 'officeparser' },
  { ext: 'xlsx', sizeTier: 'binary', preview: 'client', converter: 'officeparser' },
  { ext: 'pdf', sizeTier: 'binary', preview: 'native', converter: 'officeparser' },
  { ext: 'pptx', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
  { ext: 'odt', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
  { ext: 'ods', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
  { ext: 'odp', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
  { ext: 'odg', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
  { ext: 'rtf', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
  { ext: 'epub', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
];

/**
 * Raw-document preview failure code → i18n key.
 *
 * The codes come from the KS conversion layer (document-converter/errors.ts); this only maps them for display.
 * Unlisted codes fall back to the generic failure text.
 */
export const RAW_PREVIEW_ERROR_KEYS: Record<string, string> = {
  UNSUPPORTED_FILE_TYPE: 'wiki.rawPreview.unsupported',
  FILE_TYPE_MISMATCH: 'wiki.rawPreview.mismatch',
  ENCRYPTED_FILE: 'wiki.rawPreview.encrypted',
  SCANNED_PDF_UNSUPPORTED: 'wiki.rawPreview.scannedPdf',
  CONVERTER_NOT_READY: 'wiki.rawPreview.notReady',
  CONVERT_TIMEOUT: 'wiki.rawPreview.timeout',
  CONVERT_FAILED: 'wiki.rawPreview.failed',
};

// Wiki status badges: draft=shell created but unprocessed (waiting for the user to click ingest); pending=queued; processing=in progress; ready=ready; failed=failed; missing=KS data lost.
// Uses Tea Tag semantic themes (soft variant), which follow the theme, instead of hard-coded palette colors.
export const WIKI_STATUS_THEME: Record<WikiDetail['status'], 'warning' | 'success' | 'error' | 'default'> = {
  draft: 'warning',
  pending: 'warning',
  processing: 'warning',
  ready: 'success',
  failed: 'error',
  missing: 'error',
};
export const WIKI_STATUS_KEY: Record<WikiDetail['status'], string> = {
  draft: 'wiki.status.draft',
  pending: 'wiki.status.pending',
  processing: 'wiki.status.processing',
  ready: 'wiki.status.ready',
  failed: 'wiki.status.failed',
  missing: 'wiki.status.missing',
};

export type WikiScopeTab = 'all' | 'team' | 'fixed' | 'scope';
export const SCOPE_LABEL_KEYS: Record<WikiScopeTab, string> = {
  all: 'wiki.scope.all',
  team: 'wiki.scope.team',
  fixed: 'wiki.scope.fixed',
  scope: 'wiki.scope.scope',
};

export type DetailTab = 'overview' | 'graph' | 'pages' | 'search';

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  type: string;
}

export const TYPE_COLORS: Record<string, string> = {
  entity: 'var(--tea-color-bg-brand-default)',
  concept: 'var(--tea-color-bg-warning-default)',
  source: 'var(--tea-color-bg-amber-default)',
  query: 'var(--tea-color-bg-success-default)',
  synthesis: 'var(--tea-color-bg-error-default)',
  overview: 'var(--tea-color-bg-yellow-default)',
  comparison: 'var(--tea-color-bg-secondary-active)',
  finding: 'var(--tea-color-bg-warning-default)',
  thesis: 'var(--tea-color-bg-error-default)',
  methodology: 'var(--tea-color-bg-success-default)',
  other: 'var(--tea-color-bg-tertiary-default)',
  raw: 'var(--tea-color-bg-secondary-default)',
};
export const TYPE_COLOR_FALLBACK = 'var(--tea-color-text-tertiary)';
