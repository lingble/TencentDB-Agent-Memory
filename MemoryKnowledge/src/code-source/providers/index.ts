/**
 * Built-in provider registration entry point.
 *
 * The **only change points** when onboarding a new platform:
 *   1. Create `<id>.ts` in this directory, exporting `<id>Provider: ICodeSourceProvider`
 *   2. Add a line to the BUILTIN_PROVIDERS array below
 *
 * Whether a platform is enabled is decided by the deployment env `CODE_SOURCE_ENABLED`, decoupled from this table.
 *
 * Exception: `SSH_PROVIDER` is a protocol-level source (not a platform) and is **always enabled**,
 * so it is exported separately and not included in BUILTIN_PROVIDERS (otherwise CODE_SOURCE_ENABLED would filter it out).
 */

import type { ICodeSourceProvider } from "../types.js";
import { gongfengProvider } from "./gongfeng.js";
import { sshProvider, SSH_PROVIDER_ID } from "./ssh.js";

/** All built-in providers (filtered by CODE_SOURCE_ENABLED; not all are necessarily shown to users). */
export const BUILTIN_PROVIDERS: readonly ICodeSourceProvider[] = [
  gongfengProvider,
];

/** 恒启用的协议级来源（不受部署配置过滤）。 */
export const ALWAYS_ON_PROVIDERS: readonly ICodeSourceProvider[] = [
  sshProvider,
];

export { sshProvider, SSH_PROVIDER_ID };
