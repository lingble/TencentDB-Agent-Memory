/**
 * ForkSkillDialog — "copy a skill to an agent, with the copy editable by that agent".
 *
 * Difference from "authorization (asset visibility=team + acl/grant)":
 *   - Authorization → toggle sharing via the \"My asset assignment\" tab or acl/grant, without copying content; others
 *     get read/use permission on the same skill;
 *   - fork (this dialog) → fetch the source skill's SKILL.md, **keep the original name + set the target agent as owner**,
 *     and call skill-api.createSkill to store an independent copy, which the agent can then write.
 *
 * Naming convention: the copy **keeps the source skill's original name**, with no suffix. The skill uniqueness constraint is based on
 * (team_id, owner_agent_id, name): one team may have several copies with the same name (under different agents),
 * but if the target agent already has a skill with that name the backend rejects it (42201), so it's intercepted with a prompt here first.
 *
 * Implementation: three steps, "getSkill(source) → readSkillFile(attachments) → createSkill(new)".
 */

import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Select } from 'tea-component';
import { useTranslation } from 'react-i18next';
import '@/components/asset/allocate-dialog.css';

import {
  createSkill,
  getSkill,
  listSkills,
  readSkillFile,
  type SkillSummary,
  type SkillResourcePayload,
} from '@/lib/api/skill-api';

/**
 * Rewrite the name field in the SKILL.md frontmatter so the DB record name matches the file content.
 * Only replaces the `name:` line inside the first `--- ... ---` frontmatter block; returns the content unchanged if there's no frontmatter.
 */
function rewriteFrontmatterName(content: string, newName: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return content;
  const fmBody = fmMatch[1];
  if (!/^\s*name\s*:/m.test(fmBody)) return content; // No name field; don't force-insert one
  const newFmBody = fmBody.replace(/^(\s*name\s*:\s*).*/m, `$1${newName}`);
  return content.replace(fmBody, newFmBody);
}

export default function ForkSkillDialog(props: {
  /** Name of the source skill to fork */
  skillName: string;
  /** skill_id required by the v3 API */
  skillId: string;
  agents: Array<{ id: string; name: string }>;
  /** Current team ID (required by the v3 API) */
  teamId: string;
  /** Current user ID (required by the v3 API) */
  userId: string;
  onClose: () => void;
  onForked: (newSkill: SkillSummary) => void;
}) {
  const { t } = useTranslation();
  const [agentId, setAgentId] = useState(props.agents[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // The copy name defaults to the source skill's original name and is user-editable. Uniqueness is distinguished by owner_agent_id;
  // duplicate names aren't allowed under the same agent (backend 42201), and submit below intercepts this early.
  const [newName, setNewName] = useState(props.skillName);

  async function submit(): Promise<void> {
    if (!agentId) {
      setError(t('forkSkill.error.noAgent'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // Step 1: fetch the source skill details (including content + manifest).
      const full = await getSkill({
        skill_id: props.skillId,
        team_id: props.teamId,
        include_content: true,
        include_manifest: true,
      });

      // Step 2: defensive check - if the target agent already has a skill with the same name, intercept early to avoid backend 42201.
      const existing = await listSkills({
        team_id: props.teamId,
        filters: { owner_agent_id: agentId, status: ['active'] },
        pagination: { limit: 100 },
      });
      if (existing.items.some((s) => s.name === newName)) {
        throw new Error(
          t('forkSkill.error.duplicate', { agent: agentId, name: newName })
        );
      }

      // Step 3: copy attached resource files (readSkillFile one by one; skip individual failures without blocking the main flow).
      const resources: SkillResourcePayload[] = [];
      for (const entry of full.manifest ?? []) {
        try {
          const f = await readSkillFile({
            skill_id: props.skillId,
            team_id: props.teamId,
            path: entry.path,
          });
          resources.push({
            path: f.path,
            content: f.content,
            encoding: f.encoding,
            mime_type: f.mime_type || undefined,
            is_executable: entry.is_executable || undefined,
          });
        } catch {
          /* Skip a resource that fails to read, without blocking the main fork flow */
        }
      }

      // Step 4: create the skill with the (editable) copy name + target agent as owner (v3 API).
      // If the user renamed it, also rewrite the name field in the SKILL.md frontmatter to keep the DB and file consistent.
      const trimmedName = newName.trim();
      const finalContent = trimmedName !== props.skillName
        ? rewriteFrontmatterName(full.content, trimmedName)
        : full.content;
      const created = await createSkill({
        user_id: props.userId,
        team_id: props.teamId,
        agent_id: agentId,
        name: trimmedName,
        content: finalContent,
        resources: resources.length ? resources : undefined,
      });

      const resourceInfo = resources.length > 0
        ? t('forkSkill.success.withResources', { name: props.skillName, agent: agentId, count: resources.length })
        : (full.manifest?.length ?? 0) > 0
          ? t('forkSkill.success.allFailed', { name: props.skillName, agent: agentId, count: full.manifest?.length ?? 0 })
          : t('forkSkill.success.noResources', { name: props.skillName, agent: agentId });
      setSuccess(resourceInfo);
      setTimeout(() => props.onForked(created), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible caption={t('forkSkill.caption')} size="s" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Form>
          <Form.Item label={t('forkSkill.descLabel')}>
            <Form.Text>{t('forkSkill.desc', { name: props.skillName })}</Form.Text>
          </Form.Item>
          <Form.Item label={t('forkSkill.agent')} required>
            <Select
              size="full"
              matchButtonWidth
              value={agentId}
              onChange={setAgentId}
              placeholder={t('forkSkill.agent.placeholder')}
              options={props.agents.map((a) => ({ value: a.id, text: `${a.id} · ${a.name}` }))}
            />
          </Form.Item>
          <Form.Item label={t('forkSkill.copyName')} required>
            <Input
              size="full"
              value={newName}
              onChange={setNewName}
              placeholder={t('forkSkill.copyName.placeholder')}
            />
          </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
          {success && <Form.Item><Alert type="success">{success}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={submitting || !agentId || !newName.trim()} loading={submitting}>{t('forkSkill.submit')}</Button>
        <Button onClick={props.onClose} disabled={submitting}>{t('forkSkill.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
