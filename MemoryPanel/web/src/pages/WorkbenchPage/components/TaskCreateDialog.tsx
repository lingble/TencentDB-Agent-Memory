/**
 * TaskCreateDialog — "New Task" dialog.
 *
 * Required fields (validated on the frontend):
 *   - title         task title
 *   - description   task description
 *
 * About team ownership:
 *   Users no longer pick a team in the dialog. The team is determined by the global TeamSwitcher in the top-right,
 *   and this only shows readonly "will be created in team: name (team_id)", avoiding the inconsistent-context problem of "top-right says A
 *   but the dialog defaulted to B, the user didn't notice, and everything went off track".
 *
 * Agents are no longer picked at creation time - associating an Agent happens after the task is created.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Tag, Input, Button, Form, Modal } from 'tea-component';
import '../styles/task-create-dialog.css';

/** Source **category** (always manual for new tasks); the specific system for imported sources is read from metadata_json.external.provider. */
export type TaskSourceType = 'manual' | 'external' | 'other';

export interface TaskDraft {
  team_id: string;
  title: string;
  description: string;
  source_type: TaskSourceType;
  source_url: string;
  linked_agents: string[];
}

export default function TaskCreateDialog(props: {
  team: { team_id: string; name: string };
  onClose: () => void;
  onCreate: (draft: TaskDraft) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim().length > 0 && description.trim().length > 0;

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await props.onCreate({
        team_id: props.team.team_id,
        title: title.trim(),
        description: description.trim(),
        source_type: 'manual',
        source_url: '',
        linked_agents: [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal visible caption={t('taskCreate.caption')} size="m" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Form>
          <Form.Item label={t('taskCreate.team')}>
            <div className="_memory-tcd-team-row">
              <span className="_memory-tcd-team-avatar">{props.team.name.slice(0, 1).toUpperCase()}</span>
              <div className="_memory-tcd-team-meta">
                <div className="_memory-tcd-team-label">{t('taskCreate.teamLabel')}</div>
                <div className="_memory-tcd-team-name-row">
                  <span className="_memory-tcd-team-name">{props.team.name}</span>
                  <Tag size="sm">{props.team.team_id}</Tag>
                </div>
              </div>
            </div>
          </Form.Item>
          <Form.Item label={t('taskCreate.title')} required>
            <Input
              autoFocus
              size="full"
              value={title}
              onChange={setTitle}
              placeholder={t('taskCreate.titlePlaceholder')}
            />
          </Form.Item>
          <Form.Item label={t('taskCreate.description')} required extra={t('taskCreate.descriptionExtra')}>
            <Input.TextArea
              size="full"
              value={description}
              onChange={setDescription}
              rows={4}
              placeholder={t('taskCreate.descriptionPlaceholder')}
            />
          </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={!canSubmit} loading={submitting}>{t('taskCreate.submit')}</Button>
        <Button onClick={props.onClose} disabled={submitting}>{t('taskCreate.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
