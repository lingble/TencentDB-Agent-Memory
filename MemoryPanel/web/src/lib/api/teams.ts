/**
 * api/teams.ts - Team + TeamMember (meta/team/* + meta/team-member/*).
 */
import { metaPost, metaListAll, getCurrentUser } from './base';
import type { Team, TeamMember } from './types';

export const teamsApi = {
  /**
   * List teams where the current user is an active member.
   * meta/team/list requires user_id or user_key in the body; identity in the header alone isn't enough.
   * Admins also pass their own user_id (the backend has no user/list-style "list all teams at instance level" yet).
   */
  list: async () => {
    const me = await getCurrentUser();
    return metaListAll<Team>('team/list', { user_id: me.user_id });
  },

  /** Team details */
  get: (teamId: string) => metaPost<Team>('team/get', { team_id: teamId }),

  /** Create a team */
  create: async (data: { name: string; description?: string }) => {
    const me = await getCurrentUser();
    return metaPost<Team>('team/create', {
      name: data.name,
      description: data.description,
      owner_user_id: me.user_id,
    });
  },

  /** Update a team */
  update: (teamId: string, data: { name?: string; description?: string }) =>
    metaPost<Team>('team/update', { team_id: teamId, ...data }),

  /**
   * Delete a team (meta team/delete).
   * Note: the backend schema requires a `team_ids` array (can delete several at once); passing a singular `team_id`
   * gets silently stripped by zod and then fails validation for missing `team_ids` → 400. Deletion cascades,
   * also deleting the team's members, agents, tasks and all assets.
   */
  delete: (teamId: string) => metaPost<{ ok: boolean }>('team/delete', { team_ids: [teamId] }),
};

export const membersApi = {
  /** List team members */
  list: (teamId: string) => metaListAll<TeamMember>('team-member/list', { team_id: teamId }),

  /**
   * Add a member (join the team by a known user_id).
   *
   * "Creating an account" (getting a user_key) and "joining a team" are two independent things: after the user
   * logs in with their own user_key they get their user_id from auth/verify; the team admin only needs to
   * know that user_id to call team-member/add (a standard meta action).
   * There is no equivalent "create account by username" capability - to look up a user_id by username, use `usersApi.list`
   * with `{ username }` for an exact match.
   */
  add: (teamId: string, data: { user_id: string; role: 'admin' | 'member' | 'reviewer' }) =>
    metaPost<TeamMember>('team-member/add', { team_id: teamId, user_id: data.user_id, role: data.role }),

  /** Remove a member */
  remove: async (teamId: string, userId: string) => {
    await metaPost<{ ok: boolean }>('team-member/remove', { team_id: teamId, user_id: userId });
  },
};
