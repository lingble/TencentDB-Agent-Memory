/**
 * account-store.ts — local account table for the demo stage (local localStorage).
 *
 * Extracted from the original demoStore.ts.
 *
 * A local email -> { username, password, isAdmin } account system used by the legacy
 * username/password login. Path A (the new Control panel) has switched to user_key auth,
 * so this account system is kept only for backward compatibility (the requireAccount check in `addTeamMember`
 * still uses findAccountByUsername).
 *
 * Once the backend is live, replace it with a real user-center API.
 */

import i18n from '@/i18n';

const ACCOUNTS_KEY = 'tdai-memory.accounts.v1';

/**
 * Generate a 12-character random password, used as a fallback when creating mock accounts (when the user doesn't provide one).
 * For demo purposes only, it carries no real credentials, but avoids hardcoding the weak `123123` password into the bundle.
 */
function genRandomPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

export interface MockAccount {
  email: string;
  username: string;
  password: string;
  isAdmin: boolean;
  description?: string;
}

function getDefaultAccounts(): MockAccount[] {
  // Empty seed: no longer hardcode any real usernames/passwords.
  // Historically this listed 6 internal employees' English names + the weak password `123123` (bundled into the frontend JS;
  // customers could open devtools on the image and see them -> employee identity leak). The previous remote version changed them
  // to generic fake names like alice/bob but kept `123123`; this version empties it entirely; users create their own as needed.
  // Path A has switched to user_key auth; this mock only serves findAccountByUsername in `addTeamMember`.
  return [];
}

function writeAccountsRaw(accounts: MockAccount[]): void {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    /* ignore */
  }
}

function readAccounts(): MockAccount[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) {
      // First use: write the hardcoded seed accounts into localStorage
      const seeds = getDefaultAccounts();
      writeAccountsRaw(seeds);
      return seeds;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const seeds = getDefaultAccounts();
      writeAccountsRaw(seeds);
      return seeds;
    }
    return parsed.filter(
      (a): a is MockAccount => a && typeof a.email === 'string' && typeof a.username === 'string' && typeof a.password === 'string'
    );
  } catch {
    const seeds = getDefaultAccounts();
    writeAccountsRaw(seeds);
    return seeds;
  }
}

/** Look up an account by email (case-insensitive) */
export function findAccountByEmail(email: string): MockAccount | null {
  const e = email.trim().toLowerCase();
  return readAccounts().find((a) => a.email.toLowerCase() === e) ?? null;
}

/** Look up an account by username */
export function findAccountByUsername(username: string): MockAccount | null {
  return readAccounts().find((a) => a.username === username) ?? null;
}

/** Validate email + password login */
export function verifyAccountCredentials(email: string, password: string): MockAccount {
  const e = email.trim().toLowerCase();
  if (!e) throw new Error(i18n.t('account.error.emailRequired'));
  if (!password) throw new Error(i18n.t('account.error.passwordRequired'));
  const account = readAccounts().find((a) => a.email.toLowerCase() === e);
  if (!account) throw new Error(i18n.t('account.error.accountNotFound', { email: e }));
  if (account.password !== password) throw new Error(i18n.t('account.error.passwordIncorrect'));
  return account;
}

/** Create a single account (admin-only; permission check is in the UI layer).
 *  Usernames may repeat; emails are globally unique. */
export function createAccount(input: { email: string; username: string; password?: string; isAdmin?: boolean; description?: string }): MockAccount {
  const e = input.email.trim().toLowerCase();
  if (!e) throw new Error(i18n.t('account.error.emailEmpty'));
  if (!input.username.trim()) throw new Error(i18n.t('account.error.usernameEmpty'));
  const accounts = readAccounts();
  if (accounts.some((a) => a.email.toLowerCase() === e)) {
    throw new Error(i18n.t('account.error.emailExists', { email: input.email }));
  }
  const account: MockAccount = {
    email: input.email.trim(),
    username: input.username.trim(),
    // Fallback random password, avoiding a hardcoded weak password; can be removed once a real user center is in place
    password: input.password || genRandomPassword(),
    isAdmin: input.isAdmin ?? false,
    description: input.description?.trim() || undefined,
  };
  writeAccountsRaw([...accounts, account]);
  return account;
}

/** Create accounts in bulk */
export function batchCreateAccounts(
  entries: Array<{ email: string; username: string; description?: string }>
): { created: MockAccount[]; errors: Array<{ email: string; error: string }> } {
  const created: MockAccount[] = [];
  const errors: Array<{ email: string; error: string }> = [];
  const accounts = readAccounts();
  const emailSet = new Set(accounts.map((a) => a.email.toLowerCase()));

  for (const entry of entries) {
    const e = entry.email.trim().toLowerCase();
    const u = entry.username.trim();
    if (!e || !u) {
      errors.push({ email: entry.email || i18n.t('account.error.emptyPlaceholder'), error: i18n.t('account.error.emailAndUsernameEmpty') });
      continue;
    }
    if (emailSet.has(e)) {
      errors.push({ email: entry.email, error: i18n.t('account.error.emailRegistered') });
      continue;
    }
    const account: MockAccount = {
      email: entry.email.trim(),
      username: u,
      password: genRandomPassword(),
      isAdmin: false,
      description: entry.description?.trim() || undefined,
    };
    emailSet.add(e);
    accounts.push(account);
    created.push(account);
  }

  if (created.length > 0) {
    writeAccountsRaw(accounts);
  }
  return { created, errors };
}

/** Change password */
export function changePassword(username: string, oldPassword: string, newPassword: string): void {
  if (!oldPassword) throw new Error(i18n.t('account.error.currentPasswordRequired'));
  if (!newPassword) throw new Error(i18n.t('account.error.newPasswordRequired'));
  if (newPassword.length < 4) throw new Error(i18n.t('account.error.passwordTooShort'));
  const accounts = readAccounts();
  const account = accounts.find((a) => a.username === username);
  if (!account) throw new Error(i18n.t('account.error.accountNotFoundByUsername', { username }));
  if (account.password !== oldPassword) throw new Error(i18n.t('account.error.currentPasswordIncorrect'));
  account.password = newPassword;
  writeAccountsRaw(accounts);
}

/**
 * Admin directly sets any user's password (no old password needed).
 * Permission check is in the UI layer (admin only).
 */
export function setAccountPassword(username: string, newPassword: string): void {
  if (!newPassword) throw new Error(i18n.t('account.error.newPasswordRequired'));
  if (newPassword.length < 4) throw new Error(i18n.t('account.error.passwordTooShort'));
  if (!username) throw new Error(i18n.t('account.error.usernameEmpty'));
  const accounts = readAccounts();
  const account = accounts.find((a) => a.username === username);
  if (!account) throw new Error(i18n.t('account.error.accountNotFoundByUsername', { username }));
  account.password = newPassword;
  writeAccountsRaw(accounts);
}

/** Change a user's email (admin-only; permission check is in the UI layer) */
export function updateAccountEmail(username: string, newEmail: string): void {
  const e = newEmail.trim().toLowerCase();
  if (!e) throw new Error(i18n.t('account.error.emailEmpty'));
  if (!username) throw new Error(i18n.t('account.error.usernameEmpty'));
  const accounts = readAccounts();
  const account = accounts.find((a) => a.username === username);
  if (!account) throw new Error(i18n.t('account.error.accountNotFoundByUsername', { username }));
  // Check whether the email is already used by someone else
  const conflict = accounts.find((a) => a.email.toLowerCase() === e && a.username !== username);
  if (conflict) throw new Error(i18n.t('account.error.emailUsedByOther', { email: newEmail.trim() }));
  account.email = newEmail.trim();
  writeAccountsRaw(accounts);
}

/** Get the list of all accounts (admin sees all, regular users only see themselves) */
export function getAllAccounts(): MockAccount[] {
  return readAccounts();
}
