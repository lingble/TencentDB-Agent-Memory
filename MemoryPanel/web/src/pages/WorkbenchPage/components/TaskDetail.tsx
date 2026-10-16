/**
 * TaskDetail — workbench task details (edit title/description, switch status, view participants, delete).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Segment, Text } from 'tea-component';
import { ChevronRightIcon, DeleteIcon, EditIcon, UserIcon, UsergroupIcon } from 'tea-icons-react';
import { canEditTask, type Task, type Team } from '@/services';
import { useUserDisplayName } from '@/services/user-profile-store';
import { tea } from '@/lib/tea-bridge';
import {
  readExternalProvider,
  useSourceLabel,
  useStatusLabels,
  visibleAgentIds,
  type AgentOption,
  type TaskParticipationView,
} from '../utils/workbench-utils';

/**
 * Normalize source_url into an absolute URL that is safe to navigate to.
 *
 * **A protocol allowlist is mandatory**: source_url is external data pulled from a third-party system (TAPD),
 * and putting it straight into `<a href>` would make pseudo-protocols like `javascript:` / `data:` an XSS entry point.
 * Only http / https are allowed; parse failures or non-allowlisted values all return null (no link rendered).
 */
function safeExternalUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    // Relative path or invalid string: don't guess the protocol, just don't navigate.
    return null;
  }
}

/**
 * Participant chip: visible text shows display_name (falls back to id on cache miss),
 * title keeps a semantic tooltip + user_id for troubleshooting.
 * Extracted as a subcomponent per the Rules of Hooks (can't call useUserDisplayName in a loop inside .map).
 */
function UserChip({
  userId,
  currentUser,
  tooltip,
}: {
  userId: string;
  currentUser: string;
  tooltip: string;
}) {
  const { t } = useTranslation();
  const name = useUserDisplayName(userId);
  return (
    <span className="_memory-workbench-chip" title={`${tooltip} · ${userId}`}>
      <UserIcon size={12} />
      <Text theme="text">{name || userId}</Text>
      {userId === currentUser && <span className="_memory-workbench-chip-you">{t('common.you.short')}</span>}
    </span>
  );
}

export default function TaskDetail({
  task,
  onUpdateStatus,
  onUpdateTask,
  onDelete,
  canDelete,
  agents,
  team,
  currentUser,
  participation,
}: {
  task: Task;
  onUpdateStatus: (s: Task['status']) => void;
  onUpdateTask: (patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>>) => void;
  /** Delete the current task (permission checks and confirmation are handled by the outer layer) */
  onDelete: () => void;
  canDelete: boolean;
  agents: AgentOption[];
  /** Team of the current task; may be null (shouldn't happen in theory, but needs a fallback for deleted teams) */
  team: Team | null;
  currentUser: string;
  /** Observation data for the current task, bucketed by useTeamParticipation and passed down */
  participation: TaskParticipationView;
}) {
  const { t } = useTranslation();
  const statusLabels = useStatusLabels();
  const sourceLabelOf = useSourceLabel();
  // Edit permission: any member in the team can modify a task (including switching status).
  const canEdit = canEditTask(task, team, currentUser);

  /** Source system detail page URL (passed the protocol allowlist); null when invalid/missing, so no navigate button is rendered. */
  const externalUrl = safeExternalUrl(task.source_url);
  /**
   * Source display name: the concrete source is read from metadata_json.external.provider (source_type only indicates the broad category).
   * Unregistered sources fall back to the raw provider string, to avoid an empty source row.
   */
  const sourceProvider = readExternalProvider(task);
  const sourceLabel = sourceProvider ? sourceLabelOf(sourceProvider) : task.source_type;

  // —— Edit state: entered only after the user clicks "Edit"; the draft is kept separately and discarded on cancel —— //
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [draftDesc, setDraftDesc] = useState(task.description);

  // Sync the draft when switching tasks / exiting edit (avoids the draft staying on A after editing A and switching to B)
  useEffect(() => {
    setEditing(false);
    setDraftTitle(task.title);
    setDraftDesc(task.description);
  }, [task.task_id]);


  function startEdit() {
    setDraftTitle(task.title);
    setDraftDesc(task.description);
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
  }
  function saveEdit() {
    const patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>> = {};
    const title = draftTitle.trim();
    if (title.length === 0) {
      tea.notify.warning(t('task.titleRequired'));
      return;
    }
    if (title !== task.title) patch.title = title;
    if (draftDesc !== task.description) patch.description = draftDesc;

    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    onUpdateTask(patch);
    setEditing(false);
  }

  // Participant display: creator is shown separately; everyone else goes into "Participating Users".
  // The data source is uniformly participation-log observations, appended when proxy session init completes:
  // "users who actually started a session". A creator starting work with their own agent also counts as real participation,
  // so the creator is no longer filtered out (they may appear under both "Creator" and "Participating Users", with different meanings).
  const participantUsers = participation.users;

  // "Actually participating Agents": agents observed in sessions, mapped to the team's agent names;
  // those not in the team agents list (e.g. deleted) keep agent_id as a fallback display.
  // Filter out import sentinels (historical participation records) first; if empty afterward show "—", consistent with non-imported tasks.
  const sessionAgents = useMemo(() => {
    const nameById = new Map(agents.map((a) => [a.id, a.name]));
    return visibleAgentIds(participation.agentIds).map((id) => ({
      id,
      name: nameById.get(id) ?? id,
    }));
  }, [participation.agentIds, agents]);

  return (
    <div className="_memory-workbench-detail-content">
      {/* === Toolbar: edit + status switch (title / task_id / team are already shown in the drawer header) === */}
      <div className="_memory-workbench-detail-toolbar">
        {editing ? (
          <>
            <Input
              value={draftTitle}
              onChange={setDraftTitle}
              placeholder={t('task.titlePlaceholder')}
              size="full"
              className="_memory-workbench-title-input"
            />
            <Button onClick={cancelEdit}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={saveEdit}>{t('task.save')}</Button>
          </>
        ) : (
          <>
            {canEdit && (
              <Button type="text" onClick={startEdit} tooltip={t('task.edit.tooltip')}>
                <EditIcon size={14} />
                {t('task.edit')}
              </Button>
            )}
            {/*
              The navigate entry is **kept only** in the "Source" row of the participants section below, which has the source name and full URL
              tooltip and more information; another button here would be a duplicate entry to the same target and easy to misclick.
            */}
            <Segment
              value={task.status}
              onChange={(v) => onUpdateStatus(v as Task['status'])}
              disabled={!canEdit}
              options={(Object.keys(statusLabels) as Task['status'][]).map((s) => ({
                value: s,
                text: statusLabels[s],
              }))}
            />
          </>
        )}
      </div>

      {/* === Participants === */}
      <div className="_memory-workbench-people">
        {/* Source: only tasks created by import have one (source_type !== 'manual'); the whole row is hidden for manual tasks */}
        {task.source_type !== 'manual' && (
          <div className="_memory-workbench-people-row">
            <Text theme="weak" className="_memory-workbench-people-label">{t('task.source')}</Text>
            {externalUrl ? (
              <a
                href={externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={externalUrl}
                className="_memory-workbench-source-link"
              >
                {t('task.sourceLink', { source: sourceLabel })}
                <ChevronRightIcon size={12} />
              </a>
            ) : (
              <Text theme="weak">{sourceLabel}</Text>
            )}
          </div>
        )}
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.creator')}</Text>
          <UserChip
            userId={task.creator_user_id}
            currentUser={currentUser}
            tooltip={t('task.creator.tooltip')}
          />
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.participantUsers')}</Text>
          {participantUsers.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            participantUsers.map((u) => (
              <UserChip
                key={u}
                userId={u}
                currentUser={currentUser}
                tooltip={t('task.participantUsers.tooltip')}
              />
            ))
          )}
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.sessionAgents')}</Text>
          {sessionAgents.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            sessionAgents.map((a) => (
              <span
                key={a.id}
                className="_memory-workbench-chip"
                title={t('task.sessionAgents.tooltip', { id: a.id })}
              >
                <UsergroupIcon size={12} />
                <Text theme="text">{a.name}</Text>
              </span>
            ))
          )}
        </div>
      </div>

      {/* === Description === */}
      <div className="_memory-workbench-block">
        <Text theme="label" className="_memory-workbench-block-label">{t('task.description')}</Text>
        {editing ? (
          <Input.TextArea
            value={draftDesc}
            onChange={setDraftDesc}
            rows={6}
            size="full"
            placeholder={t('task.descriptionPlaceholder')}
          />
        ) : (
          <div className="_memory-workbench-desc-view">{task.description}</div>
        )}
      </div>

      <Text theme="weak" className="_memory-workbench-footer">
        {t('task.footer', { created: new Date(task.created_at_ms).toLocaleString(), updated: new Date(task.updated_at_ms).toLocaleString() })}
      </Text>

      {/* === Danger zone === */}
      {canDelete && (
        <div className="_memory-workbench-danger">
          <Button type="error" onClick={onDelete}>
            <DeleteIcon size={12} /> {t('task.delete.okText')}
          </Button>
        </div>
      )}
    </div>
  );
}
