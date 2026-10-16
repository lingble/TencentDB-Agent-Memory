---
name: setup-proxy
description: Interactively guide the user through configuring an AI Agent to use Memory Proxy (probe step by step, verify step by step)
triggers:
  - configure proxy
  - configure agent
  - setup proxy
  - connect to proxy
  - connect memory
---

# Setup Proxy — Agent Integration Wizard

You are helping the user connect an AI Agent client (Claude Code / CodeBuddy / Codex / WorkBuddy / dsh / OpenClaw) to Memory Proxy.

## Background

Memory Proxy is an LLM request proxy that injects team memory/skills/knowledge before forwarding requests to the upstream LLM. Each agent client has a different config file format and protocol:

| Agent | Config File | Protocol | Special Requirements |
|-------|----------|------|----------|
| claude-code | `~/.claude/settings.json` | Anthropic Messages | Write 5 model variables in the env field |
| codebuddy | `~/.codebuddy/models.json` | OpenAI Chat | Append an entry to the models array |
| codex | `~/.codex/config.toml` | OpenAI Responses | TOML format; must set `wire_api = "responses"` |
| workbuddy | `~/.workbuddy/models.json` | OpenAI Chat / Responses | Top-level array |
| dsh | `~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml` | OpenAI Chat (no /v1) | Two files + chmod 700/600 |
| openclaw | `~/.openclaw/openclaw.json` | OpenAI Chat | Requires header pre-selection + allowPrivateNetwork |

## Script Location

Config-writing script: `agents/skills/setup-proxy/setup-proxy.sh` (relative to the repo root)

## Procedure

**Follow this order strictly. Each step must pass verification before moving on to the next.**

### Step 1: Scan existing configuration

First check whether the user already has a proxy configuration, to avoid re-entering it:

```bash
# Check Claude Code
cat ~/.claude/settings.json 2>/dev/null | jq -r '.env.ANTHROPIC_BASE_URL // empty'

# Check CodeBuddy
cat ~/.codebuddy/models.json 2>/dev/null | jq -r '.models[]? | select(.url | contains("/codebuddy/")) | .url' 2>/dev/null | head -1

# Check the other agents similarly...
```

If you find a URL containing a proxy path (containing a segment such as `/claude-code/`, `/codebuddy/`, `/codex/`), **extract and show**:
- Proxy address (the part of the URL before `/<agent>/`)
- Instance ID (the segment of the URL after `/<agent>/`)
- User Key (the value of the corresponding field, masked to show only the first and last 4 characters)
- Model ID

Ask the user: "Existing configuration detected. Reuse it?"
- Yes → skip to Step 3
- No → continue to Step 2 for manual entry

### Step 2: Collect basic information

Ask the user for each of these in turn:
1. **Proxy address** (including scheme + port, e.g. `http://127.0.0.1:8096`)
2. **Instance ID** (default `default`; usually unchanged for local deployments)
3. **User Key** (obtained from the Panel's **API Key** page; any format)

Confirm each item after getting it. Do not ask for all three at once.

### Step 3: Choose the Agent

Show the 6 available agents and have the user choose **one**:
1. Claude Code
2. CodeBuddy
3. Codex
4. WorkBuddy
5. dsh (DeepSeek Harness)
6. OpenClaw

### Step 4: Enter the model ID

Tell the user:
- This model ID must be a model supported by the Proxy's upstream
- Give common examples: `claude-sonnet-4-20250514`, `claude-opus-4.7`, `gpt-5.5`, `deepseek-r1`

### Step 5: Health probe (key verification step)

**Based on the chosen agent's protocol**, build the matching curl probe request:

```bash
# Claude Code → Anthropic Messages
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/claude-code/${INSTANCE_ID}/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# CodeBuddy / OpenClaw → OpenAI Chat
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/${AGENT}/${INSTANCE_ID}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# dsh → OpenAI Chat, but without /v1
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/dsh/${INSTANCE_ID}/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# Codex → Responses API
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/codex/${INSTANCE_ID}/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}],"stream":false}'

# WorkBuddy → OpenAI Chat (more generic)
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/workbuddy/${INSTANCE_ID}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'
```

**Interpret the result**:
- HTTP connection failure (000) → tell the user the proxy is unreachable and have them check the address/port/service status. **Do not continue**
- 2xx → fully healthy, continue
- 4xx → the proxy is reachable (possibly a form returned by session-init, or an auth problem). **Show the response body to the user for reference**, then continue
- 5xx → the proxy has a problem. **Show the full error response** and ask the user whether to continue

### Step 6: Header pre-selection (OpenClaw only)

If the user chose openclaw, collect the additional header pre-selection information. This agent does not support the interactive form, so the team/agent/task IDs must be pre-filled in the config.

**Preferred approach: pull the lists from the Panel API and let the user choose**

Ask the user whether they can provide the Panel backend address (default `http://127.0.0.1:8125`). If they do:

```bash
# 1. First get user_id via auth/verify
curl -s -X POST "${PANEL_URL}/api/v1/meta/auth/verify" \
  -H "Content-Type: application/json" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"user_key":"'${USER_KEY}'"}'
# Extract from .data.user.user_id

# 2. Pull the Team list
curl -s -X POST "${PANEL_URL}/api/v1/meta/team/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"user_key":"'${USER_KEY}'"}'
# Show .data.items for the user to choose from

# 3. Pull the Agent list (filtered by owner_user_id)
curl -s -X POST "${PANEL_URL}/api/v1/meta/agent/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"team_id":"'${TEAM_ID}'","user_key":"'${USER_KEY}'","owner_user_id":"'${USER_ID}'"}'
# Show .data.items for the user to choose from

# 4. Pull the Task list
curl -s -X POST "${PANEL_URL}/api/v1/meta/task/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"team_id":"'${TEAM_ID}'","user_key":"'${USER_KEY}'"}'
# The first option is always "No task this time (no-task)"
```

If the Panel is unreachable or the user prefers not to provide it, have the user enter team_id / agent_id / task_id manually.

You also need an **x-conversation-id** (you can auto-generate one, e.g. `conv-20260820-xxxx`).

### Step 7: Confirm the config file path

Tell the user the default path (see the table above) and ask whether to use it. If not, have the user enter one.

### Step 8: Call the script to write the configuration

Once all information is collected and verified, **call the script in non-interactive mode** to write the configuration:

```bash
bash agents/skills/setup-proxy/setup-proxy.sh --non-interactive \
  --proxy-host "${PROXY_HOST}" \
  --instance-id "${INSTANCE_ID}" \
  --user-key "${USER_KEY}" \
  --agent "${CHOSEN_AGENT}" \
  --model "${MODEL_ID}" \
  --config-path "${CONFIG_PATH}"
```

For OpenClaw, append:
```bash
  --team-id "${TEAM_ID}" \
  --agent-id "${AGENT_ID}" \
  --task-id "${TASK_ID}" \
  --conv-id "${CONVERSATION_ID}"
```

**Check the script's exit code**: 0 = success, non-zero = failure (show the output to the user).

### Step 9: Verify what was written

After writing, read the config file to confirm the content is correct:
```bash
cat <config_path>
```

Show the key fields to the user for confirmation.

### Step 9.5: Remind the user to switch models

**Writing the config does not make it take effect.** You must remind the user to switch to the Proxy model in the client; only then does traffic go through the Proxy:

| Agent | How to switch |
|-------|----------|
| Claude Code | Nothing to do; the env in `settings.json` is loaded automatically at startup |
| CodeBuddy | Switch the model in the chat box to **proxy-memory-agent** (i.e. the configured model ID) |
| Codex | Nothing to do; `config.toml` already specifies the model |
| WorkBuddy | In the model picker, switch to the corresponding model in the custom model list |
| dsh | Nothing to do; `settings.yaml` already specifies the model |
| OpenClaw | Make sure the provider/model selected in the client points at the Proxy config |

**Always tell the user**: if they don't switch models, requests won't go through the Proxy and memory/skill injection won't take effect.

### Step 10: Asset import (optional)

After configuration, ask the user: import this Agent's local assets (skills + conversation history) into team memory?

If the user chooses to import:
- You need the Panel URL, Team ID, and Agent ID
- If team/agent were already chosen in Step 6, recommend reusing them
- Otherwise have the user provide them

Then call:
```bash
PANEL_URL="${PANEL_URL}" TDAI_SERVICE_ID="${INSTANCE_ID}" TDAI_USER_KEY="${USER_KEY}" \
  tsx agents/asset-import.ts --source "${CHOSEN_AGENT}" --team-id "${TEAM_ID}" --agent-id "${AGENT_ID}"
```

If `tsx` is unavailable, tell the user to run the command manually.

## Error Handling Principles

1. **Connection failure**: tell the user exactly which step failed and give troubleshooting suggestions (check service status, port, network)
2. **4xx response**: the proxy is reachable but returned a business error. Show the full response body and help the user determine whether it's a wrong key, an unsupported model, or something else
3. **File permissions**: before writing, check that the directory exists and is writable; dsh needs chmod
4. **Don't guess**: if information is missing or the state is unclear, ask the user instead of assuming

## Notes

- Configure only one agent at a time; when done, tell the user they can run it again to configure other agents
- The script automatically backs up the original config file as `.bak.<timestamp>`
- All of CC's model environment variables (HAIKU/SONNET/OPUS/SUBAGENT) are set to the model the user chose
- Codex must be switched to Plan mode (Shift+Tab) before the first conversation; this is a client limitation
- dsh's URL has no `/v1`; this is hardcoded in the client
- For OpenClaw, x-conversation-id must be changed manually for each new conversation
