/**
 * AuthMethod — complete encapsulation of one authentication method.
 *
 * One AuthMethod = one kind + form metadata + URL injection + pre-persistence conversion.
 *
 * To add a new auth method (e.g. token-header, oauth-pkce):
 *   1. Create `auth-methods/<kind>.ts` exporting a constant that implements this interface
 *   2. Add a line to the AUTH_METHODS array in `auth-methods/index.ts`
 *   3. Select it in the provider via `authMethod: <kindConst>`
 *
 * That's it. The storage layer, credential API, injection entry point, and frontend form are all driven by this interface's fields;
 * no need to touch provider files, the registry, or write any switch.
 */

import type { CredentialPayload } from "../types.js";

/**
 * Auth method kind (discriminated union; adding a member forces compile errors at every kind reference in the repo).
 *
 * Note: `"ssh-key"` is **not** a `CredentialKind` (source-auth/types.ts).
 * SSH credentials are per-user private key files and do not go through the `knowledge_source_credential` table;
 * the business layer (CodeGraphService.create) skips the credential-persisting branch for the ssh provider,
 * so adding this member does not leak into the HTTP credential layer.
 */
export type AuthMethodKind = "bearer" | "basic" | "ssh-key";

/** Description of one field in the frontend credential form (the frontend builds the i18n key from name). */
export interface CredentialFormField {
  /** Field name, used as the payload key (consumed by `AuthMethod.buildCredential`). */
  name: "secret" | "username";
  /** Whether it is a password input (type=password). */
  secret: boolean;
  /** Whether it is required. */
  required: boolean;
}

/**
 * Auth method contract.
 *
 * Every decision for a method — what the form looks like, what shape the credential is stored in, how the clone URL is built —
 * lives here. Business code only calls these methods and never branches on kind.
 */
export interface AuthMethod {
  readonly kind: AuthMethodKind;

  /** Frontend credential form: field list (decides whether to show the username input). */
  readonly formFields: readonly CredentialFormField[];

  /**
   * Form values submitted by the frontend → credential shape before persistence.
   *
   * The method may validate on its own (e.g. "basic requires both username and password")
   * and throws if validation fails.
   *
   * Note: excludes registry-level info such as provider_id / kind; only handles the form values themselves.
   */
  buildCredential(form: Record<string, string | undefined>): {
    secret: string;
    username?: string;
  };

  /**
   * Inject the credential into the clone URL.
   *
   * `cloneUsername` is the placeholder username declared by the provider (differs per platform,
   * supplied by the provider; the concrete value is not fixed in this doc), used only by bearer;
   * basic ignores it and always uses cred.username.
   */
  buildCloneUrl(repoUrl: string, cred: CredentialPayload, cloneUsername?: string): string;
}
