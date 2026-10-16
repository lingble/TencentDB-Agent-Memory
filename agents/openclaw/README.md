# OpenClaw

> agentSource: `openclaw` | Protocol: OpenAI Chat Completions | Session Init: header preselection (no interactive form)
>
> To import local history into Memory Hub, see the [asset import guide](./asset-import.md).

---

## 1. Client Configuration

OpenClaw is configured through the `models.providers` section of the **config file** `~/.openclaw/openclaw.json`:

```jsonc
{
  "models": {
    "mode": "merge",
    "providers": {
      "memory-proxy": {
        "baseUrl": "http://<proxy-host>:8096/openclaw/<spaceId>",
        "apiKey": "<business user's sk-mem-... user_key>",
        "api": "openai-completions",
        "headers": {
          "x-team-id": "<team_id from the panel>",
          "x-agent-id": "<agent_id from the panel>",
          "x-task-id": "<task_id from the panel>",
          "x-conversation-id": "<your own conversation identifier>"
        },
        "request": {
          "allowPrivateNetwork": true
        },
        "models": [
          {
            "id": "gpt-5.5",
            "name": "GPT-5.5",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 32000,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  }
}
```

Fields:
- `baseUrl` — proxy address + `/openclaw/<spaceId>`; `default` is the memory instance ID
- `apiKey` — the business user's `user_key` (get it from the panel)
- `api` — must be `"openai-completions"`
- `headers` — must include `x-team-id`, `x-agent-id`, `x-task-id`, `x-conversation-id`
- `models[].id` — must match a model ID configured on the proxy's upstream
- `allowPrivateNetwork: true` — allows access to private-network addresses

Request path: `POST /openclaw/:spaceId/v1/chat/completions`

---

## 2. Session ID

| Source | Header |
|------|--------|
| Only | `x-conversation-id` (set statically by the user in the config file) |

OpenClaw does not manage session IDs automatically; change it manually.

---

## 3. Session Init

### ⚠️ Key Difference: Header Preselection Only, No Interactive Form

OpenClaw **does not support the interactive form**, and session registration relies on headers:

| Header | Description | Required |
|--------|------|------|
| `x-team-id` | Team ID | ✅ |
| `x-agent-id` | Agent ID | ✅ |
| `x-task-id` | Task ID | ✅ (current version) |
| `x-conversation-id` | Conversation identifier | ✅ |

**Handling logic**:
- All four headers present and valid → register the session directly and inject assets
- Any one missing → session bypass (passthrough, no injection)

---

## 4. Request Classification

All requests are **main**. OpenClaw has no concept of auxiliary requests.

---

## 5. Injection Profile

Same as CB: XML-structured content injected into `messages[0].content` (the system message).

---

## 6. Known Limitations

### `x-task-id` Is Currently Required

Without it, the session is bypassed and memory injection does not take effect.  
Workaround: set `sessionInit.defaultTaskId: "no-task"` on the proxy and use that fixed value.

### `x-conversation-id` Must Be Managed Manually

- Requests with the same ID share a session; change the value manually for each new conversation
- Some follow-up turns after a tool call may not send the headers → injection is skipped on those turns

---

## 7. FAQ

**Q: Is it OK to set cost to 0 in models?**  
A: Yes. OpenClaw uses cost for client-side budget calculations; when going through the proxy, actual billing happens upstream, so 0 on the client side does not affect functionality.

**Q: What is `allowPrivateNetwork: true`?**  
A: OpenClaw blocks requests to private-network addresses by default (security policy). This setting is required to reach a proxy on `127.0.0.1` or a private-network IP.
