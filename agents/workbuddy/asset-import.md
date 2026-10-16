# WorkBuddy Asset Import

Import the local WorkBuddy **skills / sessions** into Memory Hub. This guide is all you need.

The desktop data directory defaults to `~/.workbuddy`.

## What gets scanned

| Type | Path |
|---|---|
| Skill | `~/.workbuddy/skills/*/SKILL.md`; project `.workbuddy/skills` or `workbuddy/skills` |
| Session | jsonl files of OpenAI-style messages under the project |

`--workspace` changes the project-side paths to that directory (the global `~/.workbuddy` is still scanned).

## Prerequisites

Run from the repo root. Requires Node >= 22, plus:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<the agent owner's sk-mem-...>
```

`--agent-id` / `--team-id` are required; the owner must match the user resolved from `TDAI_USER_KEY`.

## Usage

The single entry point is `agents/asset-import.ts` at the repo root. Use `--source workbuddy` to select the IDE this guide covers; if omitted, it defaults to `auto`, which detects the IDE used by the current workspace.

```bash
# Interactive import: first lists the candidates — skills (index/name/description/source/linked script count) and sessions (id/time range/project path) — then prompts for "全导入 / 不导入 / 部分导入" (import all / import none / partial import); for partial import, enter indexes or IDs, comma/space separated, multiple allowed
tsx agents/asset-import.ts --source workbuddy --agent-id <id> --team-id <tid>

# Non-interactive (scripts/CI: imports everything without prompting)
tsx agents/asset-import.ts --source workbuddy --agent-id <id> --team-id <tid> -y

# Specify the project directory
tsx agents/asset-import.ts --source workbuddy --workspace /path/to/project --agent-id <id> --team-id <tid>

# Re-import (ignore resume checkpoints and re-import already imported items)
tsx agents/asset-import.ts --source workbuddy --agent-id <id> --team-id <tid> --force

```


