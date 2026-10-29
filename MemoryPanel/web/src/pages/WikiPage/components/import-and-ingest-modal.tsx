/**
 * ImportAndIngestModal - the single import entry after the 2026-09-21 design merge.
 *
 * Replaces the former "Add" + "Ingest" buttons in the detail page's top bar:
 *   - one Modal hosts the tabs (file / markdown / external);
 *   - the footer has **only one** primary button, whose label changes with the current tab and input:
 *       file / markdown with input -> "Upload and extract"
 *       external with pages checked -> "Import and extract"
 *       no input                    -> "Re-extract"
 *   - the loading label is uniformly "Processing..." (no distinction between cancel/upload/extract phases);
 *   - interrupting the old task is onBusy:'replace' backend logic; the UI shows no hint and no Alert;
 *   - no secondary button (the two-phase "add materials only" capability is no longer kept).
 *
 * The external tab fully reuses the external-source flow of the former "Add" Modal (design §4.3 "structural reuse"):
 * pick Provider -> fill credentials -> fill source URL -> pick traversal strategy -> fetch document tree -> check pages;
 * state and actions (fetchWikiTree / ensureCredential etc.) all come from useWikiSources,
 * initialized by wiki-detail-view via openAddDocExternal when opening the Modal.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Input, Modal, Select, TabPanel, Tabs, Text } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import { AttachIcon } from 'tea-icons-react';
import { isAllowedFile, acceptAttr, maxBytesForFile } from '../utils/wiki-format-store';
import { readUploadFile } from '../utils/wiki-upload-utils';
import { WikiSourcePageTree } from './wiki-source-page-tree';
import type {
  SourceProviderFormField,
  SourceProviderMeta,
  WikiSourceListResult,
} from '@/lib/api/knowledge-api';

export type ImportMode = 'files' | 'markdown' | 'external' | 'reingest';

/**
 * A single file entry waiting to be written to raw.
 *
 * ⚠️ `encoding` **must be passed through**: the check in Knowledge's `routes/wiki.ts` is
 * `r.encoding === "utf8" ? "utf8" : "base64"`, i.e. **base64 by default**.
 * Hand-pasted Markdown is plain text, and without `encoding: 'utf8'` it is stopped by the strict base64 check
 * (`invalid base64 content: <filename>`). The field used to be missing from this type, so the markdown tab always
 * failed; the file tab goes through readUploadFile, which brings its own `encoding: 'base64'` (and the content really
 * is base64), so it always worked.
 */
export interface WikiRawFileInput {
  filename: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

export interface ImportSubmitPayload {
  mode: ImportMode;
  files?: WikiRawFileInput[];
  markdown?: WikiRawFileInput[];
  source_url?: string;
  provider_id?: string;
  page_ids?: string[];
}

interface ExternalFlowProps {
  sourceProviders: SourceProviderMeta[];
  formSourceType: string;
  setFormSourceType: (v: string) => void;
  formCredential: Record<string, string>;
  setCredentialField: (name: string, v: string) => void;
  credConfigured: boolean;
  savingCred: boolean;
  fetchingTree: boolean;
  formSourceUrl: string;
  setFormSourceUrl: (v: string) => void;
  crawlMode: 'tree' | 'links';
  setCrawlMode: (v: 'tree' | 'links') => void;
  treeResult: WikiSourceListResult | null;
  selectedPageIds: string[];
  setSelectedPageIds: (v: string[]) => void;
  onFetchTree: () => void;
}

interface Props {
  visible: boolean;
  /** External source type (iWiki etc.); when set, only the external tab is shown. */
  sourceType?: string | null;
  submitting: boolean;
  external?: ExternalFlowProps;
  onClose: () => void;
  onSubmit: (payload: ImportSubmitPayload) => void | Promise<void>;
}

/**
 * Primary button label: semantic per tab (design §2).
 *
 * ⚠️ Fixed on 2026-10-21: "no input" used to always show "Re-extract", but the case users actually hit is "content
 * pasted, file name not filled in yet". There the intent is to **import a new document**, yet the button said
 * "Re-extract" (and was clickable; clicking it re-ran ingest on the existing material, which is a misoperation).
 *
 * Now it falls back to "Re-extract" only when **this tab has no input at all** (that really is a "just re-run the
 * extraction" request); with any partial input it shows the target action "Upload and extract", and canSubmit
 * disables it while a required field is missing.
 */
function primaryLabel(
  mode: ImportMode,
  hasInput: boolean,
  hasAnyInput: boolean,
  t: (k: string) => string,
): string {
  // No input at all → the user only wants to re-run the extraction
  if (!hasInput && !hasAnyInput) return t('wiki.import.reingest');
  if (mode === 'external') return t('wiki.import.importAndIngest');
  return t('wiki.import.uploadAndIngest');
}

export function ImportAndIngestModal({
  visible,
  sourceType,
  submitting,
  external,
  onClose,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  const isExternal = !!sourceType && !!external;
  const [tab, setTab] = useState<'file' | 'markdown' | 'external'>(
    isExternal ? 'external' : 'file',
  );
  const [files, setFiles] = useState<File[]>([]);
  const [mdFilename, setMdFilename] = useState('');
  const [mdContent, setMdContent] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset manual input on open (external state is initialized by openAddDocExternal on open)
  useEffect(() => {
    if (!visible) return;
    setTab(isExternal ? 'external' : 'file');
    setFiles([]);
    setMdFilename('');
    setMdContent('');
  }, [visible, isExternal]);

  const addFiles = (incoming: File[]) => {
    // ① Extension allowlist
    const allowed = incoming.filter((f) => isAllowedFile(f.name));
    const rejectedFiles = incoming.filter((f) => !isAllowedFile(f.name));
    // The message lists every supported extension so the user can check for themselves (see i18n wiki.detail.ignored)
    if (rejectedFiles.length > 0) {
      tea.notify.warning(t('wiki.detail.ignored', { count: rejectedFiles.length }));
    }

    // ② Size pre-check: **give feedback as soon as the file is picked** and keep oversize files out of the upload list.
    // It used to check only the extension, so a big file over the limit was first base64-encoded after clicking
    // "Upload and extract" (a 36MB file can take seconds to tens of seconds to encode) and then rejected with a 413 by
    // the backend after a network round trip, so users felt "it hangs for a long time before the error". Now they are told
    // right after picking.
    const oversize = allowed.filter((f) => {
      const max = maxBytesForFile(f.name);
      return max !== undefined && f.size > max;
    });
    for (const f of oversize) {
      const max = maxBytesForFile(f.name) ?? 0;
      tea.notify.error(
        t('wiki.detail.upload.fileTooLarge', {
          filename: f.name,
          maxMB: (max / 1024 / 1024).toFixed(1),
        }),
      );
    }
    const accepted = allowed.filter((f) => !oversize.includes(f));
    if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
  };

  const hasFileInput = files.length > 0;
  const hasMdInput = mdFilename.trim().length > 0 && mdContent.trim().length > 0;
  // "Has input" for external = pages checked (the tree must be fetched and checked first, consistent with the original flow)
  const ext = external;
  const hasExternalInput = isExternal ? (ext?.selectedPageIds.length ?? 0) > 0 : false;

  const mode: ImportMode = isExternal
    ? hasExternalInput
      ? 'external'
      : 'reingest'
    : tab === 'file'
      ? hasFileInput
        ? 'files'
        : 'reingest'
      : hasMdInput
        ? 'markdown'
        : 'reingest';
  const hasInput = isExternal ? hasExternalInput : tab === 'file' ? hasFileInput : hasMdInput;

  /**
   * Whether this tab has **anything filled in** (even if incomplete).
   * It tells apart two kinds of "hasInput=false":
   *   - completely empty → the user wants "Re-extract", so submitting is allowed
   *   - half filled      → the user wants "Upload and extract" but a required field is missing, so it should be disabled
   *                        rather than quietly re-ingesting
   */
  const hasAnyInput = isExternal
    ? hasExternalInput || Boolean(ext?.formSourceUrl?.trim()) || Boolean(ext?.formSourceType)
    : tab === 'file'
      ? hasFileInput
      : mdFilename.trim().length > 0 || mdContent.trim().length > 0;

  // Hint for a missing required field: when only the file name or only the content is missing, give clear guidance
  // instead of disabling the button silently.
  const missingHint = (() => {
    if (isExternal) return null;
    if (tab !== 'markdown') return null;
    const nameEmpty = mdFilename.trim().length === 0;
    const contentEmpty = mdContent.trim().length === 0;
    if (nameEmpty && contentEmpty) return null; // completely empty → goes to re-extract
    if (nameEmpty) return t('wiki.detail.mdNameRequired', 'Enter a file name (for example note.md)');
    if (contentEmpty) return t('wiki.detail.mdContentRequired', 'Enter the Markdown content');
    return null;
  })();

  const canSubmit = !submitting && !missingHint && (hasInput || (!isExternal && !hasAnyInput) || !hasInput);

  const handleSubmit = async () => {
    if (submitting) return;

    const payload: ImportSubmitPayload = { mode };
    if (mode === 'files') {
      // Safety net: the normal path already stops oversize files in addFiles, and checking again here guards against
      // bypasses (for example a file changed after it was picked). The check runs **before** base64 encoding, so a big
      // file is not encoded for nothing.
      const oversize = files.filter((f) => {
        const max = maxBytesForFile(f.name);
        return max !== undefined && f.size > max;
      });
      if (oversize.length) {
        for (const f of oversize) {
          tea.notify.error(
            t('wiki.detail.upload.fileTooLarge', {
              filename: f.name,
              maxMB: ((maxBytesForFile(f.name) ?? 0) / 1024 / 1024).toFixed(1),
            }),
          );
        }
        return;
      }
      // One base64 channel: every format travels as base64, and the server decodes it and writes the original bytes
      const items = await Promise.all(files.map(readUploadFile));
      payload.files = items;
    } else if (mode === 'markdown') {
      // Same pre-check as the files tab: a hand-pasted MD is also stopped by the text-tier limit (512KB by default).
      // There used to be no check, so an over-long text only got rejected after the full request, and the error text
      // hard-coded 512KB.
      const fname = mdFilename.trim();
      const max = maxBytesForFile(fname);
      const size = new Blob([mdContent]).size;
      if (max !== undefined && size > max) {
        tea.notify.error(
          t('wiki.detail.upload.fileTooLarge', {
            filename: fname,
            maxMB: (max / 1024 / 1024).toFixed(1),
          }),
        );
        return;
      }
      // ⚠️ `encoding:'utf8'` must be explicit: Knowledge decodes as base64 by default and validates strictly
      // (routes/wiki.ts), so a hand-pasted plain-text MD without this marker is judged invalid base64 →
      // `invalid base64 content: <filename>`.
      payload.markdown = [{ filename: fname, content: mdContent, encoding: 'utf8' }];
    } else if (mode === 'external' && ext) {
      payload.source_url = ext.formSourceUrl.trim();
      payload.provider_id = ext.formSourceType;
      payload.page_ids = ext.selectedPageIds;
    }
    await onSubmit(payload);
  };

  return (
    <Modal
      visible={visible}
      caption={t('wiki.import.caption')}
      size="m"
      onClose={onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        <Tabs
          tabs={
            isExternal
              ? [{ id: 'external', label: t('wiki.detail.addDoc.external') }]
              : [
                  { id: 'file', label: t('wiki.detail.addDoc.file') },
                  { id: 'markdown', label: t('wiki.detail.addDoc.markdown') },
                ]
          }
          activeId={tab}
          onActive={(tb) => setTab(tb.id as 'file' | 'markdown' | 'external')}
        >
          <TabPanel id="file">
            <div className="_wiki-detail-upload-panel">
              <div
                className="_wiki-detail-dropzone"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  addFiles(Array.from(e.dataTransfer.files));
                }}
              >
                <AttachIcon size={20} />
                <p>{t('wiki.detail.dropzone')}</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept={acceptAttr()}
                multiple
                className="_wiki-detail-hidden-input"
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              {files.length > 0 && (
                <ul className="_wiki-detail-file-list">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`}>
                      {f.name}
                      <Button
                        type="link"
                        onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        {t('common.remove')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </TabPanel>

          <TabPanel id="markdown">
            <Input
              placeholder={t('wiki.detail.mdName')}
              value={mdFilename}
              onChange={(v) => setMdFilename(String(v ?? ''))}
            />
            <textarea
              className="_wiki-detail-md-editor"
              placeholder={t('wiki.detail.mdContent')}
              value={mdContent}
              onChange={(e) => setMdContent(e.target.value)}
              rows={10}
            />
          </TabPanel>

          <TabPanel id="external">
            {ext && (
              <div className="_wiki-detail-external-panel" style={{ paddingTop: 8 }}>
                {/* Source selection */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ marginBottom: 4 }}>{t('wiki.register.source')}</div>
                  <Select
                    size="full"
                    value={ext.formSourceType}
                    onChange={(v) => {
                      ext.setFormSourceType(v);
                      // Switching source clears checked pages
                      ext.setSelectedPageIds([]);
                    }}
                    options={[
                      { value: '', text: '—' },
                      ...ext.sourceProviders.map((p: SourceProviderMeta) => {
                        const key = `wiki.source.${p.id}`;
                        const localized = t(key);
                        return { value: p.id, text: localized === key ? p.id : localized };
                      }),
                    ]}
                  />
                </div>

                {/* Credential fields (rendered dynamically from form_fields) - not required again when credentials are stored */}
                {ext.formSourceType && !ext.credConfigured && (
                  <>
                    <Alert type="info">{t('wiki.register.credHint')}</Alert>
                    {(ext.sourceProviders.find((p) => p.id === ext.formSourceType)?.form_fields ?? []).map(
                      (field: SourceProviderFormField, idx: number, arr: readonly SourceProviderFormField[]) => {
                        const provider = ext.sourceProviders.find((p) => p.id === ext.formSourceType)!;
                        const isLast = idx === arr.length - 1;
                        const labelKey = `code.credField.${field.name}.label`;
                        const label = t(labelKey);
                        const phKey = `code.credField.${field.name}.placeholder`;
                        const ph = t(phKey);
                        return (
                          <div key={field.name} style={{ marginBottom: 12 }}>
                            <div style={{ marginBottom: 4 }}>
                              {label === labelKey ? field.name : label}
                              {field.required && <span style={{ color: '#d0021b' }}> *</span>}
                            </div>
                            <Input
                              size="full"
                              type={field.secret ? 'password' : 'text'}
                              value={ext.formCredential[field.name] ?? ''}
                              onChange={(v) => ext.setCredentialField(field.name, v)}
                              placeholder={ph === phKey ? '' : ph}
                            />
                            {isLast && provider.token_doc_url && (
                              <a
                                href={provider.token_doc_url}
                                target="_blank"
                                rel="noreferrer"
                                className="_wikilist-token-doc"
                              >
                                {t('code.register.tokenDoc')}
                              </a>
                            )}
                          </div>
                        );
                      },
                    )}
                  </>
                )}

                {/* Source URL */}
                {ext.formSourceType && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ marginBottom: 4 }}>{t('wiki.register.sourceUrl')}</div>
                    <Input
                      size="full"
                      value={ext.formSourceUrl}
                      onChange={ext.setFormSourceUrl}
                      placeholder={t('wiki.register.sourceUrlPlaceholder')}
                    />
                    <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>
                      {t('wiki.register.sourceUrlExtra')}
                    </div>
                  </div>
                )}

                {/* Traversal strategy: decides how documents are discovered starting from the source URL */}
                {ext.formSourceType && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ marginBottom: 4 }}>{t('wiki.register.crawlMode')}</div>
                    <Select
                      size="full"
                      value={ext.crawlMode ?? 'tree'}
                      options={[
                        { value: 'tree', text: t('wiki.register.crawlMode.tree') },
                        { value: 'links', text: t('wiki.register.crawlMode.links') },
                      ]}
                      onChange={(v) => ext.setCrawlMode((v || 'tree') as 'tree' | 'links')}
                    />
                    <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>
                      {ext.crawlMode === 'links'
                        ? t('wiki.register.crawlHint.links')
                        : t('wiki.register.crawlHint.tree')}
                    </div>
                  </div>
                )}

                {/* Fetch button: no stored credentials -> save first, then fetch (stored credentials are a prerequisite for fetching the tree) */}
                {ext.formSourceType && (
                  <Button
                    type="primary"
                    onClick={ext.onFetchTree}
                    disabled={ext.fetchingTree || ext.savingCred || !ext.formSourceUrl.trim()}
                    loading={ext.fetchingTree || ext.savingCred}
                    style={{ marginBottom: 12 }}
                  >
                    {ext.fetchingTree || ext.savingCred
                      ? t('wiki.register.fetching')
                      : ext.credConfigured
                        ? t('wiki.register.fetch')
                        : t('wiki.register.saveAndFetch')}
                  </Button>
                )}

                {/* Document tree checkboxes (hierarchy restored by parentId; folders collapsible / quick select-all) */}
                {ext.treeResult && (
                  <div>
                    <WikiSourcePageTree
                      pages={ext.treeResult.pages}
                      selectedPageIds={ext.selectedPageIds}
                      onToggleLeaf={(id, checked) =>
                        ext.setSelectedPageIds(
                          checked
                            ? [...ext.selectedPageIds, id]
                            : ext.selectedPageIds.filter((x) => x !== id),
                        )
                      }
                      onToggleDir={(ids, checked) =>
                        ext.setSelectedPageIds(
                          checked
                            ? [...new Set([...ext.selectedPageIds, ...ids])]
                            : ext.selectedPageIds.filter((x) => !ids.includes(x)),
                        )
                      }
                    />
                    <Text theme="weak" style={{ marginTop: 8, display: 'block' }}>
                      {t('wiki.import.selectedPages', { count: ext.selectedPageIds.length })}
                    </Text>
                  </div>
                )}
              </div>
            )}
          </TabPanel>
        </Tabs>
      </Modal.Body>
      <Modal.Footer>
        {/* A missing required field gets clear guidance, so nobody wonders why the button is grey */}
        {missingHint && (
          <Text theme="warning" style={{ marginRight: 12, alignSelf: 'center' }}>
            {missingHint}
          </Text>
        )}
        {/* Design §2.3: the two-phase capability is no longer kept - there's only this one primary button, no secondary button.
            No separate "Import" button below the tree; submission is unified through the footer primary button. */}
        <Button type="primary" onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
          {primaryLabel(mode, hasInput, hasAnyInput, t)}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
