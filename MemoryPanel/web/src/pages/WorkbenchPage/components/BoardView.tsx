/**
 * BoardView - workbench task card grid + detail drawer.
 */
import { useTranslation } from 'react-i18next';
import { Button, Copy, Drawer, Dropdown, List, Pagination, Tag, Text } from 'tea-component';
import { AddIcon, ChevronDownIcon, ChevronRightIcon, UsergroupIcon } from 'tea-icons-react';
import { canDeleteTask, type Task, type Team } from '@/services';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import TaskDetail from './TaskDetail';
import {
  participationOf,
  readExternalProvider,
  useSourceLabel,
  useStatusLabels,
  visibleAgentIds,
  type AgentOption,
  type TaskParticipationView,
} from '../utils/workbench-utils';

/**
 * Selectable page sizes. Default 12 matches TaskWorkbench's initial value;
 * capped at 96 - the kernel meta list limit max is 100, so page size must stay within it.
 */
const PAGE_SIZE_OPTIONS = [12, 24, 48, 96];

/**
 * "Import Task" dropdown entry.
 *
 * Why not a plain button: multiple import sources will be added later (currently only TAPD),
 * so the user must first choose "which source to import from". The list is driven by sources enabled on the backend -
 * adding a source means adding a provider to the backend registry, with no frontend change here.
 *
 * Keep the dropdown form even with a single source: one extra click, but the interaction matches the multi-source case,
 * avoiding "button behavior suddenly changing when a second source is added".
 */
function ImportTaskDropdown({
  sources,
  onPick,
}: {
  sources: Array<{ id: string }>;
  onPick: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  const sourceLabel = useSourceLabel();
  return (
    <Dropdown
      appearance="pure"
      clickClose
      button={
        <Button type="weak">
          {t('task.import')}
          <ChevronDownIcon size={14} />
        </Button>
      }
    >
      {() => (
        <List type="option">
          {sources.map((s) => (
            <List.Item key={s.id} onClick={() => onPick(s.id)}>
              {t('task.importFrom', { source: sourceLabel(s.id) })}
            </List.Item>
          ))}
        </List>
      )}
    </Dropdown>
  );
}

export default function BoardView({
  tasks,
  tasksLoading,
  tasksTotal,
  currentPage,
  setCurrentPage,
  pageSize,
  setPageSize,
  selected,
  onSelect,
  onCreate,
  onDelete,
  onUpdateStatus,
  onUpdateTask,
  /**
   * "Import Task" entry (dropdown to choose a source).
   *
   * Passing undefined or empty sources → entry hidden: when the backend has no external source enabled,
   * we shouldn't expose an entry that is guaranteed to fail when opened.
   */
  onImport,
  importSources,
  agents,
  teams,
  currentUser,
  participationByTask,
}: {
  tasks: Task[];
  tasksLoading: boolean;
  tasksTotal: number;
  currentPage: number;
  setCurrentPage: (page: number) => void;
  pageSize: number;
  setPageSize: (size: number) => void;
  selected: Task | null;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onDelete: (task: Task) => void;
  onUpdateStatus: (task: Task, status: Task['status']) => void;
  onUpdateTask: (
    task: Task,
    patch: Partial<
      Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>
    >,
  ) => void;
  /** Callback after a source is selected; the argument is that source's id (e.g. `tapd`). */
  onImport?: (providerId: string) => void;
  /** Importable sources (enabled on the backend). Empty → entry hidden. */
  importSources?: Array<{ id: string }>;
  agents: AgentOption[];
  teams: Team[];
  currentUser: string;
  participationByTask: Map<string, TaskParticipationView>;
}) {
  const { t } = useTranslation();
  const statusLabels = useStatusLabels();
  // Source chip: a concrete source (tapd…) → display name; manual tasks show "Created manually"
  const sourceLabel = useSourceLabel();
  // Participant tooltip shows display_name rather than user_id (same cache as the drawer's UserChip)
  const resolveUserName = useDisplayNameResolver();
  const selectedTeam = selected
    ? (teams.find((x) => x.team_id === selected.team_id) ?? null)
    : null;

  // Backend pagination: useTasks already returns only the current page, no frontend slicing needed
  const totalPages = Math.max(1, Math.ceil(tasksTotal / pageSize));
  // Out-of-range guard: the parent already uses an effect to pull currentPage back into range;
  // this clamp is only a display fallback for the frame before that takes effect; the real fix is in TaskWorkbench.
  const safePage = Math.min(currentPage, totalPages);
  const pagedTasks = tasks;
  return (
    <div className="_memory-panel-card">
      {/* Header: reuses the common Section header of members / agents (title + count Tag + subtitle + right-side actions) */}
      <div className="_memory-section-header">
        <div className="_memory-section-header-info">
          <div className="_memory-section-header-title-row">
            <div className="_memory-section-title">{t('task.list.title')}</div>
            <Tag size="sm">{t('task.list.count', { count: tasksTotal })}</Tag>
          </div>
          <div className="_memory-section-subtitle">{t('task.list.subtitle')}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* When no external source is enabled importSources is empty → entry hidden */}
          {onImport && importSources && importSources.length > 0 && (
            <ImportTaskDropdown sources={importSources} onPick={onImport} />
          )}
          <Button type="primary" onClick={onCreate}>
            <AddIcon size={14} />
            {t('task.create')}
          </Button>
        </div>
      </div>

      {tasksLoading && tasks.length === 0 ? (
        // First-load skeleton: 6 placeholder cards + shimmer animation
        <div className="_memory-workbench-skeleton-grid" aria-label="loading">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="_memory-workbench-skeleton-card">
              <div className="_memory-workbench-skeleton-line _memory-workbench-skeleton-line--title" />
              <div className="_memory-workbench-skeleton-line _memory-workbench-skeleton-line--desc" />
              <div className="_memory-workbench-skeleton-line _memory-workbench-skeleton-line--meta" />
            </div>
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="_memory-workbench-list-empty">
          <Text theme="weak">{t('task.empty')}</Text>
        </div>
      ) : (
        <div className="_memory-workbench-task-grid">
          {pagedTasks.map((task) => {
            const view = participationOf(participationByTask, task.task_id);
            const imParticipant = view.users.includes(currentUser);
            const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
            // Same as the drawer: filter out import sentinels (historical participation records), don't render the "External task import" tag.
            const agentLabels = visibleAgentIds(view.agentIds).map(
              (id) => agentNameById.get(id) ?? id,
            );
            return (
              <button
                type="button"
                key={task.task_id}
                className={`_memory-workbench-task-card _memory-workbench-task-card--${task.status}`}
                onClick={() => onSelect(task.task_id)}
              >
                {/* Header row: title + status pill on the right + arrow */}
                <div className="_memory-workbench-task-card-head">
                  <span className="_memory-workbench-task-card-title" title={task.title}>
                    {task.title}
                  </span>
                  <span
                    className={`_memory-workbench-status-pill _memory-workbench-status-pill--${task.status}`}
                  >
                    {statusLabels[task.status]}
                  </span>
                  <ChevronRightIcon size={14} className="_memory-workbench-task-card-chevron" />
                </div>

                {/* id + source chips: id is click-to-copy (tea Copy has a built-in "Copied" bubble) */}
                <div className="_memory-workbench-task-card-chips">
                  <Tag size="sm" variant="outlined" className="_memory-workbench-task-card-id">
                    {/* stopPropagation: the copy click must not bubble up into card selection (opening the drawer) */}
                    <span onClick={(e) => e.stopPropagation()}>
                      <Copy text={task.task_id}>
                        <span className="_memory-mono">{task.task_id}</span>
                      </Copy>
                    </span>
                  </Tag>
                  <Tag size="sm">{sourceLabel(readExternalProvider(task) ?? 'manual')}</Tag>
                </div>

                {/* Description: show a placeholder line even when empty, to keep card heights consistent */}
                <p
                  className={
                    task.description?.trim()
                      ? '_memory-workbench-task-card-desc'
                      : '_memory-workbench-task-card-desc _memory-workbench-task-card-desc--empty'
                  }
                >
                  {task.description?.trim() || t('task.noDesc')}
                </p>

                {/* Gray panel: participants / Agent count (tooltip lists the names) */}
                <div className="_memory-workbench-task-card-panel">
                  <span
                    className="_memory-workbench-meta-item"
                    title={
                      view.users.length === 0
                        ? t('task.participants.empty')
                        : t('task.participants.tooltip', {
                            users: view.users.map((u) => resolveUserName(u)).join('\n'),
                          })
                    }
                  >
                    <UsergroupIcon size={12} />
                    {t('task.peopleCount', { count: view.users.length })}
                    {imParticipant && (
                      <span className="_memory-workbench-meta-you">{t('common.you2')}</span>
                    )}
                  </span>
                  <span className="_memory-workbench-meta-sep">/</span>
                  <span
                    className="_memory-workbench-meta-item"
                    title={
                      agentLabels.length === 0
                        ? t('task.agents.empty')
                        : t('task.agents.tooltip', { agents: agentLabels.join('\n') })
                    }
                  >
                    {t('task.agentCount', { count: agentLabels.length })}
                  </span>
                </div>

                {/* Footer: creation time */}
                <div className="_memory-workbench-task-card-meta">
                  <span className="_memory-workbench-task-card-time">
                    {t('task.createdAt', {
                      time: new Date(task.created_at_ms).toLocaleString(),
                    })}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/*
        Pagination: shown whenever there is data (the page-size dropdown is always present - if shown only with multiple pages,
        users would lose the page-size control when the total fits on one page).
        Page size cap 96 < the kernel meta list limit max of 100.
      */}
      {tasksTotal > 0 && (
        <div className="_memory-workbench-pagination">
          <Pagination
            pageIndex={safePage}
            pageSize={pageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            recordCount={tasksTotal}
            onPagingChange={({ pageIndex, pageSize: nextSize }) => {
              // When the page size changes the component already resets the page to 1 (isPagingReset defaults to true); send both values together
              if (nextSize && nextSize !== pageSize) setPageSize(nextSize);
              if (pageIndex) setCurrentPage(pageIndex);
            }}
          />
        </div>
      )}

      {/* Detail drawer: settings (status / edit / delete) are all done inside the drawer */}
      <Drawer
        visible={!!selected}
        size="l"
        onClose={() => onSelect(null)}
        title={selected?.title}
        // To the right of the title is de-emphasized metadata (task_id / team) with field-name labels;
        // otherwise the id would follow the task title directly and read as part of the task name.
        subtitle={
          selected && (
            <span className="_memory-workbench-drawer-subtitle">
              <span>
                <span className="_memory-mono">{selected.task_id}</span>
              </span>
            </span>
          )
        }
        destroyOnClose
      >
        {selected && (
          <TaskDetail
            task={selected}
            onUpdateStatus={(s) => onUpdateStatus(selected, s)}
            onUpdateTask={(patch) => onUpdateTask(selected, patch)}
            onDelete={() => onDelete(selected)}
            canDelete={canDeleteTask(selected, selectedTeam, currentUser)}
            agents={agents}
            team={selectedTeam}
            currentUser={currentUser}
            participation={participationOf(participationByTask, selected.task_id)}
          />
        )}
      </Drawer>
    </div>
  );
}
