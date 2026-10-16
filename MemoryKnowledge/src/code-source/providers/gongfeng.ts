/**
 * Gongfeng (internal Git platform) provider.
 *
 * The site address is always provided by the deployment config `CODE_SOURCE_GONGFENG_SITE_BASE_URL`;
 * **do not write concrete domains in code/comments**.
 *
 * Auth: bearer (PAT) + URL basic-auth; see cloneUsername below for the placeholder username.
 */

import type { ICodeSourceProvider } from "../types.js";
import { bearerAuthMethod } from "../auth-methods/bearer.js";

export const gongfengProvider: ICodeSourceProvider = {
  id: "gongfeng",
  authMethod: bearerAuthMethod,
  cloneUsername: "private",
  sitePaths: {
    tokenDoc: "profile/account", // appended to site root → https://<host>/profile/account
  },
};
