# OpenClaw Asset Import

Import the local open-source OpenClaw **skills / sessions** into Memory Hub. This guide is all you need.


This scans the client's native data, not this project's `~/.openclaw/context-offload/*`.

## What gets scanned

**Skill** (on name collisions, user-defined skills override the system's bundled ones)

| Priority | Path |
|---|---|
| 1 | `~/.agents/skills/<name>/SKILL.md` |
| 2 | `~/npm-global/lib/node_modules/openclaw/skills/<name>/SKILL.md` |

May include `scripts/` `references/` `assets/` `agents/`. The workspace, `~/.openclaw/skills` and extraDirs are not scanned.

**Memory**: local files are no longer scanned; memory is extracted only from sessions (see below).

**Session** (`$OPENCLAW_STATE_DIR/agents/<id>/sessions/`, default `~/.openclaw`)

Imports the `<sessionId>.jsonl` files one level down. `sessions.json`, `*.trajectory.jsonl`, `*.lock` and sqlite are not scanned.

## Prerequisites

Run from the repo root. Requires Node >= 22, plus:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<the agent owner's sk-mem-...>
# Optional: OPENCLAW_STATE_DIR / OPENCLAW_WORKSPACE_DIR
```

`--agent-id` / `--team-id` are required; the owner must match the user resolved from `TDAI_USER_KEY`.

## Usage

The single entry point is `agents/asset-import.ts` at the repo root. Use `--source openclaw` to select the IDE this guide covers; if omitted, it defaults to `auto`, which detects the IDE used by the current workspace.

```bash
# Interactive import: first lists the candidates — skills (index/name/description/source/linked script count) and sessions (id/time range/project path) — then prompts for "全导入 / 不导入 / 部分导入" (import all / import none / partial import); for partial import, enter indexes or IDs, comma/space separated, multiple allowed
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid>

# Non-interactive (scripts/CI: imports everything without prompting)
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid> -y

# Specify the project directory
tsx agents/asset-import.ts --source openclaw --workspace /path/to/workspace --agent-id <id> --team-id <tid>

# Re-import (ignore resume checkpoints and re-import already imported items)
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid> --force

```


