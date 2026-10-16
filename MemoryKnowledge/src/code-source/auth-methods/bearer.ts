/**
 * bearer — PAT / token-style authentication.
 *
 * The user fills in only an "access token" field; the basic-auth username is dictated by each platform's protocol
 * and declared by the provider via `cloneUsername` (the concrete value is not fixed in this doc).
 *
 * URL shape: `https://<cloneUsername>:<secret>@host/repo.git`
 */

import { injectBasicAuth } from "../clone-url.js";
import type { AuthMethod } from "./types.js";

export const bearerAuthMethod: AuthMethod = {
  kind: "bearer",

  formFields: [
    { name: "secret", secret: true, required: true },
  ],

  buildCredential(form) {
    if (!form.secret) throw new Error("token is required");
    return { secret: form.secret };
  },

  buildCloneUrl(repoUrl, cred, cloneUsername) {
    if (!cloneUsername) {
      throw new Error("bearer auth requires provider.cloneUsername (e.g. 'private' / 'x-access-token')");
    }
    return injectBasicAuth(repoUrl, { user: cloneUsername, pass: cred.secret });
  },
};
