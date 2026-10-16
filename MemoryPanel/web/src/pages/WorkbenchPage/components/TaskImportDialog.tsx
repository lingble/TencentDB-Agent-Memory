/**
 * TaskImportDialog — the "Import Task" dialog.
 *
 * Structure:
 *   1. When unauthenticated, first show the **token popup** (CredentialGate); the main page appears only after authentication succeeds.
 *   2. Main page = filter bar (project/type/title/assignee) → table (select/title/status) → pagination → submit/cancel.
 *
 * Key conventions:
 *   - The token lives only in component memory, is dropped on close, and never goes to localStorage or the database.
 *   - **Cross-page selection is preserved**: Map<`${item_type}:${external_id}`, CandidateItem>.
 *     The three work item kinds share the same id shape (19-digit strings), so without a type prefix they would overwrite each other.
 *   - **Batch failure isolation**: the backend processes items one by one, and results are split into created / failed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Checkbox,
  ExternalLink,
  Form,
  Input,
  Justify,
  Modal,
  Pagination,
  Segment,
  Select,
  Space,
  Table,
  Text,
} from 'tea-component';
import {
  taskSourceApi,
  type CandidateItem,
  type Credential,
  type TaskSourceProvider,
  type TaskWorkspace,
} from '../../../lib/api/taskSource';
import { useSourceLabel } from '../utils/workbench-utils';
import { invalidateBackendCache } from '@/stores/backend';
import { tea } from '@/lib/tea-bridge';
import { getPanelSession } from '@/lib/panelSession';

const { autotip, selectable } = Table.addons;

const DEFAULT_PAGE_SIZE = 10;

/**
 * Selectable page sizes.
 *
 * The cap of 100 is a **server-side constraint**, enforced in two places:
 *   - Core input validation `limit: z.coerce.number().int().min(1).max(100)`;
 *   - the TAPD provider's `clampLimit()` also truncates at MAX_LIMIT=100.
 * Anything higher would just be silently truncated, making "200 per page" a misleading option.
 */
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/**
 * Key for cross-page selection: must carry a type prefix, because the three work item kinds share the same id shape.
 *
 * If external_id / item_type is missing (happens when backend field names don't match the frontend),
 * `undefined:undefined` makes **all rows share the same key**, which shows up as "checking one checks all".
 * So rowKey is injected as soon as data lands: use `type:id` when the fields are present, otherwise fall back to appending the array index,
 * guaranteeing that no two rows share a key.
 */
function withRowKey(items: CandidateItem[]): Row[] {
  return items.map((it, idx) => ({
    ...it,
    rowKey: it.item_type && it.external_id ? `${it.item_type}:${it.external_id}` : `__row_${idx}`,
  }));
}

/** Candidate item with a stable row identifier. */
type Row = CandidateItem & { rowKey: string };

/**
 * Build the token to submit according to the auth scheme declared by the provider.
 *
 * For the custom scheme, the header name **must come from AuthScheme.headerName sent by the backend**;
 * hardcoding a source-specific header makes a second custom source send the wrong header (a real bug).
 */
function buildCredential(
  kind: 'bearer' | 'basic' | 'custom',
  secret: string,
  headerName?: string,
): Credential {
  if (kind === 'custom') {
    return { kind, secret, extra: headerName ? { header: headerName } : undefined };
  }
  return { kind, secret };
}

/** Minimum TAPD token length (both Taihu tokens and personal tokens are far longer than this). */
const MIN_TOKEN_LEN = 20;

/**
 * Frontend pre-validation.
 *
 * A real token can't be this short, nor can it contain an ellipsis; these two traits mean the user
 * took the **example text in the UI** as the value to enter (this has happened: the example literal was pasted directly).
 * Blocking it before submission is much easier than letting the server return an empty project list and debugging from there.
 *
 * Validation relies only on the two **source-agnostic** traits "length / ellipsis",
 * and does not check token prefix or format; that is a source-side authentication detail.
 */
function validateToken(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'empty';
  // Inside a character class `.` is already literal, so no escape is needed (escaping triggers no-useless-escape).
  if (/[….]{2,}|…/.test(v)) return 'placeholder';
  if (v.length < MIN_TOKEN_LEN) return 'tooShort';
  return null;
}

/**
 * Token collection popup.
 *
 * "List projects" doubles as the connectivity check: an invalid token errors out here,
 * so there is no separate verify endpoint (one fewer endpoint, one fewer round trip).
 */
function CredentialGate(props: {
  provider: TaskSourceProvider;
  /** Source display name (localized), used for the popup title. */
  sourceLabel: string;
  teamId: string;
  onAuthed: (credential: Credential, workspaces: TaskWorkspace[]) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const schemes = props.provider.auth_schemes;
  const [kind, setKind] = useState<'bearer' | 'basic' | 'custom'>(schemes[0]?.kind ?? 'bearer');
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Currently selected auth method (hint text and the application page both follow it). */
  const activeScheme = schemes.find((s) => s.kind === kind);

  async function submit() {
    const problem = validateToken(value);
    if (problem) {
      setError(t(`taskImport.tokenInvalid.${problem}`));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const scheme = schemes.find((s) => s.kind === kind);
      const credential = buildCredential(
        kind,
        value.trim(),
        scheme?.kind === 'custom' ? scheme.headerName : undefined,
      );
      const res = await taskSourceApi.workspaces(props.teamId, props.provider.id, credential);
      const ws = res.workspaces ?? [];
      // Token is valid but the account has no projects: say so explicitly, so it isn't mistaken for "the panel didn't load".
      if (!ws.length) {
        setError(t('taskImport.noWorkspaces'));
        return;
      }
      props.onAuthed(credential, ws);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      visible
      caption={t('taskImport.captionFrom', { source: props.sourceLabel })}
      size="s"
      onClose={props.onCancel}
      disableEscape={loading}
    >
      <Modal.Body>
        {error && <Alert type="error">{error}</Alert>}
        {/* vertical layout: the control area is block-level, so Input size="full" can fill the popup width
            (tea 2.8.0's Space is inline-flex + align-items:center and doesn't pass style through, so it can't stretch) */}
        <Form layout="vertical" style={{ width: '100%' }}>
          {/* Auth methods are mutually exclusive radios: no need to ask the user to choose when there is only one */}
          {schemes.length > 1 && (
            <Form.Item>
              <Segment
                value={kind}
                onChange={(next) => setKind(next as typeof kind)}
                options={schemes.map((s) => ({ value: s.kind, text: s.label }))}
              />
            </Form.Item>
          )}
          {/*
            Token application/lookup guide: the URL comes from deployment config (one per auth method).
            Like the iWiki / Gongfeng source registration dialogs, it hangs off Form.Item's extra; not rendered if unconfigured,
            **no built-in fallback URL** (the domain is deployment info, and hardcoding it would point to the wrong environment).
            External links use ExternalLink (forced _blank); rel must be passed explicitly to prevent tabnabbing.
          */}
          <Form.Item
            extra={
              activeScheme?.token_doc_url ? (
                <ExternalLink href={activeScheme.token_doc_url} rel="noopener noreferrer">
                  {t('taskImport.tokenDoc')}
                </ExternalLink>
              ) : undefined
            }
          >
            <Input
              type="password"
              size="full"
              placeholder={t('taskImport.tokenPlaceholder')}
              value={value}
              onChange={(v) => setValue(v)}
            />
          </Form.Item>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={props.onCancel}>{t('common.cancel')}</Button>
        <Button type="primary" disabled={!value.trim() || loading} onClick={() => void submit()}>
          {t('taskImport.connect')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export default function TaskImportDialog(props: {
  teamId: string;
  providers: TaskSourceProvider[];
  /** Id of the source to import from (passed in from the item selected in the "Import Task" dropdown). */
  providerId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const sourceLabel = useSourceLabel();
  // Locate the source by id (no longer "take the first one"): in multi-source setups, use whichever was selected.
  const provider = props.providers.find((p) => p.id === props.providerId);
  const providerLabel = provider ? sourceLabel(provider.id) : '';

  /** Auth state: non-empty means the token has passed validation. */
  const [credential, setCredential] = useState<Credential | null>(null);
  const [workspaces, setWorkspaces] = useState<TaskWorkspace[]>([]);

  // Filter conditions
  const [workspaceId, setWorkspaceId] = useState('');
  const [itemTypes, setItemTypes] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  /**
   * "Assignee" defaults to the current user's **username**.
   *
   * Note this is not user_id: `user_id` looks like `usr-xxx`, while TAPD assignee accounts look like
   * `wlleiiwang`; getting it wrong returns 0 rows and is hard to notice.
   * When username is unavailable (not logged in, etc.), leave it empty for the user to fill in.
   */
  const [owner, setOwner] = useState(() => getPanelSession()?.user?.username ?? '');

  /**
   * Whether this source supports "To-do" (declared by backend capabilities, not assumed by the frontend).
   * Unsupported sources don't show the toggle and don't send only_todo.
   */
  const supportsTodo = provider?.capabilities?.todo === true;

  /**
   * "To-do" toggle: on by default for sources that support it.
   *
   * Checked → use the source's to-do endpoint (only the current token user's to-do items);
   * unchecked → use the regular endpoint (filterable by title / assignee).
   * The to-do endpoint doesn't accept title or assignee parameters (the server rejects them), so those two inputs are disabled when checked.
   */
  const [onlyTodo, setOnlyTodo] = useState(supportsTodo);

  const [items, setItems] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selected, setSelected] = useState<Map<string, Row>>(new Map());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxBatch = provider?.max_batch_size ?? 50;
  const selectedList = useMemo(() => [...selected.values()], [selected]);
  const selectedKeys = useMemo(() => [...selected.keys()], [selected]);
  const overLimit = selectedList.length > maxBatch;

  /**
   * All rows seen so far (accumulated across pages).
   *
   * The selectable plugin's onChange only returns a **key array**, while submission needs whole rows
   * (external_id / item_type / scope). After paging, the previous page's rows are no longer in `items`,
   * and the current page alone can't restore previously selected rows, so a ref accumulates a key → Row map.
   */
  const seenRowsRef = useRef<Map<string, Row>>(new Map());

  const loadCandidates = useCallback(async () => {
    if (!provider || !credential) return;
    // workspace_id is required only for the regular list endpoint; optional for the to-do endpoint
    // (omitted = all to-dos across projects), so in to-do mode no project needs to be selected.
    if (!onlyTodo && !workspaceId) {
      setError(t('taskImport.needWorkspace'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await taskSourceApi.candidates(props.teamId, provider.id, credential, {
        workspace_id: workspaceId || undefined,
        item_types: itemTypes.length ? itemTypes : undefined,
        // In to-do mode the server doesn't accept these two parameters, so just don't send them.
        keyword: !onlyTodo && keyword.trim() ? keyword.trim() : undefined,
        owner: !onlyTodo && owner.trim() ? owner.trim() : undefined,
        page,
        limit: pageSize,
        only_todo: onlyTodo,
      });
      const rows = withRowKey(res.items ?? []);
      // Register in "seen rows" first, then hand to the table, so row data is always found when selectable returns keys
      for (const row of rows) seenRowsRef.current.set(row.rowKey, row);
      setItems(rows);
      setTotal(res.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [
    provider,
    credential,
    workspaceId,
    itemTypes,
    keyword,
    owner,
    onlyTodo,
    page,
    pageSize,
    props.teamId,
    t,
  ]);

  /**
   * Auto-query triggers: **authentication completes** + **page change / page size change** + **to-do toggle switch**.
   *
   * Changes to other filters (project / type / title / assignee) do **not** auto-send requests;
   * a single TAPD query hits multiple type endpoints + a status mapping table, so firing per keystroke would overwhelm the gateway.
   *
   * The to-do toggle is the exception: it "switches the data source" rather than "adds a filter",
   * and to-do mode has no usable filter parameters (title/assignee are disabled), so clicking "Filter" adds no information;
   * making the user click again is pointless. Switching triggers a query.
   */
  useEffect(() => {
    if (!credential) return;
    void loadCandidates();
    // loadCandidates is only a stable reference; triggers are controlled by the three cases above + the "Filter" button.
    // workspaceId / keyword / owner are intentionally left out of deps: changing them doesn't auto-send; click "Filter".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credential, page, pageSize, onlyTodo]);

  /**
   * "Filter" button: after filter changes, go back to page 1 and query.
   * If already on page 1, trigger manually once (useEffect won't rerun when deps are unchanged).
   */
  function applyFilter() {
    if (page === 1) void loadCandidates();
    else setPage(1);
  }

  function onAuthed(cred: Credential, ws: TaskWorkspace[]) {
    setCredential(cred);
    setWorkspaces(ws);
    // By default **no specific project is selected** (= "All projects"): to-do is the default-on data source,
    // and the to-do endpoint's workspace_id is optional; omitting it spans projects for the widest coverage.
    // In regular mode a project is required; unchecking "To-do" automatically falls back to the first project (see the checkbox onChange).
    setWorkspaceId('');
  }

  /**
   * Selection callback of the selectable plugin.
   *
   * The plugin only knows keys: the returned `keys` are "this page's result after changes + existing keys from other pages"
   * (CheckTree adds/removes against the full set of the passed value, keeping unknown keys as-is),
   * so cross-page selections are naturally preserved. Here the Map is rebuilt by key, with row data taken from seenRowsRef.
   */
  function handleSelectChange(keys: string[]) {
    setSelected((prev) => {
      const next = new Map<string, Row>();
      for (const key of keys) {
        const row = seenRowsRef.current.get(key) ?? prev.get(key);
        if (row) next.set(key, row);
      }
      return next;
    });
  }

  async function submit() {
    if (!provider || !credential || overLimit || !selectedList.length) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await taskSourceApi.import(
        props.teamId,
        provider.id,
        credential,
        selectedList.map((i) => ({
          external_id: i.external_id,
          item_type: i.item_type,
          scope: i.scope,
        })),
      );
      tea.notify.success(
        t('taskImport.result', {
          created: res.created?.length ?? 0,
          failed: res.failed?.length ?? 0,
        }),
      );
      props.onImported();
      invalidateBackendCache();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  if (!provider) return null;

  // Unauthenticated: show only the token popup.
  if (!credential) {
    return (
      <CredentialGate
        provider={provider}
        sourceLabel={providerLabel}
        teamId={props.teamId}
        onAuthed={onAuthed}
        onCancel={props.onClose}
      />
    );
  }

  return (
    <Modal
      visible
      caption={t('taskImport.captionFrom', { source: providerLabel })}
      size="l"
      onClose={props.onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        {error && <Alert type="error">{error}</Alert>}
        {overLimit && <Alert type="warning">{t('taskImport.overLimit', { max: maxBatch })}</Alert>}

        {/* Filter bar: inline form that wraps automatically when there are many items (Justify is not used to split left/right
            because the 4 conditions on the left would squeeze the right column, compressing the "To-do" label into a vertical stack) */}
        <Table.ActionPanel>
          <Form layout="inline">
            {/*
              In regular mode the project is **required**: stories_get / tasks_get / bugs_get all require
              workspace_id, and omitting it errors with "workspace_id is missing from the current parameters".
              Optional in to-do mode: omitting it fetches all of the current user's to-dos across projects.
            */}
            <Form.Item label={t('taskImport.workspace')}>
              <Select
                appearance="button"
                matchButtonWidth
                searchable
                value={workspaceId}
                onChange={(v) => setWorkspaceId(v)}
                disabled={!workspaces.length}
                placeholder={t('taskImport.selectWorkspace')}
                options={[
                  ...(supportsTodo && onlyTodo
                    ? [{ value: '', text: t('taskImport.allWorkspaces') }]
                    : []),
                  ...workspaces.map((w) => ({ value: w.id, text: w.name })),
                ]}
              />
            </Form.Item>

            <Form.Item label={t('taskImport.type')}>
              <Select
                appearance="button"
                matchButtonWidth
                value={itemTypes[0] ?? ''}
                onChange={(v) => setItemTypes(v ? [v] : [])}
                options={[
                  { value: '', text: t('taskImport.allTypes') },
                  ...provider.item_types.map((it) => ({ value: it.id, text: it.label })),
                ]}
              />
            </Form.Item>

            <Form.Item label={t('taskImport.title')}>
              <Input
                placeholder={t('taskImport.titlePlaceholder')}
                value={keyword}
                onChange={(v) => setKeyword(v)}
                disabled={onlyTodo}
              />
            </Form.Item>

            <Form.Item label={t('taskImport.owner')}>
              <Input
                placeholder={t('taskImport.ownerPlaceholder')}
                value={owner}
                onChange={(v) => setOwner(v)}
                disabled={onlyTodo}
              />
            </Form.Item>

            {/* To-do toggle: shown only when the source declares support (capabilities.todo) */}
            {supportsTodo && (
              <Form.Item>
                <Checkbox
                  value={onlyTodo}
                  tooltip={t('taskImport.onlyTodoHint')}
                  onChange={(next) => {
                    setOnlyTodo(next);
                    // In regular mode a project is required, and "All projects" only makes sense in to-do mode;
                    // when switching back to regular mode while still on an empty value, fall back to the first project, otherwise the endpoint reports missing workspace_id.
                    if (!next && !workspaceId && workspaces.length) {
                      setWorkspaceId(workspaces[0].id);
                    }
                    // The data source changed and the previous results no longer apply: clear the selection so entries from the old mode don't mix in.
                    setSelected(new Map());
                    setPage(1);
                  }}
                >
                  {t('taskImport.onlyTodo')}
                </Checkbox>
              </Form.Item>
            )}

            {/* Explicit trigger: filter changes don't auto-send requests; the query runs only on click.
                In to-do mode the project is optional (none = across projects), so it can't be disabled based on workspaceId. */}
            <Form.Item>
              <Button
                type="primary"
                disabled={loading || (!onlyTodo && !workspaceId)}
                onClick={applyFilter}
              >
                {t('taskImport.filter')}
              </Button>
            </Form.Item>
          </Form>
        </Table.ActionPanel>

        {/* Table: the checkbox column is injected by the selectable plugin (including header select-all, indeterminate state, and clickable rows) */}
        <Table<Row>
          records={items}
          recordKey={(r) => r.rowKey}
          columns={[
            { key: 'title', header: t('taskImport.title'), render: (i: CandidateItem) => i.title },
            {
              key: 'status',
              header: t('taskImport.status'),
              width: 120,
              render: (i: CandidateItem) =>
                i.status ? <Text>{i.status}</Text> : <Text theme="weak">-</Text>,
            },
          ]}
          addons={[
            // Only wire isLoading: `error` also carries submit failures, and driving the table's "load failed" state from it would misreport
            autotip({ isLoading: loading }),
            selectable({
              value: selectedKeys,
              onChange: handleSelectChange,
              rowSelect: true,
            }),
          ]}
        />

        {/* Server-side pagination: page index and page size are both controlled; the page size dropdown is the limit.
            tea 2.8.0's Pagination has no disabled prop, so operations are blocked in the callback while loading. */}
        <Pagination
          recordCount={total}
          pageIndex={page}
          pageSize={pageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          stateText={t('taskImport.total', { count: total })}
          onPagingChange={({ pageIndex, pageSize: nextSize }) => {
            if (loading) return;
            // When the page size changes, the component already resets pageIndex to 1 (isPagingReset defaults to true),
            // so just send both values together; no need to distinguish paging from page size changes.
            if (nextSize && nextSize !== pageSize) setPageSize(nextSize);
            if (pageIndex) setPage(pageIndex);
          }}
        />
      </Modal.Body>
      <Modal.Footer>
        <Justify
          left={<Text reset>{t('taskImport.selected', { count: selectedList.length })}</Text>}
          right={
            <Space>
              <Button onClick={props.onClose}>{t('common.cancel')}</Button>
              <Button
                type="primary"
                disabled={!selectedList.length || overLimit || submitting}
                onClick={() => void submit()}
              >
                {t('taskImport.submit')}
              </Button>
            </Space>
          }
        />
      </Modal.Footer>
    </Modal>
  );
}
