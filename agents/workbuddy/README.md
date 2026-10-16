# WorkBuddy (WB)

> agentSource: `workbuddy` | Protocol: OpenAI Responses API (Desktop) + Chat Completions (Web) | Handler: `workbuddyHandler.ts` (standalone)
>
> To import local history into Memory Hub, see the [asset import guide](./asset-import.md).

---

## 1. Client Configuration

WB configures custom models through the **config file** `~/.workbuddy/models.json`:

```json
[
  {
    "id": "claude-opus-4.7-1m",
    "name": "claude-opus-4.7-1m",
    "vendor": "Custom",
    "url": "http://127.0.0.1:8096/workbuddy/default",
    "apiKey": "<business user's sk-mem-... user_key>",
    "supportsToolCall": true,
    "supportsImages": false,
    "supportsReasoning": false,
    "useCustomProtocol": false
  }
]
```

Fields:
- `id` — a model ID supported by the proxy's upstream (e.g. `claude-opus-4.7-1m`)
- `name` — the name shown in WorkBuddy's "Custom Models" list
- `vendor` — display only (`Custom`, `claude`, etc.); does not affect the actual request
- `url` — proxy address + `/workbuddy/<spaceId>`; `default` is the memory instance ID
- `apiKey` — the business user's `user_key` (get it from the panel)

Once configured, select the model under "Custom Models" in WorkBuddy's model picker.  
Session init works the same as CC/CB (pick Team → Agent → Task); the session ID is managed automatically by the client.

Request paths:
- Desktop: `POST /workbuddy/:spaceId/v1/responses` or `/workbuddy/:spaceId/responses`
- Web: `POST /workbuddy/:spaceId/v1/chat/completions`

Auxiliary paths (same as Codex):
- `/workbuddy/:spaceId/responses/compact`
- `/workbuddy/:spaceId/memories/trace_summarize`
- `/workbuddy/:spaceId/realtime/calls`

---

## 2. Session ID

| Priority | Source |
|--------|------|
| 1 | `session-id` header |
| 2 | `body.client_metadata.session_id` |

The WB client generates and sends the session ID automatically; no manual configuration is needed.

---

## 3. Session Init

WB's session init is the same as CC/CB: an interactive form to pick Team → Agent → Task.

### 3.1 Interactive Form

When the client's `body.tools` includes the `AskUserQuestion` tool, the interactive form is used:

- Tool name: `AskUserQuestion` (same as CC)
- Call ID prefix: `call_wb_session_init_`
- Pagination: CC-style pagination (max 4 options)
- State machine: reuses the CB state machine

### 3.4 Default Mode Gate

WB Desktop also has a Default mode gate (same as Codex):  
if the client returns `"request_user_input is unavailable in Default mode"`, the form is skipped permanently.

---

## 4. Request Classification

WB uses the same **three-signal** auxiliary-request detection as Codex:

| Signal | What is checked |
|------|----------|
| Path suffix | `/compact`, `/memories/trace_summarize`, `/realtime/calls` |
| Header | `x-openai-memgen-request: true` |
| Body | `body.client_metadata.thread_source` ≠ `"main"` |

---

## 5. User Text Extraction

Because WB speaks two protocols, user text extraction is **dual-mode**:

| Mode | Protocol | Extraction |
|------|------|----------|
| Desktop | Responses API | Extracted from `body.input[]` (same algorithm as Codex) |
| Web | Chat Completions | Extracted from the `messages[].content` string + `<user_query>` stripping (same algorithm as CB) |

---

## 6. Injection Profile

WB has its own injection profile under `injection/agents/workbuddy/`:

- Standalone parser / serializer
- The system prompt uses a **nunjucks template** with placeholders:
  ```
  {{ WorkbuddyMemory_1 }}
  {{ WorkbuddySkills }}
  {{ WorkbuddyKnowledge }}
  ```
- The injection point depends on the protocol:
  - Responses API: `body.instructions`
  - Chat Completions: `messages[0].content`

---

## 7. Special Behavior

- **Standalone handler**: `workbuddyHandler.ts`, with zero cross-references to Codex/CB/CC
- **Two protocols side by side**: Desktop uses the Responses API, Web uses Chat Completions, both handled in the same handler
- **Desktop SDK**: the client uses the `@openai/agents 0.5.2` SDK
- **Distinct header set**: `X-Agent-Intent`, `X-Agent-Purpose`, `X-User-Id`, `X-Codebuddy-Run-Timeout`
- **nginx routing**: the internal nginx must forward `/workbuddy/:iid/*` to the proxy (added 2026-08-13)

---

## 8. Archive Triggers

- Shares the archive mechanism with Codex
- Conversations over the threshold are automatically sent to `skill/conversation/add`
- Supports `skill/conversation/force-archive`

---

## 9. Environment Variables

No WB-specific variables. Upstream routing is decided dynamically by `resolveForwardTarget`.

---

## 10. FAQ

**Q: What is the simplest way to connect WB?**  
A: Send the three headers `x-tdai-team-id` / `x-tdai-agent-id` / `x-tdai-task-id` on client requests. The proxy registers the session and injects assets directly, with zero interaction latency.

**Q: What happens if WB sends neither the headers nor the tool?**  
A: Silent passthrough. No error and no blocking, but also no memory/skill injection. This is by design: WB is not forced to use memory.

**Q: Why do WB Desktop and Web use different protocols?**  
A: The Desktop version uses the `@openai/agents` SDK over the Responses API; the Web version uses standard Chat Completions. The proxy supports both and tells them apart by path.

**Q: How does WB's code relate to Codex?**  
A: Fully independent. Although both support the Responses API, WB has its own handler, injection profile and template system. There are no cross imports.
