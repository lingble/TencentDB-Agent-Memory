/**
 * UserBadge — generic "user badge" component.
 *
 * Previously Skills (SkillOwnerTag) and Memory (UploaderBadge) each implemented the same
 * "AssetBadge + UserIcon + displayName + append a 'you' marker for the current user" structure.
 * This consolidates them; displayName is fetched from the global useUserDisplayName cache, and title /
 * youText / getTitle are injected by the caller for compatibility with each page's i18n.
 */
import { UserIcon } from 'tea-icons-react';
import { useUserDisplayName } from '@/services/user-profile-store';
import { AssetBadge, AssetBadgeYou } from './AssetListPanel';

export function UserBadge({
  userId,
  isCurrentUser,
  title,
  youText,
  getTitle,
}: {
  userId: string;
  /** Whether this is the current user (decides whether to append the "you" marker) */
  isCurrentUser: boolean;
  /** Hover tooltip text; defaults to userId. To build it from displayName (e.g. skills), use getTitle */
  title?: string;
  /** Text for the "you" marker */
  youText: string;
  /** Callback that builds the hover tooltip from displayName (takes precedence over title) */
  getTitle?: (displayName: string) => string;
}) {
  const displayName = useUserDisplayName(userId);
  const resolvedTitle = getTitle
    ? getTitle(displayName || userId)
    : (title ?? userId);
  return (
    <AssetBadge icon={<UserIcon size={10} />} title={resolvedTitle}>
      {displayName || userId}
      {isCurrentUser && <AssetBadgeYou>{youText}</AssetBadgeYou>}
    </AssetBadge>
  );
}
