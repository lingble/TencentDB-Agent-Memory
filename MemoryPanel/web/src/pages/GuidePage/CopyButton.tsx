/**
 * CopyButton — the reusable "copy to clipboard" button within GuidePage.
 *
 * Extracted from GuidePage/index.tsx and shared by multiple submodules such as quick start / memory commands,
 * avoiding duplicated copy logic and copied-state feedback.
 *
 * The copy implementation reuses the project's shared copyToClipboard: prefers the Clipboard API in a secure context,
 * and in non-secure contexts (panel accessed via http:// + intranet IP) automatically falls back to
 * a temporary textarea with document.execCommand('copy'), avoiding outright copy failures.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tea } from '@/lib/tea-bridge';
import { copyToClipboard } from '@/pages/ChatMemoryPage/utils/memory-utils';

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      tea.notify.error(t('guide.copyFailed'));
    }
  };
  return (
    <button type="button" className="guide-copy" onClick={copy}>
      {copied ? t('guide.copied') : (label ?? t('guide.copy'))}
    </button>
  );
}
