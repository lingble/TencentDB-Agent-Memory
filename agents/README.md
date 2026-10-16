# Agents

Memory Proxy currently supports 7 kinds of AI Agent clients. They differ significantly in protocol, session-initialization method, and injection logic.

> 🛠 **Want to integrate a new AI Agent client (not in the table below)?**
> Read the [**New Client Adapter Development Guide →**](./adapter-agent-development.md)
> It covers everything from "capture traffic and survey the client" through "proxy-side routing / adapter / session-init changes" to "end-to-end e2e passing": a 20-item checklist, a quick reference for 8 common pitfalls, and a dsh reference implementation you can copy.

## Quick Start

### Option 1: Run the script manually

```bash
cd <repo root>
bash agents/setup-proxy.sh
```

An interactive wizard walks you step by step through configuring an Agent to use the Proxy:
1. Automatically scans existing configuration (reused if present, no need to re-enter)
2. Select the Agent to configure
3. Enter the model ID
4. Health probe (verifies Proxy connectivity)
5. Write the config file (the original is automatically backed up as `.bak`)
6. Optional: import local skills/conversations into team memory

All 6 Agents are supported. Configure one per run; run it multiple times to configure different Agents.

### Option 2: AI Agent-assisted configuration (Skill)

Let an AI Agent such as Claude Code / CodeBuddy guide you through configuration using the skill. The agent probes the environment, verifies connectivity, and makes choices dynamically step by step.

#### Step 1: Copy the agents directory into your home directory

```bash
cd <repo root>
cp -r agents ~/agents
```

#### Step 2: Use one of the following prompts in the AI Agent conversation

> Note: the agent must `cd ~/agents` before running the script.

**Configure a new Agent to use the Proxy:**

```
Please read the skill document ~/agents/skills/setup-proxy/SKILL.md, then follow its steps to guide me through configuring an Agent to use Memory Proxy.
```

**Configure a specific Agent (e.g. Claude Code):**

```
Please read ~/agents/skills/setup-proxy/SKILL.md and help me configure Claude Code to use Memory Proxy. My proxy address is http://localhost:8096 and the instance ID is default.
```

**Configure OpenClaw (requires header pre-selection):**

```
Please read ~/agents/skills/setup-proxy/SKILL.md and help me configure OpenClaw to use Memory Proxy. The panel address is http://localhost:8125; pull the team/agent list from the panel so I can choose.
```

**Health probe only (no config written):**

```
Please read ~/agents/skills/setup-proxy/SKILL.md and help me probe whether the proxy at http://localhost:8096 is healthy, using the codebuddy protocol and model claude-opus-4.7.
```

> ℹ️ The skill file is at `agents/skills/setup-proxy/SKILL.md`, with its companion script `agents/skills/setup-proxy/setup-proxy.sh`. The Agent collects information and verifies the environment step by step, then calls the script in `--non-interactive` mode to write the configuration.

---

Each subdirectory corresponds to one agent and contains:
- `README.md` — integration config, adaptation approach, Session Init flow, FAQ
- `asset-import.md` — import that client's local skills / memory / sessions into Memory Hub (single-file manual)
- `asset-import.ts` — that client's disk-scan implementation; the unified entry point is `agents/asset-import.ts` at the repo root, with `--source <name>` selecting the IDE
- May later hold: adaptation notes, debug scripts, capture fixtures, etc.

---

## Quick Comparison Table

| Agent | Protocol | Session Init Method | Form Tool | Pagination | Default/Plan Gate | Headless Bypass |
|-------|------|-------------------|-----------|------|-------------------|-----------------|
| [Claude Code](./claude-code/) | Anthropic Messages | Interactive Form | `AskUserQuestion` | ✅ (max 4) | ❌ | ❌ |
| [CodeBuddy](./codebuddy/) | OpenAI Chat Completions | Interactive Form | `ask_followup_question` | ❌ (no limit) | ❌ | ❌ |
| [Codex](./codex/) | OpenAI Responses API | Interactive Form + Default Gate | `request_user_input` | ✅ | ✅ | ❌ |
| [WorkBuddy](./workbuddy/) | Responses (Desktop) / Chat (Web) | Interactive Form | `AskUserQuestion` | ✅ (max 4) | ✅ | ✅ (silent passthrough) |
| [dsh (DeepSeek Harness)](./dsh/) | OpenAI Chat Completions | Interactive Form + Headless Bypass | `ask_user_question` | ❌ (no limit) | ❌ | ✅ (when no tool) |
| [OpenClaw](./openclaw/) | OpenAI Chat Completions | Header pre-selection (no Form) | N/A | N/A | N/A | ✅ (when headers missing) |

---

## Local Asset Import

Import each client's on-disk skills / memory / historical sessions into Memory Hub. There is one scanner file per client, and you can run it directly:

```bash
# Interactive import (after starting, asks y/N for skill / memory / session one by one)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid>

# Non-interactive full import (scripts/CI)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid> -y
```


| Agent | Manual |
|-------|------|
| Claude Code | [asset-import.md](./claude-code/asset-import.md) |
| CodeBuddy | [asset-import.md](./codebuddy/asset-import.md) |
| Codex | [asset-import.md](./codex/asset-import.md) |
| WorkBuddy | [asset-import.md](./workbuddy/asset-import.md) |
| dsh | [asset-import.md](./dsh/asset-import.md) |
| OpenClaw | [asset-import.md](./openclaw/asset-import.md) |

---

## Session ID Header Quick Reference

| Agent | Primary Header | Fallbacks |
|-------|-----------|------|
| Claude Code | `x-claude-code-session-id` | `x-session-id`, `x-conversation-id` |
| CodeBuddy | `x-conversation-id` | `x-session-id`, `x-cb-session-id`, `x-codebuddy-session-id` |
| Codex | `session-id` | `body.client_metadata.session_id` |
| WorkBuddy | `session-id` | `body.client_metadata.session_id` |
| dsh | `x-deepseek-harness-session-id` | `x-session-id` |
| OpenClaw | `x-conversation-id` | — (statically configured by the user) |

---

## Client Configuration Methods

| Agent | Method | Config File / Variables | Key Delivery |
|-------|----------|-----------------|----------|
| Claude Code | Environment variables or config file | `~/.claude/settings.json` or env `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | env / JSON `env.ANTHROPIC_AUTH_TOKEN` |
| CodeBuddy | Config file | `~/.codebuddy/models.json` | JSON `apiKey` |
| Codex | Config file | `~/.codex/config.toml` | TOML `experimental_bearer_token` |
| WorkBuddy | Config file | `~/.workbuddy/models.json` | JSON `apiKey` |
| dsh | Config file | `~/.dsh/settings.yaml` + `.credentials.yaml` | YAML environment-variable reference |
| OpenClaw | Config file | `~/.openclaw/openclaw.json` | JSON `apiKey` + headers |

---

## Routing Rules

```
/:agent/:spaceId/v1/messages          → Anthropic protocol (CC, CB-Anthropic)
/:agent/:spaceId/v1/chat/completions  → OpenAI Chat (CB, WB-web, dsh, OpenClaw)
/:agent/:spaceId/chat/completions     → OpenAI Chat without v1 prefix (dsh)
/:agent/:spaceId/v1/responses         → Responses API (Codex, WB-desktop)
/:agent/:spaceId/responses            → Responses API without v1 prefix (Codex, WB-desktop)
```

---

## Header Pre-selection (generic, available to all agents)

Besides the interactive Form, **all agents** can complete session registration directly through HTTP headers and skip the form interaction. Useful when:
- The client cannot respond to a form (e.g. OpenClaw)
- You want to skip the form to speed up the first turn (e.g. CI/CD automation)
- Third-party platforms / in-house Agents

### Required Headers

| Header | Description |
|--------|------|
| `Authorization: Bearer <user_key>` | The business user's API Key (obtained from the panel) |
| `x-team-id` | Team ID |
| `x-agent-id` | Agent ID |
| `x-task-id` | Task ID (required in the current version) |
| `x-conversation-id` | Session identifier, generated and managed by the client |

All of the above headers present → the Proxy completes session registration and injects assets directly, with no form.  
Any one missing → falls back to the interactive form (if the client supports it) or session bypass (if it does not).

### Other Platforms

Any OpenAI API-compatible platform can integrate by pointing its API base URL at the Proxy:

```text
http://<proxy-host>:<port>/<agent-source>/<spaceId>
```

- `<agent-source>`: must be one of the values the Proxy supports: `claude-code`, `codebuddy`, `workbuddy`, `codex`, `openclaw`. Other platforms can integrate by posing as one of these (e.g. use `codebuddy`)
- `<spaceId>`: memory instance ID (fixed to `default` for local deployments)

---

## New Agent Integration Overview

1. **Capture traffic** — use mitmproxy to capture 3–5 typical requests (main / aux / title-gen) and store them under `MemoryProxy/docs/<agent>-recon/`
2. **Identify the protocol** — determine the wire protocol (Anthropic / Chat / Responses)
3. **Determine the Session ID source** — find the unique session identifier in headers or body
4. **Choose a Session Init strategy** — has a tool → interactive form; no tool → header pre-selection / headless bypass
5. **Classify auxiliary requests** — identify title-gen / compact / fork and other requests that don't need the full pipeline
6. **Implement a Handler / reuse one** — clients with the same protocol can share a handler (e.g. dsh reuses CB's handleChatCompletions)
7. **Injection Profile** — define the injection template to match the client's system prompt format
8. **E2E verification** — run the full pipeline and confirm session-init + injection + archiving work

👉 **For the full development steps (20-item checklist + 8 pitfall quick reference + dsh reference implementation), see [`adapter-agent-development.md`](./adapter-agent-development.md)**.
