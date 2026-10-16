# CodeBuddy (CB)

> agentSource: `codebuddy` | Protocol: OpenAI Chat Completions / Anthropic Messages | Handler: `handler.ts` (shared)
>
> To import local history into Memory Hub, see the [Asset Import Guide](./asset-import.md).

---

## 1. Client Configuration

CB configures custom models through the **config file** `~/.codebuddy/models.json`:

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-20250514",
      "name": "proxy-memory-agent",
      "vendor": "claude",
      "apiKey": "<business user's sk-mem-... user_key>",
      "maxInputTokens": 200000,
      "url": "http://127.0.0.1:8096/codebuddy/default",
      "supportsToolCall": true,
      "supportsImages": true
    }
  ]
}
```

Fields:
- `id` — a model ID supported by the proxy's upstream (e.g. `claude-sonnet-4-20250514`)
- `name` — the name shown in the CodeBuddy chat panel; can be anything
- `vendor` — for UI display only (e.g. `claude`, `openai`); does not affect the actual request
- `apiKey` — the business user's `user_key` (obtained from the panel; same as CC's `ANTHROPIC_AUTH_TOKEN`)
- `url` — proxy address + `/codebuddy/<spaceId>`; `default` is the memory instance ID

Once configured, select this model in the CB chat panel.

### ⚠️ Version Restriction

> CodeBuddy **4.10.2 ~ 4.10.4** does not send a sessionId, so Session Init cannot complete.  
> **Use ≥ 4.10.5 or ≤ 4.10.1**.

Request paths:
- OpenAI: `POST /codebuddy/:spaceId/v1/chat/completions`
- Anthropic: `POST /codebuddy/:spaceId/v1/messages`

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |
| 3 | `x-cb-session-id` |
| 4 | `x-codebuddy-session-id` |

The CB IDE plugin automatically generates and sends `x-conversation-id`.

---

## 3. Session Init (Form)

### 3.1 Mechanism

CB uses the **`ask_followup_question`** function_call to present an interactive form:

- Tool name: `ask_followup_question`
- Call ID prefix: `call_session_init_` (OpenAI) / `toolu_session_init_` (Anthropic)
- Protocol: OpenAI SSE tool_calls chunks or Anthropic SSE

### 3.2 State Machine

```
asset_confirm → team_select → agent_task_select → initialized
```

4-step flow:
1. **asset_confirm** — confirm whether to inject assets ("Use memory/skills?")
2. **team_select** — select a team
3. **agent_task_select** — select Agent + Task in one combined step
4. **initialized** — inject assets and enter normal conversation

### 3.3 Pagination

CB's `ask_followup_question` option list has **no size limit**, so no pagination is needed.  
All options are shown at once.

### 3.4 Plan Mode / Default Mode

CB has **no** Default Mode gate. The CB client always has the `ask_followup_question` tool available, so the form can always be sent.

### 3.5 Skipping Session Init

- Choose `"否，本次不关联"` ("No, don't link this time") at the `asset_confirm` step → skips all remaining steps and passes requests straight through
- Enter `"跳过"` ("Skip") / `"skip"` at any step → skipped once SKIP_RE matches

---

## 4. Request Classification

CB's request classification is simple:

| Type | Description |
|------|------|
| **main** | All requests are main by default |

CB has **no** fork / sidequery / compact or other auxiliary request concepts. Every request goes through the full pipeline.

---

## 5. User Text Extraction

CB message bodies' `message.content` is always a **plain string** (not a content block array).

Extraction logic:
1. Look for a `<user_query>...</user_query>` XML wrapper in the string
2. If found → extract the inner text
3. If not found → use the whole string as the user text
4. Strip CB pseudo-XML tags (`<agent_context>`, `<code_context>`, etc.)

---

## 6. Injection Profile

System prompt injection uses an **XML structure**:

```xml
<agent_skills>
  <available_skills>...</available_skills>
</agent_skills>
<content_policy>...</content_policy>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

Injection points:
- OpenAI: `messages[0].content` (appended inside the system message string)
- Anthropic: the `system` field

---

## 7. Special Behavior

- **Distinct header set**: `x-agent-intent`, `x-conversation-message-id`, `x-conversation-request-id`
- **Assistant placeholder**: CB assistant messages may be a `"-"` placeholder (empty-reply marker)
- **Shared handler**: dsh also reuses this handler (`handleChatCompletions`)
- **Dual-protocol support**: the same CB version may use either the OpenAI or Anthropic protocol; the handler adapts automatically

---

## 8. Archive Triggers

- Automatically triggers `skill/conversation/add` when the conversation exceeds a threshold
- Supports `skill/conversation/force-archive`
- Archived data is written to L0

---

## 9. Environment Variables

No CB-specific variables. Uses the global proxy config:

```env
PROXY_PORT=8096
FORWARD_URL=https://api.openai.com   # CB OpenAI upstream
# or FORWARD_URL=https://api.anthropic.com  # CB Anthropic upstream
```

The actual upstream is decided dynamically by `resolveForwardTarget` (tokenhub / direct provider).

---

## 10. FAQ

**Q: What are the main differences between CB and CC?**  
A: Different protocol (OpenAI vs Anthropic), different content structure (string vs content-block array), no auxiliary request classification, and no option pagination.

**Q: Who adds CB's `<user_query>` wrapper?**  
A: The CB IDE plugin client wraps the user's original text automatically before sending; the proxy strips it during extraction.

**Q: How does CB on the Anthropic protocol differ from CC?**  
A: The form tool name differs (`ask_followup_question` vs `AskUserQuestion`), content is still a string, and injection uses XML instead of Markdown. The agentSource tag is also different.
