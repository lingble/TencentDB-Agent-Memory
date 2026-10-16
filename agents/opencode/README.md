# OpenCode

> agentSource: `opencode` | Protocol: OpenAI Chat Completions | Handler: `handler.ts` (shared with CB / dsh)

---

## 1. Client Configuration

OpenCode is an open-source AI coding CLI [from SST](https://github.com/sst/opencode). Connect it to the Proxy by configuring a custom provider in
`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "proxy-memory": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Proxy Memory (OpenCode)",
      "options": {
        "baseURL": "http://127.0.0.1:8096/opencode/default/v1",
        "apiKey": "<business user's sk-mem-... user_key>"
      },
      "models": {
        "claude-opus-4.7-1m": {
          "name": "claude-opus-4.7-1m"
        }
      }
    }
  }
}
```

Fields:
- `baseURL` — Proxy address + `/opencode/<spaceId>/v1`; `default` is the memory instance ID (spaceId)
- `apiKey` — the business user's `user_key` (copy it from the MemoryPanel → OpenCode card)
- `models.<id>.name` — a model ID supported by the Proxy upstream (e.g. `claude-opus-4.7-1m`)
- OpenCode uses the `@ai-sdk/openai-compatible` provider, which speaks the **OpenAI Chat Completions** protocol

After starting OpenCode, pick a model under `proxy-memory` in the `/model` selector.

Request paths:
- Main path: `POST /opencode/:spaceId/v1/chat/completions`
- Bare-tail variant: `POST /opencode/:spaceId/chat/completions` (when `baseURL` has no `/v1`)

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |

The OpenCode client itself **does not send** a session ID header. The proxy generates
a stable sessionId for each request (derived from the request context), which effectively behaves as "each session is independent".

If a wrapper / proxy layer attaches `x-conversation-id`, the proxy uses it first.

---

## 3. Session Init (Session Initialization / Form)

### 3.1 Mechanism

OpenCode reuses CB's **`ask_followup_question`** function_call mechanism to present an interactive form:

- Tool name: `ask_followup_question`
- Call ID prefix: `call_oc_session_init_` (the handler uses a dedicated prefix for opencode, distinct from CB's `call_session_init_` / dsh's `call_dsh_session_init_`)
- Protocol: OpenAI SSE tool_calls chunks

### 3.2 State Machine

Reuses the CB state machine:

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

No limit on the number of options; all options are shown at once.

### 3.4 Skipping Session Init

- Choose `"否，本次不关联"` ("No, don't link this time") at `asset_confirm` → passes straight through
- Enter `"跳过"` ("Skip") / "skip" at any step → skips

---

## 4. Marker Routing (⚠️ Important)

OpenCode supports appending a **marker** URL segment to trigger cost-guard routing or analyse request classification,
used exactly the same way as with CB / Codex:

| Marker | Path | Purpose |
|--------|------|------|
| (none) | `/opencode/<spaceId>/v1/chat/completions` | Default general pipeline |
| **cost-guard** | `/opencode/<spaceId>/cost-guard/v1/chat/completions` | Force the cost-guard tier |
| **analyse** | `/opencode/<spaceId>/analyse/v1/chat/completions` | Classify the request as analyse |

Bare-tail variants (when `baseURL` has no `/v1`):
- `/opencode/<spaceId>/cost-guard/chat/completions`
- `/opencode/<spaceId>/analyse/chat/completions`

### 4.1 Marker Gating

Both marker routes are gated by the config option `assetReflection.markerOptIn`:
- `markerOptIn: true` → matched and applied
- `markerOptIn: false` → returns `404 {"error":"cost_guard_marker_disabled"}` / similar

See `MemoryProxy/z_config/config.yaml` → `assetReflection.markerOptIn`.

### 4.2 Client Usage

Switch directly via `baseURL` in opencode.json:

```jsonc
// Default tier
"baseURL": "http://127.0.0.1:8096/opencode/default/v1"

// Force cost-guard
"baseURL": "http://127.0.0.1:8096/opencode/default/cost-guard/v1"

// analyse classification (for backend pipelines to recognize)
"baseURL": "http://127.0.0.1:8096/opencode/default/analyse/v1"
```

---

## 5. Request Classification

OpenCode's request classification is simple:

| Type | Description |
|------|------|
| **main** | All requests are main by default |
| **analyse** | Marked as analyse when the URL has the `/analyse/` marker (for the report layer to recognize) |

OpenCode has **no** auxiliary request concepts such as fork / sidequery / compact.

---

## 6. User Text Extraction

In OpenCode request bodies, `message.content` is a **plain string** (not a content block array, and not
XML-wrapped):

- No `<user_query>` wrapper (unlike CB)
- No content block array (unlike CC)
- Takes the content string of the last user message directly

Image input passes through as an `image_url` content-part (the client base64-encodes it and the proxy forwards it
upstream as-is); the proxy does no special handling.

---

## 7. Injection Profile

OpenCode shares CB's handler path (both are OpenAI Chat Completions), so injection is the same:

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

Injection point: `messages[0].content` (appended inside the system message string).

---

## 8. Special Behavior

- **Shared handler**: OpenCode reuses CB's `handleChatCompletions` (the same path as dsh)
- **agentSource distinction**: the `/opencode/` route segment → `agentSource=opencode`
- **No dedicated header fingerprint**: the OpenCode CLI sends no custom headers; the proxy identifies it via the URL segment + user-agent
- **Marker routing**: two URL markers, `/cost-guard/` and `/analyse/`; see §4

---

## 9. Archive Triggers

- Shares the archive mechanism with CB / dsh
- Automatically calls `skill/conversation/add` when a conversation exceeds the threshold
- Supports `skill/conversation/force-archive`
- Archived data is written to L0

---

## 10. Environment Variables

No OpenCode-specific variables. Upstream routing is decided dynamically by `resolveForwardTarget`
(usually pointing at tokenhub or a direct provider).

---

## 11. FAQ

**Q: OpenCode shares a handler with CB / dsh. How are they told apart?**  
A: At the routing layer, by the `/:agent/` segment. Inside the handler, `agentSource=opencode` triggers
OpenCode-specific behavior (marker routing, self-generated session ID, etc.).

**Q: Must `baseURL` in opencode.json include `/v1`?**  
A: Recommended (main path), but the proxy also accepts the bare-tail variant (without `/v1`). Both work.

**Q: What if marker routes return 404?**  
A: Check that `assetReflection.markerOptIn` in `MemoryProxy/z_config/config.yaml` is
`true`. After changing it, run `./scripts/proxy.sh restart` to load it.

**Q: Does the OpenCode CLI support the `@image:path` syntax?**  
A: That is an OpenCode client-side capability, unrelated to the proxy. The client reads the file, base64-encodes it into an `image_url`
content-part, and the proxy passes it through to the upstream transparently.

**Q: Can local history sessions / skills be imported into Memory Hub?**  
A: The OpenCode client does not persist skill / session files locally (unlike CB / dsh), so there is currently no
`asset-import.md`. To import past conversations, import them manually via the Panel or use the `mem:sync` command.

---

## 12. Differences from CB / dsh

| Dimension | CodeBuddy | dsh | **OpenCode** |
|---|---|---|---|
| Protocol | OpenAI Chat Completions | OpenAI Chat Completions | **OpenAI Chat Completions** |
| Config file | `~/.codebuddy/models.json` | `~/.dsh/settings.yaml` + `.credentials.yaml` | **`~/.config/opencode/opencode.json`** |
| URL prefix | `/codebuddy/<spaceId>` | `/dsh/<spaceId>` (no `/v1`) | **`/opencode/<spaceId>`** |
| Provider library | Built-in | Built-in | **`@ai-sdk/openai-compatible`** |
| Key delivery | JSON `apiKey` | `.credentials.yaml` env var | **JSON `provider.*.options.apiKey`** |
| Form tool | `ask_followup_question` | `ask_user_question` | **`ask_followup_question`** (same as CB) |
| Session ID | Client sends `x-conversation-id` | Client sends `x-deepseek-harness-session-id` | **Proxy-generated** |
| Marker routing | None | None | **`/cost-guard/` `/analyse/`** |
| Local asset import | Yes (`asset-import.md`) | Yes (`asset-import.md`) | **No** (client persists no files) |

---

## 13. Current Status

- ✅ Implementation complete (handler reuses the CB path)
- ✅ Marker routing (cost-guard / analyse) unit tests passing 6/6
- ✅ End-to-end curl verification passed (3 real upstream streaming responses)
- ✅ Panel shows the OpenCode card
