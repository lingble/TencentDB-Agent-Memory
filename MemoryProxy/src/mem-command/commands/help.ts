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
