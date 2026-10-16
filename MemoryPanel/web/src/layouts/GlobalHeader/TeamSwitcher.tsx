/**
 * TeamSwitcher - Team switcher embedded in the global top bar
 *
 * Inline pill-style version after moving from the sidebar to the top bar: uses Tea `Dropdown` to host the popup panel
 * (with built-in positioning, close on mask click, close on scroll, etc.), and assembles the panel with `List`/`Input`/`Button`.
 *
 * Team edit entry: the right side of the current active team row (visible to owner / admin) provides "Edit" and "Delete"
 * icon buttons, reusing EditTeamDialog + tea.confirm second confirmation. This moves the "Edit Team / Delete current Team"
 * entries from the TeamManagementPanel Header here, consolidated in one place.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dropdown, Input, Button } from 'tea-component';
import { ChevronDownIcon, AddIcon, EditIcon, DeleteIcon } from 'tea-icons-react';
import {
  useTeams,
  writeActiveTeamId,
  invalidateBackendCache,
  isTeamAdmin,
} from '@/services';
import { useBackendStore } from '@/stores/backend';
import { type TeamRole } from '@/services/useCurrentRole';
import { teamsApi } from '@/lib/teamApi';
import { getPanelSession } from '@/lib/panelSession';
import { teamColor } from '@/utils/color';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import EditTeamDialog from '@/components/team/EditTeamDialog';
import './team-switcher.css';

export function TeamSwitcher({ userRole }: { userRole: TeamRole | null }) {
  const { t } = useTranslation();
  const { teams, activeTeamId } = useTeams();
  const refreshTeams = useBackendStore((s) => s.refreshTeams);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamDesc, setNewTeamDesc] = useState('');
  const [creating, setCreating] = useState(false);
  // Edit dialog visibility
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);

  const myTeams = teams;
  const active = myTeams.find((tm) => tm.team_id === activeTeamId) ?? null;
  // Current user's user_id (synchronously readable from panelSession)
  const currentUserId = getPanelSession()?.user?.user_id ?? '';
  // Whether the current active team can be edited / deleted: global admin, or owner / admin of the current team
  const canManageActiveTeam =
    !!active && (userRole === 'admin' || isTeamAdmin(active, currentUserId));

  function resetCreateForm() {
    setShowCreateTeam(false);
    setNewTeamName('');
    setNewTeamDesc('');
  }

  function pick(team_id: string, close: () => void) {
    // Only switch activeTeamId, don't invalidateTeamCache:
    //  - useAgents/useTasks cache per teamId bucket; switching to a team that's already cached (viewed before)
    //    opens instantly without reloading; only uncached teams fetch - this is "auto refresh" rather than
    //    "full page reload".
    //  - invalidateTeamCache deletes the target team's cache + broadcasts BACKEND_REFRESH_EVENT,
    //    causing all pages (including unrelated data like counts/participation) to refetch after switching team,
    //    showing up as "one switch = refresh everything once". invalidateBackendCache after writes
    //    already guarantees data freshness, so the switch itself doesn't need a forced refresh.
    writeActiveTeamId(team_id);
    close();
  }

  async function handleCreate() {
    const name = newTeamName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await teamsApi.create({ name, description: newTeamDesc.trim() });
      invalidateBackendCache();
      writeActiveTeamId(created.team_id);
      resetCreateForm();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdateTeam(input: { name: string; description: string }) {
    const id = editingTeamId;
    if (!id) return;
    try {
      await teamsApi.update(id, input);
      invalidateBackendCache();
      setEditingTeamId(null);
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    }
  }

  async function handleDeleteTeam(teamId: string, teamName: string, memberCount: number) {
    // Fetch the agent count once (for cascade display) - via the store cache to avoid an extra request
    let agentCount = 0;
    try {
      const cached = useBackendStore.getState().agentsByTeam[teamId];
      if (cached) agentCount = cached.length;
    } catch {
      /* Silent: only used to display the cascade scope; failing to fetch it doesn't affect deletion */
    }
    const ok = await tea.confirm({
      message: t('teamSwitcher.delete.confirm', { name: teamName }),
      description: t('teamSwitcher.delete.desc', {
        members: memberCount,
        agents: agentCount,
      }),
      okText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await teamsApi.delete(teamId);
      // When deleting the current active team, clear activeTeamId so that ensureValidActiveTeamId
      // automatically lands on the first remaining team (or the empty state) after the store refreshes.
      if (teamId === activeTeamId) writeActiveTeamId(null);
      invalidateBackendCache();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    }
  }

  const editingTeam = editingTeamId ? myTeams.find((tm) => tm.team_id === editingTeamId) ?? null : null;

  return (
    <>
      <Dropdown
        appearance="pure"
        clickClose={false}
        matchButtonWidth={false}
        className="_memory-team-switcher-dropdown"
        boxClassName="_memory-team-switcher-box"
        // Silent refresh: only keeps the team list in the dropdown fresh, without flipping teamsLoading,
        // otherwise consumers like TeamManagementPanel would fall entirely into a loading placeholder (showing up as
        // "opening the team selector refreshes the Members/Agents management page").
        onOpen={() => { void refreshTeams({ silent: true }); }}
        onClose={resetCreateForm}
        button={
          <button
            type="button"
            className="_memory-team-switcher-trigger"
            title={active?.name ?? t('teamSwitcher.selectTeam')}
          >
            <span className={`_memory-team-switcher-avatar ${active ? teamColor(active.team_id) : 'bg-primary'}`}>
              {(active?.name ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="_memory-team-switcher-meta">
              <span className="_memory-team-switcher-name">{active?.name ?? t('teamSwitcher.selectTeam')}</span>
              <span className="_memory-team-switcher-id">{active?.team_id ?? t('teamSwitcher.noTeam')}</span>
            </span>
            <ChevronDownIcon size={12} className="_memory-team-switcher-chevron" />
          </button>
        }
      >
        {(close) => (
          <div className="_memory-team-switcher-panel">
            <div className="_memory-team-switcher-panel-header">
              <div className="_memory-team-switcher-panel-title">{t('teamSwitcher.title')}</div>
              <div className="_memory-team-switcher-panel-desc">
                {t('teamSwitcher.desc')}
              </div>
            </div>

            <div className="_memory-team-switcher-panel-label">{t('teamSwitcher.teamCount', { count: myTeams.length })}</div>

            <div className="_memory-team-switcher-list-wrap">
              {myTeams.length === 0 ? (
                <div className="_memory-team-switcher-empty">
                  {userRole === 'admin'
                    ? t('teamSwitcher.empty.admin')
                    : t('teamSwitcher.empty.member')}
                </div>
              ) : (
                // Use native ul/li instead of Tea List: Tea's List.Item selected auto-renders a ✓
                // and changes padding, and split="divide" injects padding/border-top, repeatedly conflicting with the custom
                // card-style row styling (rounded + outline + spacing) (showing up as the selected row's left side clipped,
                // and the row divider overlapped by the previous row). Here we control all the styling ourselves, which is more predictable.
                <ul className="_memory-team-switcher-list">
                  {myTeams.map((tm) => {
                    const isActive = tm.team_id === activeTeamId;
                    // Only the current active team row shows edit/delete buttons, and only owner/admin can operate them
                    const showOps = isActive && canManageActiveTeam;
                    return (
                      <li key={tm.team_id} className="_memory-team-switcher-row">
                        <button
                          type="button"
                          className={`_memory-team-switcher-item${isActive ? ' is-active' : ''}`}
                          aria-current={isActive || undefined}
                          onClick={() => pick(tm.team_id, close)}
                        >
                          <span className={`_memory-team-switcher-item-avatar ${teamColor(tm.team_id)}`}>
                            {tm.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="_memory-team-switcher-item-meta">
                            <span className="_memory-team-switcher-item-name">{tm.name}</span>
                            <span className="_memory-team-switcher-item-count">
                              {t('teamSwitcher.memberCount', { count: tm.members.length })}
                            </span>
                          </span>
                          {/* Selected state is conveyed by background color + outline, no extra ✓ - avoids crowding with the
                              action buttons on the right. Action buttons are absolutely positioned overlays and take no inline layout width. */}
                        </button>
                        {showOps && (
                          <span className="_memory-team-switcher-item-ops">
                            <button
                              type="button"
                              className="_memory-team-switcher-item-op"
                              title={t('teamSwitcher.edit.tooltip')}
                              aria-label={t('teamSwitcher.edit.tooltip')}
                              onClick={() => setEditingTeamId(tm.team_id)}
                            >
                              <EditIcon size={14} />
                            </button>
                            <button
                              type="button"
                              className="_memory-team-switcher-item-op _memory-team-switcher-item-op-danger"
                              title={t('teamSwitcher.delete.tooltip')}
                              aria-label={t('teamSwitcher.delete.tooltip')}
                              onClick={() => {
                                void handleDeleteTeam(tm.team_id, tm.name, tm.members.length);
                              }}
                            >
                              <DeleteIcon size={14} />
                            </button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="_memory-team-switcher-footer">
              {userRole !== 'admin' ? null : showCreateTeam ? (
                <div className="_memory-team-switcher-create-form">
                  <Input
                    autoFocus
                    size="full"
                    value={newTeamName}
                    onChange={setNewTeamName}
                    placeholder={t('teamSwitcher.teamNamePlaceholder')}
                  />
                  <Input
                    size="full"
                    value={newTeamDesc}
                    onChange={setNewTeamDesc}
                    placeholder={t('teamSwitcher.teamDescPlaceholder')}
                  />
                  <div className="_memory-team-switcher-create-actions">
                    <Button onClick={resetCreateForm}>{t('teamSwitcher.cancel')}</Button>
                    <Button type="primary"
                      loading={creating}
                      disabled={!newTeamName.trim() || creating}
                      onClick={handleCreate}
                    >
                      {t('teamSwitcher.create')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button type="text"
                  className="_memory-team-switcher-create-trigger"
                  onClick={() => setShowCreateTeam(true)}
                >
                  <AddIcon size={14} />
                  {t('teamSwitcher.newTeam')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Dropdown>

      {/* The edit dialog is mounted outside the Dropdown: avoids Dropdown clickClose interfering with Modal visibility */}
      {editingTeam && (
        <EditTeamDialog
          team={editingTeam}
          onClose={() => setEditingTeamId(null)}
          onSave={handleUpdateTeam}
          busy={false}
        />
      )}
    </>
  );
}