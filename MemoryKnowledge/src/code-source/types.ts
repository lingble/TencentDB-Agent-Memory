/**
 * code-source — abstraction over external codegraph sources.
 *
 * Two orthogonal dimensions:
 *   - **Provider (code platform)** → `providers/<id>.ts`: platform constants + choice of one AuthMethod
 *   - **AuthMethod (authentication method)** → `auth-methods/<kind>.ts`: form / persistence / URL injection
 *
 * New platform: write a provider constant and pick an authMethod; the auth layer is untouched
 * New auth method: write an AuthMethod implementation; the platform layer is untouched
 */

import type { AuthMethod, AuthMethodKind } from "./auth-methods/types.js";

/** Source metadata for the frontend dropdown (sent by KS to Panel, includes form info). */
export interface CodeSourceMeta {
  id: string;
  /**
   * Auth method type; the frontend renders the credential form based on it.
   * `ssh-key` → form_fields is an empty array, so the frontend renders no input fields.
   */
  auth_method: AuthMethodKind;
  /** Form fields for this method (the frontend renders inputs dynamically from this). */
  form_fields: ReadonlyArray<{ name: string; secret: boolean; required: boolean }>;
  /** Token application guide (full URL, built from the deployment-configured site root + provider site path). */
  token_doc_url?: string;
}

/** Credential payload (internal data; never persisted, never leaves the process). */
export interface CredentialPayload {
  secret: string;
  username?: string;
}

/**
 * Platform provider contract.
 *
 * One platform file = one constant:
 *   - `id`: source id, matching the deployment `CODE_SOURCE_ENABLED` and i18n `code.source.<id>`
 *   - `authMethod`: pick one from `auth-methods/` (bearer / basic / future custom...)
 *   - `cloneUsername`: only used for bearer (placeholder username dictated by the platform protocol)
 *   - `sitePaths`: relative paths of on-site pages
 *
 * **Do not put auth logic in a provider** — that is the AuthMethod's responsibility.
 */
export interface ICodeSourceProvider {
  readonly id: string;
  readonly authMethod: AuthMethod;
  /** Placeholder basic-auth username for bearer; not needed for basic. */
  readonly cloneUsername?: string;
  readonly sitePaths: {
    /** Token / account application page. */
    tokenDoc?: string;
  };
  /** Optional: override the AuthMethod's default clone URL construction (rarely needed). */
  applyToCloneUrl?(repoUrl: string, cred: CredentialPayload): string;
  /** Optional: override the generic git error mapping. */
  explainCloneError?(rawStderr: string, needsCredential: boolean): string | null;
}
