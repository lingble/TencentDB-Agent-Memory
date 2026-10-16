/**
 * OwnerLabel - shared "asset Owner display" component.
 *
 * Previously Wiki (WikiOwnerLabel) and Code (CodeOwnerLabel) each implemented identical
 * "@displayName + append a 'you' marker for the current user" logic (both relying on the global useUserDisplayName
 * cache + a child-component structure, since the Rules of Hooks forbid calling hooks in a loop inside .map).
 * Unified here; title / youText / youClassName are injected by the caller to fit each page's i18n and styles.
 */
import { useUserDisplayName } from '@/services/user-profile-store';

export function OwnerLabel({
  userId,
  currentUserId,
  title,
  youText,
  youClassName,
}: {
  userId: string;
  currentUserId: string;
  /** Hover tooltip text (the caller handles i18n; usually interpolates userId) */
  title: string;
  /** Text of the "you" marker (shown for the current user) */
  youText: string;
  /** Class of the "you" marker (each page can inject its own style class) */
  youClassName?: string;
}) {
  const name = useUserDisplayName(userId);
  return (
    <span title={title}>
      @{name || userId}
      {userId === currentUserId && (
        <span className={youClassName ?? '_owner-label-you'}>{youText}</span>
      )}
    </span>
  );
}
