---
name: openclaw-memory-tencentdb-setup
description: Install, configure, and verify the @tencentdb-agent-memory/memory-tencentdb plugin in an OpenClaw environment. Trigger when the user mentions "install the memory plugin", "configure memory-tencentdb", "enable long-term memory/recall", or hits related errors.
version: 1.0.0
---

## Purpose

Give OpenClaw durable, local long-term memory (L0→L1→L2→L3) without relying on an externally hosted memory service, and complete the full loop from installation and configuration to acceptance in one pass.

## When to use

- The user asks to install or enable `memory-tencentdb` in OpenClaw
- The user needs to configure recall, extraction, persona, cleanup, or similar parameters
- The user reports "the plugin is installed but there is no memory / no recall / no vector search"

## When not to use

- The user only wants an explanation of the memory concepts, not an actual rollout
- The user wants to integrate a non-OpenClaw host (confirm the target framework first)

## Standard workflow

### 1) Environment pre-check

First confirm the base versions meet the requirements:

- OpenClaw: `>= 2026.3.13`
- Node.js: `>= 22.16.0`

Run:

```bash
openclaw --version
node -v
```

If a version is too old, upgrade before continuing.

### 2) Install the plugin

Run the install command:

```bash
openclaw plugins install @tencentdb-agent-memory/memory-tencentdb
```

If it is already installed, update it instead:

```bash
openclaw plugins update memory-tencentdb
```

### 3) Write the minimal configuration

Edit `~/.openclaw/openclaw.json` and make sure it contains:

```json
{
  "memory-tencentdb": {
    "enabled": true
  }
}
```

Note: the plugin supports zero-config startup; the basic capabilities work without any other fields.

### 4) Add recommended configuration as needed (common in production)

Add the following groups based on the user's needs:

- `capture`: conversation capture and retention policy
- `extraction`: L1 extraction and deduplication
- `pipeline`: L1→L2→L3 scheduling
- `recall`: recall count, threshold, strategy
- `persona`: scene and persona trigger parameters
- `embedding`: vector search configuration (remote, OpenAI-compatible)

Recommended template:

```json
{
  "memory-tencentdb": {
    "capture": {
      "enabled": true,
      "excludeAgents": [],
      "l0l1RetentionDays": 90,
      "cleanTime": "03:00"
    },
    "extraction": {
      "enabled": true,
      "enableDedup": true,
      "maxMemoriesPerSession": 10,
      "model": "provider/model"
    },
    "pipeline": {
      "everyNConversations": 5,
      "enableWarmup": true,
      "l1IdleTimeoutSeconds": 600,
      "l2DelayAfterL1Seconds": 10,
      "l2MinIntervalSeconds": 900,
      "l2MaxIntervalSeconds": 3600,
      "sessionActiveWindowHours": 24
    },
    "recall": {
      "enabled": true,
      "maxResults": 5,
      "scoreThreshold": 0.3,
      "strategy": "hybrid"
    },
    "persona": {
      "triggerEveryN": 50,
      "maxScenes": 15,
      "backupCount": 3,
      "sceneBackupCount": 10,
      "model": "provider/model"
    },
    "embedding": {
      "enabled": true,
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${EMBEDDING_API_KEY}",
      "model": "text-embedding-3-small",
      "dimensions": 1536,
      "conflictRecallTopK": 5
    }
  }
}
```

### 5) Key configuration rules (avoid silent failures)

- With `embedding.provider = "none"`, vector capabilities are disabled and only the keyword path remains.
- If you configure a remote `provider` (such as `openai` / `deepseek`), you must also provide all of:
  - `apiKey`
  - `baseUrl`
  - `model`
  - `dimensions`
- If any of these is missing, the plugin keeps running but automatically falls back to non-vector mode.
- `l0l1RetentionDays`:
  - `0` means no cleanup
  - When non-`0`, `>=3` is recommended
  - Setting it to `1~2` requires explicitly enabling `allowAggressiveCleanup`

### 6) Restart and verify

Run:

```bash
openclaw gateway restart
```

Checks:

- The `[memory-tdai]` prefix appears in the Gateway logs
- The data directory has been created: `~/.openclaw/state/memory-tdai/`
- It contains at least: `conversations/`, `records/`, `scene_blocks/`, `vectors.db`

### 7) Functional smoke test

Run one minimal conversation loop and verify:

1. Hold 2–3 consecutive turns that provide memorable information (preferences, constraints, background).
2. Start a new turn and check whether recalled context is injected.
3. From the Agent, call:
   - `tdai_memory_search`
   - `tdai_conversation_search`
4. Confirm the content you just produced can be retrieved.

## Troubleshooting quick reference

- No plugin logs: check that `memory-tencentdb.enabled` is `true` in `openclaw.json`, and confirm the Gateway has been restarted.
- Records exist but no recall: check `recall.enabled` and whether `scoreThreshold` is too high.
- No vector results: check that the `embedding` quadruple (`apiKey/baseUrl/model/dimensions`) is complete.
- Too little history because cleanup is too aggressive: check `l0l1RetentionDays` and `allowAggressiveCleanup`.
- Config changed but behavior didn't: confirm you edited `~/.openclaw/openclaw.json`, then restart the Gateway again.

## Security and compliance constraints

- Treat `apiKey` as sensitive; never expose it in plain text in chat, logs, or screenshots.
- Prefer injecting secrets via environment variables; keep only placeholders in config examples.
- Modify only the `memory-tencentdb` config section; don't overwrite the user's other plugin configs.

## Definition of Done

Before finishing the task, all of the following must hold:

- The plugin install/update command succeeded
- `openclaw.json` contains a valid `memory-tencentdb` config
- The Gateway has been restarted
- `[memory-tdai]` logs are visible
- The data directory and key files have been created
- At least 1 search tool call returned results successfully

## Delivery message template

After finishing, you can tell the user:

- `memory-tencentdb` has been installed and configured, and the Gateway restarted.
- Logs and the data directory are verified, and the memory pipeline is working.
- For further tuning, you can adjust `recall.scoreThreshold`, `pipeline.everyNConversations`, `persona.triggerEveryN`, and the `embedding` model parameters.
