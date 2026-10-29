/**
 * mem:help — 返回支持的命令列表及示例
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";

const HELP_TEXT = `## Supported mem: commands

| Command | Description |
|---------|-------------|
| \`mem:session-reset\` | Reset this session's Team/Agent/Task binding and immediately show the selection form again |
| \`mem:sync\` | Refresh all asset injection for this session (Skill / Memory / Knowledge / Task & Agent descriptions) |
| \`mem:create-skill [prompt]\` | Archive this conversation as a Skill, extracted asynchronously in the background |
| \`mem:create-task [title]\` | Create a Task from the current session context and bind it to this session |
| \`mem:update-task [new description]\` | Update the description of the bound Task |
| \`mem:config-lock\` | Save this session's Team/Agent/Task as your **account-level default**, so new Sessions skip the selection (before it overwrites an older default it shows what will be saved and needs \`confirm\`) |
| \`mem:config-unlock\` | Clear the account-level default; the next new Session goes back to manual selection (**does not affect this conversation**) |
| \`mem:help\` | Show this help |

---

### 🆕 \`mem:create-task\` — Create and bind a Task

**Usage**
- **No argument**: the LLM infers title + description from the recent conversation
- **With argument**: the argument is used as the title (truncated to 40 characters); the LLM only generates the description

**If this session is already bound to a real Task**, a preview of the new Task is returned; reply with one of:

| Reply | Effect |
|-------|--------|
| \`mem:create-task confirm\` | ✅ Overwrite the binding and create the new Task |
| \`mem:update-task\` or \`mem:update-task <new description>\` | ⭐ **Recommended** — keep using the current Task and only update its description |
| \`mem:create-task cancel\` | 🚫 Cancel, no changes made |

---

### ✏️ \`mem:update-task\` — Update the current Task's description

**Usage**
- **No argument**: the LLM compares "current description + recent conversation" and generates a new description
  - No substantive change → returns ℹ️ nothing to update (idempotent, safe to retry)
  - Changes found → returns a preview
- **With argument**: the argument is used directly as the new description (no LLM call), and a preview is returned

**Confirm the preview**:
- ✅ \`mem:update-task confirm\` — confirm
- 🚫 \`mem:update-task cancel\` — cancel

**Protection rules**:
- If this session has no bound Task → blocked, with a hint to run \`mem:create-task\` first
- If the bound Task was not created by you → update refused (editing other users' Tasks is not supported); run \`mem:create-task\` to create one of your own

---

### 🔒 \`mem:config-lock\` — Save the account-level default (Team/Agent/Task)

**Usage**
- \`mem:config-lock\` — save this session's Team/Agent/Task as your account default.
- **When it would overwrite a different older default, it first shows what will be saved and waits for your confirmation** (to avoid overwriting by mistake):
  1. \`mem:config-lock\` → shows "config to save + old config that will be overwritten"
  2. \`mem:config-lock confirm\` → confirm and save
  3. \`mem:config-lock cancel\` → cancel, nothing is changed
- When there is **no** older default, or it is identical to this one, it saves in one step without asking again.
- A confirmation is valid for 5 minutes; after that, run \`mem:config-lock\` again.

**Scope**
- After saving, **all new Sessions** skip the "link team assets? / Team / Agent / Task" selection.
- Sessions that have already started are not affected.
- Yourself only: even an admin can only save their own default, not set one for a member.
- An existing default is **overwritten directly** (that is the intended meaning of this command).
- If you saved the wrong one: run \`mem:config-unlock\` to remove it, or run this command again to overwrite it.

**Prerequisites**
- This session has completed Team/Agent selection (initialized); otherwise the command asks you to pick a Team/Agent first.
- A Task set to "skip for now" can also be saved (stored as the virtual \`default\`, meaning no Task is bound).

---

### 🔓 \`mem:config-unlock\` — Clear the account-level default

**Usage**
- \`mem:config-unlock\` → clears it directly (idempotent; fine if there is no default).
- **Does not affect this conversation** — the current Agent identity stays the same.

**Scope**
- The next new Session goes back to the header preset → manual form fallback chain.
- To change to a different default: \`mem:config-unlock\` → start a new session and pick Team/Agent/Task again → \`mem:config-lock\`.
- You can also edit it directly in the panel under "Agents · My Session default".

---

### Examples

\`\`\`
mem:sync
mem:create-skill focus on the database migration steps and pitfalls
mem:create-task Refactor SessionRegistrar
mem:create-task confirm
mem:create-task cancel
mem:update-task add today's progress and remaining risks
mem:update-task confirm
mem:update-task cancel
mem:session-reset
mem:config-lock
mem:config-lock confirm
mem:config-lock cancel
mem:config-unlock
mem:help
\`\`\`

> The standard format is \`mem:<command>\`, with no space after the colon. Command names are case-insensitive.`;

export function getHelpText(): string {
  return HELP_TEXT;
}

export async function executeHelp(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const response = buildMemResponse(HELP_TEXT, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });
  return {
    success: true,
    messageText: HELP_TEXT,
    response,
  };
}
