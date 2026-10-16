# Codex

> agentSource: `codex` | Protocol: OpenAI Responses API | Handler: `codexHandler.ts` (standalone)
>
> Importing local history into Memory Hub: see the [Asset Import Guide](./asset-import.md).

---

## 1. Client Configuration

Codex is configured through the **config file** `~/.codex/config.toml`:

```toml
# ~/.codex/config.toml
model_provider = "team-proxy"
model = "claude-opus-4.7"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.team-proxy]
name       = "TDAI team-proxy"
wire_api   = "responses"
base_url   = "http://127.0.0.1:8096/codex/default"
experimental_bearer_token = "<business user's sk-mem-... user_key>"

request_max_retries    = 2
stream_max_retries     = 3
stream_idle_timeout_ms = 120000
```

Fields:
- `wire_api = "responses"` — **required**; Codex uses the OpenAI Responses API protocol
- `base_url` — Proxy address + `/codex/<spaceId>`; `default` is the memory instance ID
- `experimental_bearer_token` — the business user's `user_key` (get it from the Panel)
- `disable_response_storage = true` — disables local caching so every turn goes through Proxy injection
- `stream_idle_timeout_ms = 120000` — prevents timeouts while session-init waits for user input

> ⚠️ **You must switch to Plan mode (`Shift+Tab`) before the first conversation.** Codex's default Agent mode auto-executes tool calls and skips user selection, so session-init never completes. After choosing Team→Agent→Task, switch back to Agent mode.

Request paths:
- `POST /codex/:spaceId/v1/responses`
- `POST /codex/:spaceId/responses` (no v1 prefix, also accepted)

Auxiliary paths:
- `/codex/:spaceId/responses/compact` — compact requests
- `/codex/:spaceId/memories/trace_summarize` — trace summarization
- `/codex/:spaceId/realtime/calls` — realtime calls

---

## 2. Session ID

| Priority | Source |
|--------|--------|
| 1 | `session-id` header |
| 2 | `body.client_metadata.session_id` |

The Codex CLI generates the session_id automatically and writes it to both the header and the body; no manual configuration needed.

---

## 3. Session Init (Session Initialization / Form)

### 3.1 Mechanism

Codex uses the **`request_user_input`** function_call to present an interactive form:

- Tool name: `request_user_input`
- ID prefix: `fc_codex_session_init_` (⚠️ the `fc_` prefix is mandatory; the OpenAI Responses spec validates it strictly)
- Call ID prefix: `call_codex_session_init_`
- Protocol: OpenAI Responses API SSE (`response.created` / `response.output_item.*` / `response.completed` events)

### 3.2 State Machine

Reuses the CB state machine, tagged with `agentSource="codex"`, `protocol="responses"`:

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

Codex uses a dedicated `computeCodexPagination`. The rules are similar to CC (limited number of options), but the implementation is separate.

### 3.4 ⚠️ Default Mode Gate (Key Difference)

Codex has two run modes:
- **Suggest mode** — the `request_user_input` tool is available → the form works normally
- **Default mode** — the client blocks `request_user_input` calls

**Default mode detection**: after the proxy sends the form, the `function_call_output.output` returned by the client contains:

```
"request_user_input is unavailable in Default mode"
```

When the proxy detects this gate string → it **permanently skips** session-init, and all subsequent requests pass straight through.

### 3.5 Skipping Session Init

Three ways:
1. The Default mode gate triggers automatically → permanent skip
2. The user manually enters `"跳过"` ("Skip") / "skip"
3. Choose `"否，本次不关联"` ("No, don't link this time") at asset_confirm

---

## 4. Request Classification

Codex uses **three signals** to identify auxiliary requests:

| Signal | What is checked |
|------|----------|
| Path suffix | `/compact`, `/memories/trace_summarize`, `/realtime/calls` |
| Header | `x-openai-memgen-request: true` |
| Body | `body.client_metadata.thread_source` ≠ `"main"` |

If any one matches → classified as auxiliary → injection/archiving is skipped.

---

## 5. User Text Extraction

Extracted from the `body.input[]` array:
1. Find the last item with `type: "message"` and `role: "user"`
2. Extract the text of every `input_text` block in its `content[]`
3. Concatenate into the final user text

⚠️ Codex's body structure is completely different from Chat Completions (`input[]` instead of `messages[]`).

---

## 6. Injection Profile

Uses the codex-specific injection builder `buildCodexInjectionBlock`:

```
Injected into the instructions field (not messages/input)
```

Codex's injection point is `body.instructions` (the Responses API equivalent of a system prompt).

---

## 7. Special Behavior

- **Standalone handler**: `codexHandler.ts`, not shared with CB/CC
- **Mandatory fc_ prefix**: the OpenAI Responses API requires function_call ids to start with `fc_`; otherwise the client gets a 400 on replay
- **Marker routing**: `/codex/:spaceId/cost-guard/responses` and `/codex/:spaceId/analyse/responses` support cost-guard/analyse routing
- **Archive hook**: on 2026-08-11, codex's `skill/conversation/add` + TDAI L0 write were added (previously data was silently dropped)

---

## 8. Archive Triggers

- Automatically calls `skill/conversation/add` when a conversation exceeds the threshold (via the responses branch of `normalize-conversation`)
- Supports `skill/conversation/force-archive`
- Codex archives must go through `normalizeCodexConversation` to be converted to the unified format

---

## 9. Environment Variables

```env
PROXY_PORT=8096
# Codex upstream (usually tokenhub or copilot.tencent.com)
# Routed dynamically by resolveForwardTarget
```

On this machine the codex upstream is `https://copilot.tencent.com` (no /v1 or /v2).  
Available models: `gpt-5.3-codex` / `gpt-5.4` / `gpt-5.5` / `gpt-5.6-*` / `deepseek-r1`; `claude-*` is hard-rejected.

---

## 10. FAQ

**Q: Is there no memory injection at all in Codex Default mode?**  
A: Correct. Once the Default mode gate triggers, the proxy passes requests straight through without any injection. This follows from the codex client's design — Default mode aims for minimal latency.

**Q: What is the fc_ prefix issue?**  
A: The OpenAI Responses API validates the function_call id field with a regex; it must start with `fc_`. When generating the form, the proxy uses the `fc_codex_session_init_` prefix while call_id keeps the `call_` prefix. Before the fix, the codex client's 5th replayed request always returned 400.

**Q: What is Codex's /compact request?**  
A: Similar to CC's conversation compaction, it is an auxiliary request the client triggers automatically and does not need injection/archiving.

**Q: How does Codex reuse CB code?**  
A: Codex has its own `codexHandler.ts`, but the underlying session-init state machine reuses CB's implementation (with different agentSource + protocol parameters).

---

## 11. Differences from Claude Code / CodeBuddy

| Dimension | Claude Code | CodeBuddy | Codex |
|------|-------------|-----------|-------|
| Protocol | Anthropic Messages | OpenAI Chat Completions | **OpenAI Responses** |
| Config file | Environment variables | `~/.codebuddy/models.json` | `~/.codex/config.toml` |
| URL prefix | `/claude-code/<spaceId>` | `/codebuddy/<spaceId>` | `/codex/<spaceId>` |
| Key delivery | env `ANTHROPIC_AUTH_TOKEN` | JSON `apiKey` | TOML `experimental_bearer_token` |
| Session init | Form pops up automatically | Form pops up automatically | **First time requires manually switching to Plan mode** |
