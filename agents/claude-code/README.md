# Claude Code (CC)

> agentSource: `claude-code` | Protocol: Anthropic Messages API | Handler: `anthropicHandler.ts`
>
> To import local history into Memory Hub, see the [Asset Import Guide](./asset-import.md).

---

## 1. Client Configuration

### Option 1: Environment Variables

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="<business user's sk-mem-... user_key>"
claude --model <upstream model configured in PROXY_UPSTREAM_MODEL>
```

### Option 2: Config File `~/.claude/settings.json` (Recommended, Persistent)

Edit `~/.claude/settings.json` and add the following to the `env` field:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<business user's sk-mem-... user_key>",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default",
    "ANTHROPIC_MODEL": "claude-opus-4.7"
  }
}
```

After that, just run `claude`; CC loads environment variables from the `env` field of `settings.json` at startup.

### Fields

- `ANTHROPIC_BASE_URL`: points CC's API from anthropic.com to the proxy; `default` in the path is the memory instance ID (`x-tdai-service-id`), which is always `default` for local deployments
- `ANTHROPIC_AUTH_TOKEN`: the **business user's** user_key (from the panel's "API Key" page; using the admin key directly is not recommended)
- `ANTHROPIC_MODEL`: upstream model name (can also be set with the `--model` CLI flag)

The proxy runs, in order: `auth` (verify user_key) → `sessionInit` (team/agent/task selection form) → `injection` (inject L2/L3 memory, skills and knowledge into the system prompt) → forward to the upstream LLM.

Client requests hit `POST /claude-code/:spaceId/v1/messages`.

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-claude-code-session-id` |
| 2 | `x-session-id` |
| 3 | `x-conversation-id` |

CC automatically generates a session ID for each new session and sends it with requests; no manual configuration needed.

---

## 3. Session Init (Form)

### 3.1 Mechanism

CC uses **native Anthropic `tool_use`** to present an interactive form:

- Tool name: `AskUserQuestion`
- Block ID prefix: `toolu_cc_session_init_`
- Protocol: Anthropic SSE (`content_block_start` / `content_block_delta` / `content_block_stop` events)

### 3.2 State Machine

```
team_select → agent_select → task_select → initialized
```

4-step flow:
1. **team_select** — select a team
2. **agent_select** — select an Agent
3. **task_select** — select a Task (includes an isDefault virtual option for skipping)
4. **initialized** — inject assets and enter normal conversation

### 3.3 Pagination

CC's `AskUserQuestion` tool has a hard limit of **2~4 options** (an Anthropic protocol constraint).  
When there are more than 3 options, pagination is used:

- Each page shows 3 real options + 1 `"更多 →"` ("More →") page-turn option
- Choosing `"更多 →"` ("More →") returns the next page
- The last page has no page-turn option

### 3.4 Plan Mode / Default Mode

CC has **no** Default Mode gate concept. The CC client always supports tool_use, so the form can always be sent.

### 3.5 Skipping Session Init

At any step, the user can enter `"跳过"` ("Skip") / `"skip"`, or pick Other and type skip, to skip that step (matched by the `SKIP_RE` regex).  
After skipping, the proxy passes requests straight through without injecting assets.

---

## 4. Request Classification

CC distinguishes many request types:

| Type | Detection | Handling |
|------|----------|------|
| **main** | Default | Full pipeline (injection + archiving + telemetry) |
| **fork** | `cache_control` marker position analysis | Full pipeline (subagent shares the session_id) |
| **sidequery** | `cache_control` marker + specific pattern | Lightweight handling |
| **compact** | Path suffix `/compact` | Auxiliary request, injection skipped |
| **title-gen** | Path suffix + body characteristics | Auxiliary request, injection skipped |

CC's `cache_control` marker is the key signal for main vs auxiliary requests.

---

## 5. User Text Extraction

Extracted from the last `role: "user"` message in `body.messages`:
- Take the last `type: "text"` content block
- **Skip** blocks starting with `<system-reminder>` (these are system injections, not user text)

---

## 6. Injection Profile

System prompt injection uses a **Markdown structure**:

```markdown
## Skills
<available_skills>...</available_skills>

## Memory
<user_memory>...</user_memory>

# Harness
<session_context>...</session_context>
```

The injection point is the `body.system` field (in the Anthropic protocol, system is separate from messages).

---

## 7. Special Behavior

- **resetEpoch**: supports the `mem:session-reset` command, with cross-node stale checks
- **Vertex AI relay**: supports passing through `x-vertex-ai-session-id`
- **Fork/Subagent**: when CC's `task` command starts a subagent, the session_id stays the same, and the proxy archives the subagent and main agent together
- **mem commands**: full support for `mem:sync` / `mem:create-skill` / `mem:session-reset`, etc.

---

## 8. Archive Triggers

- Automatically triggers `skill/conversation/add` when the conversation exceeds a threshold (token count / turns)
- Supports `skill/conversation/force-archive` for manual archiving
- Archived data is written to L0 (TDAI write)

---

## 9. Environment Variables

No CC-specific variables. The global proxy config is enough:

```env
PROXY_PORT=8096
FORWARD_URL=https://api.anthropic.com   # CC upstream
```

---

## 10. FAQ

**Q: Can CC get stuck when the form has too many options?**  
A: No. Pagination guarantees at most 4 options at a time, though with many options the user may need to page several times.

**Q: Do CC subagent requests repeat session-init?**  
A: No. Subagents reuse the main agent's session_id; the proxy sees it is already initialized and skips the form.

**Q: Do CC's auxiliary requests (title-gen / compact) get injection?**  
A: No. Once the proxy identifies an auxiliary request, it passes it straight through without injection/archiving.
