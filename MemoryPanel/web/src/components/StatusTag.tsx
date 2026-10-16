/**
 * StatusTag - generic "status tag" component.
 *
 * Previously Wiki (WikiStatusBadge) and Code (statusLabel) each implemented status → Tea Tag
 * rendering (theme + variant="soft" + optional hint) with identical structure. This unifies them;
 * each asset page only provides its business "status → label/theme" mapping.
 */
import { Tag } from 'tea-component';

export type StatusTheme = 'default' | 'success' | 'warning' | 'error';

export function StatusTag({
  label,
  theme = 'default',
  hint,
  className,
}: {
  /** Translated status text (or the raw status as fallback) */
  label: string;
  /** Tea Tag semantic theme (soft variant) */
  theme?: StatusTheme;
  /** Optional supplementary status hint (e.g. "Processing, this may take a few minutes" for processing) */
  hint?: string;
  /** Outer container class (default _asset-status) */
  className?: string;
}) {
  return (
    <span className={className ?? '_asset-status'}>
      <Tag theme={theme} variant="soft" size="sm">
        {label}
      </Tag>
      {hint && <span className="_asset-status-hint">{hint}</span>}
    </span>
  );
}
