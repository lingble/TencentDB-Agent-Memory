/**
 * workbench-utils - shared types, constants and pure utility functions for the workbench.
 * Split out of TaskWorkbench.tsx.
 */
import { useTranslation } from 'react-i18next';

export type WorkbenchTab = 'board' | 'logs';

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Read the **concrete source** id from a task's metadata_json.
 *
 * Corresponds to the backend `readExternalRef`: source_type only indicates the broad category (manual / external);
 * the concrete system is stored in `metadata_json.external.provider`.
 * Returns null if not found - callers then fall back to "don't show the source row".
 */
export function readExternalProvider(task: { metadata_json?: string }): string | null {
  if (!task.metadata_json) return null;
  try {
    const meta = JSON.parse(task.metadata_json) as {
      external?: { provider?: unknown };
    };
    const provider = meta.external?.provider;
    return typeof provider === 'string' && provider ? provider : null;
  } catch {
    // metadata_json is not JSON (dirty data / old format): treat as no source, don't throw.
    return null;
  }
}

/**
 * External source id → display name.
 *
 * By convention uses `task.source.<id>` without listing sources in code - adding a source only needs one
 * i18n entry, with no change to this function (writing `if (id === 'tapd')` here would require a code change per source).
 *
 * Unregistered sources fall back to the id itself, so nothing shows blank.
 */
export function useSourceLabel() {
  const { t } = useTranslation();
  return (sourceId: string): string =>
    t(`task.source.${sourceId}`, { defaultValue: sourceId });
}

// Task status is simplified to two states for the demo phase: in progress / completed.
// The historical pending / blocked / archived states are retired (see normalizeTaskStatus in backendStore.ts).
export function useStatusLabels() {
  const { t } = useTranslation();
  return {
    running: t('task.status.running'),
    completed: t('task.status.completed'),
  };
}

export interface AgentOption {
  id: string;
  name: string;
}

/**
 * Task-level aggregate view: bucket by task_id, then dedupe each bucket.
 *
 * Kernel append-only semantics: each session init for the same (user, agent, task) appends a row,
 * so the database table accumulates redundancy; the frontend dedupes client-side with a Set, so "running 10 sessions" and
 * "running 1" display the same.
 */
export interface TaskParticipationView {
  /** user_id list after dedupe */
  users: string[];
  /** agent_id list after dedupe */
  agentIds: string[];
}

export const EMPTY_VIEW: TaskParticipationView = { users: [], agentIds: [] };

/**
 * Sentinel ids of "non-real agents" to hide.
 *
 * Participation records produced by imports use the sentinel `external-import` as agent_id (corresponding to the fake agent
 * named "External task import" in meta_agents) - because participation_log requires agent_id,
 * while the import scenario has no real agent doing the work.
 *
 * This sentinel is a **bookkeeping placeholder**, not a real participating agent, so the display layer filters it out everywhere:
 *   - "Participating Agents" → empty list → falls back to the existing "—", consistent with non-imported tasks;
 *   - Board cards → likewise don't render that chip.
 *
 * Note this only affects the **agentIds** bucket; the same record's `user_id` (the assignee in the source system) still
 * goes into the `users` bucket and shows normally under "Participating Users" - the two buckets don't interfere.
 *
 * `tapd-import` is the **old value before the rename**, already written to the DB historically; it's filtered too so old data
 * doesn't expose "External task import" (display filtering only, **no data deletion**: participation records are observability data).
 */
const HIDDEN_AGENT_IDS = new Set(['external-import', 'tapd-import']);

export function isHiddenAgentId(agentId: string): boolean {
  return HIDDEN_AGENT_IDS.has(agentId);
}

/** Real agent_id list with sentinels filtered out. */
export function visibleAgentIds(agentIds: readonly string[]): string[] {
  return agentIds.filter((id) => !isHiddenAgentId(id));
}

export function participationOf(
  byTask: Map<string, TaskParticipationView>,
  taskId: string,
): TaskParticipationView {
  return byTask.get(taskId) ?? EMPTY_VIEW;
}
