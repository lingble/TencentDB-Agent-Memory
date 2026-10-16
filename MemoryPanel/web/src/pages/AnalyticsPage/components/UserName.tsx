/**
 * UserName - unified display and fallback for "user_id -> username".
 *
 * Batch resolution via user/list (useUserNames) may fail for some ids (internal
 * accounts filtered by the proxy layer / deleted users, etc.); the old logic rendered the raw user_id as text, which looked like "missing
 * name". This is handled uniformly here:
 *   - Resolved -> render the username (tooltip shows the full user_id, to distinguish from short ids)
 *   - Not resolved -> render a muted "unknown user" placeholder + tooltip with the full user_id,
 *     so callers/users can get the id without displaying the id as a name.
 *
 * Usage: place inside the caller's existing container (plain text cell / link button both work);
 * this component handles ellipsis and tooltip itself and no longer relies on the outer container.
 */
import { useTranslation } from 'react-i18next';
import { Text } from 'tea-component';

export function UserName({
  userId,
  displayName,
}: {
  /** Raw user_id (for tooltip display / fallback checks). */
  userId: string;
  /** Display name resolved by useUserNames; falls back to user_id internally when resolution fails. */
  displayName: string;
}) {
  const { t } = useTranslation();
  const resolved = displayName !== userId;
  return (
    <Text overflow tooltip={userId} theme={resolved ? undefined : 'weak'}>
      {resolved ? displayName : t('analytics.member.unrecognized')}
    </Text>
  );
}
