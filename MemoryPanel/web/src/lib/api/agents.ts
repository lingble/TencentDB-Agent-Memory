/**
 * api/agents.ts - Agent management (meta/agent/* + meta/agent-fixed-asset/*).
 */
import { getPanelSession } from '../panelSession';
import { metaPost, metaListAll, getCurrentUser, request, ApiError } from './base';
import type { MetaEnvelope, Agent, AssetType, AssetStatus, FixedAssetBinding } from './types';

// ========================= Default Agent template =========================

export interface AgentTemplateAssetIds {
  /** Team skill ID (skl-xxx) */
  skills?: string[];
  /** Team code graph ID (code-xxx) */
  code_graphs?: string[];
  /** Team wiki ID (wiki-xxx) */
  wikis?: string[];
}

/**
 * Default Agent template config (the template structure of agent/get-default-template / set-default-template).
 * Notes:
 *   - asset_ids is a snapshot of team asset IDs; only public assets with visibility=team may be selected;
 *   - overwrite-style write: set must send back the complete template in one go;
 *   - metadata_json is a JSON string; ui.role_prompt / ui.rules_prompt store the split prompts.
 */
export interface AgentTemplateConfig {
  name: string;
  description?: string | null;
  prompt?: string | null;
  /** 'private' | 'team' (default) | 'restricted' */
  visibility?: string;
  metadata_json?: string;
  asset_ids?: AgentTemplateAssetIds;
}

export const agentsApi = {
  /**
   * List agents under a team.
   *
   * @param teamId team ID
   * @param params.owner_user_id Optional: only return agents owned by this user (the "agent private visibility" scenario,
   *   e.g. the Skill panel fixed-asset tab); if omitted, returns all agents in the team. `agent/list` supports
   *   combined `team_id + owner_user_id` filtering.
   */
  list: (teamId: string, params?: { owner_user_id?: string }) =>
    metaListAll<Agent>('agent/list', {
      team_id: teamId,
      status: 'active',
      owner_user_id: params?.owner_user_id,
    }),

  /** agent details */
  get: (agentId: string) => metaPost<Agent>('agent/get', { agent_id: agentId }),

  /** Create an agent */
  create: async (
    teamId: string,
    data: { name: string; description?: string; prompt?: string; visibility?: string }
  ) => {
    const me = await getCurrentUser();
    return metaPost<Agent>('agent/create', {
      team_id: teamId,
      owner_user_id: me.user_id,
      name: data.name,
      description: data.description,
      prompt: data.prompt,
      visibility: data.visibility ?? 'team',
    });
  },

  /**
   * Update an agent.
   *
   * `metadata_json` is a fallback channel for frontend-defined relations: display fields not yet in the backend schema
   * (UI-only fields such as icon / accent / associated user) can be serialized into a custom namespace here.
   */
  update: (
    agentId: string,
    data: {
      name?: string;
      description?: string;
      prompt?: string;
      visibility?: string;
      status?: string;
      metadata_json?: string;
    }
  ) => metaPost<Agent>('agent/update', { agent_id: agentId, ...data }),

  /**
   * Delete an agent: goes through the business route /api/v1/agent/delete-cascade.
   *
   * The route first runs skill/delete on all active skills with owner_agent_id = this agent,
   * and only calls meta/agent/archive after all succeed; if any skill deletion fails it aborts and the agent is not archived,
   * throwing SKILL_DELETE_FAILED for the caller to show to the user (the error data includes the already-deleted skill_ids
   * and the failed skill_id). On archive, the backend also cleans up the chat_memory asset.
   */
  delete: async (agentId: string) => {
    const session = getPanelSession();
    if (!session) {
      throw new ApiError(401, 'Unauthorized', 'no active panel session');
    }
    const envelope = await request<MetaEnvelope<{
      archived: boolean;
      agent_id: string;
      deleted_skill_count: number;
      deleted_skill_ids: string[];
    }>>('POST', '/api/v1/agent/delete-cascade', { agent_id: agentId }, {
      'X-Tdai-Service-Id': session.instanceId,
      'X-Tdai-User-Key': session.userKey,
    });
    if (envelope.code !== 0) {
      throw new ApiError(200, envelope.message, '', {
        code: envelope.code,
        requestId: envelope.request_id,
        rawMessage: envelope.message,
      });
    }
  },

  /** Get the agent's aggregated asset view (binding + asset details).
   *  Uses metaListAll to page through everything (list-with-detail defaults to limit 20, so many bound assets would be truncated).
   *
   *  applyVisibilityFilter: defaults to true (hides bindings that are now private, for normal display).
   *  Pass false when an owner manages their own assets - otherwise their own private skills
   *  are filtered out by the endpoint, so the fixed tab cannot get their visibility and the share/private toggle disappears. */
  getAssets: async (agentId: string, applyVisibilityFilter = true) => {
    const items = await metaListAll<{
      asset_id: string;
      asset_type: AssetType;
      name: string;
      description?: string;
      status: AssetStatus;
      visibility: string;
      injection_mode: FixedAssetBinding['injection_mode'];
      priority: number;
      created_at: string;
    }>('agent-fixed-asset/list-with-detail', {
      agent_id: agentId,
      apply_visibility_filter: applyVisibilityFilter,
      touch_usage: false,
    });
    return items.map((item) => ({
      asset_id: item.asset_id,
      asset_type: item.asset_type,
      name: item.name,
      description: item.description,
      status: item.status,
      visibility: item.visibility,
      injection_mode: item.injection_mode ?? 'direct',
      priority: item.priority,
      created_at: item.created_at,
    }));
  },

  /** Get the agent's fixed asset bindings (binding fields only) */
  getFixedAssets: async (agentId: string) => {
    const rows = await metaListAll<{
      asset_id: string;
      asset_type: AssetType;
      injection_mode?: FixedAssetBinding['injection_mode'];
      priority: number;
    }>('agent-fixed-asset/list', { agent_id: agentId });
    return rows.map((r) => ({
      asset_id: r.asset_id,
      asset_type: r.asset_type,
      injection_mode: r.injection_mode,
      priority: r.priority,
    }));
  },

  /** Set all fixed assets of an agent */
  setFixedAssets: async (agentId: string, bindings: FixedAssetBinding[]) => {
    const me = await getCurrentUser();
    await metaPost<{ ok: boolean }>('agent-fixed-asset/set', {
      agent_id: agentId,
      bindings: bindings.map((b) => ({
        asset_id: b.asset_id,
        asset_type: b.asset_type,
        injection_mode: b.injection_mode ?? 'direct',
        priority: b.priority ?? 0,
        created_by: me.user_id,
      })),
    });
  },

  /**
   * Read the current team's default Agent template (isolated per instance x team, no permission check).
   * When not configured the backend returns `{}`; callers check whether `data.name` exists to detect "not configured".
   */
  getDefaultTemplate: (teamId: string) =>
    metaPost<AgentTemplateConfig>('agent/get-default-template', { team_id: teamId }),

  /**
   * Configure/overwrite the current team's default Agent template (system_admin only, otherwise 403 permission_denied).
   * Overwrite-style write: the complete template must be sent back in one go.
   */
  setDefaultTemplate: (teamId: string, template: AgentTemplateConfig) =>
    metaPost<{ ok: boolean }>('agent/set-default-template', { team_id: teamId, template }),
};
