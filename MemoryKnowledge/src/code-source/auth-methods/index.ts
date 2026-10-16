/**
 * Built-in auth methods — to add one, add a line here.
 */

import type { AuthMethod, AuthMethodKind } from "./types.js";
import { bearerAuthMethod } from "./bearer.js";
import { basicAuthMethod } from "./basic.js";
import { sshKeyAuthMethod } from "./ssh-key.js";

export const AUTH_METHODS: Readonly<Record<AuthMethodKind, AuthMethod>> = Object.freeze({
  bearer: bearerAuthMethod,
  basic: basicAuthMethod,
  "ssh-key": sshKeyAuthMethod,
});

/** Get the implementation by kind; not registered → undefined. */
export function getAuthMethod(kind: string): AuthMethod | undefined {
  return AUTH_METHODS[kind as AuthMethodKind];
}

export type { AuthMethod, AuthMethodKind, CredentialFormField } from "./types.js";
export { bearerAuthMethod, basicAuthMethod, sshKeyAuthMethod };
