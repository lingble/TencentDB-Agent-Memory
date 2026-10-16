/**
 * Built-in provider registration entry point (symmetric with code-source/providers/index.ts).
 *
 * The **only change points** when onboarding a new platform:
 *   1. Create `<id>/index.ts` in this directory, exporting `<id>Provider: WikiSourceProvider`
 *   2. Add a line to the BUILTIN_PROVIDERS array below
 *
 * Whether a platform is enabled is decided by the deployment env `WIKI_SOURCE_ENABLED`, decoupled from this table.
 * Hence the registry **does not import any specific provider**.
 */

import type { WikiSourceProvider } from "../types.js";
import { iwikiProvider } from "./iwiki/index.js";

/** All built-in providers (filtered by WIKI_SOURCE_ENABLED; not all are necessarily shown to users). */
export const BUILTIN_PROVIDERS: readonly WikiSourceProvider[] = [iwikiProvider];
