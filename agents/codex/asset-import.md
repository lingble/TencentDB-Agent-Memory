# Codex Asset Import

Import the local Codex **skills / sessions** on this machine into Memory Hub. This guide is all you need.


Data root: `$CODEX_HOME` (default `~/.codex`).

## What Gets Scanned

| Type | Path |
|---|---|
| Skill | USER `$HOME/.agents/skills/*/SKILL.md`; `.agents/skills` from the git root down to cwd; ADMIN `/etc/codex/skills` |
| Session | `$CODEX_HOME/sessions/**/*.jsonl` (`YYYY/MM/DD/rollout-*.jsonl`) |

Not scanned: `~/.codex/skills`, the repo top-level `skills/`, `plugins/cache`, in-repo `memories/`.

`--sessions <dir>` switches scanning to `.jsonl` and Responses `.json` files. Without `--sessions`, `$CODEX_HOME/sessions` is still scanned automatically.

## Prerequisites

Run from the repo root. Requires Node >= 22, plus:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<sk-mem-... of this agent's owner>
# Optional: export CODEX_HOME=/path/to/.codex
```

`--agent-id` / `--team-id` are required; the owner must equal the user resolved from `TDAI_USER_KEY`.

## Usage

The single entry point is `agents/asset-import.ts` at the repo root. Use `--source codex` to select the IDE this guide covers; if omitted, it defaults to `auto`, which detects the IDE used by the current workspace.

```bash
# Interactive import: first lists the items to import — skills (number/name/description/source/linked script count) and sessions (id/time range/project path) — then prompts `请选择导入方式: 1=全导入 2=不导入 3=部分导入 ? ` ("Choose import mode: 1=import all 2=import none 3=partial import"). For partial import, enter numbers or IDs, comma/space separated, multiple allowed
tsx agents/asset-import.ts --source codex --agent-id <id> --team-id <tid>

# Non-interactive (scripts/CI: imports everything without prompting)
tsx agents/asset-import.ts --source codex --agent-id <id> --team-id <tid> -y

# Specify the project directory
tsx agents/asset-import.ts --source codex --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Specify a history session directory/file (overrides auto-scan)
tsx agents/asset-import.ts --source codex --sessions /path/to/sessions --agent-id <id> --team-id <tid>

# Re-import (ignore resume checkpoints and re-import already imported items)
tsx agents/asset-import.ts --source codex --agent-id <id> --team-id <tid> --force

```



