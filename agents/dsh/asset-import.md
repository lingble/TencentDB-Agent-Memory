# DeepSeek Harness Asset Import

Imports the local dsh **skills / sessions** into Memory Hub. This guide is all you need.

Data root is `$DSH_HOME` (default `~/.dsh`). Project root = the nearest ancestor containing `.git`; if none is found, `--workspace` / cwd is used.

## What gets scanned

**Skills** (for duplicate names, the lower rank number wins; only one level is scanned, no recursive `**/SKILL.md`)

| Rank | Path |
|---|---|
| 100 | `<project root>/.dsh/skills/` |
| 200 | `<project root>/.agents/skills/` |
| 300 | `customSkillDirs` in `settings.yaml`, or `DSH_CUSTOM_SKILL_DIRS` |
| 400 | `$DSH_HOME/skills/` (skips `.system`) |
| 500 | `~/.agents/skills/` (root can be changed with `DSH_AGENTS_HOME`) |
| 600 | `$DSH_BUNDLED_SKILL_DIR` / settings `bundledSkillDir` (skipped if not configured) |

Either directory-style `<name>/SKILL.md` or flat `<name>.md`.

**Memory**: local files are no longer scanned; memory is extracted only from Sessions (see below).

**Sessions**

Recursively scans `$DSH_HOME/sessions/**/session.jsonl.zstd` (or `session.jsonl` if uncompressed). `--workspace` does not affect sessions; `--sessions` changes the scan root. Only `user/message` + `assistant/message` are parsed; empty sessions are skipped.

## Prerequisites

Run from the repo root. Requires Node >= 22, plus:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<the agent owner's sk-mem-...>
# Optional: DSH_HOME / DSH_AGENTS_HOME / DSH_CUSTOM_SKILL_DIRS / DSH_BUNDLED_SKILL_DIR
```

`--agent-id` / `--team-id` are required.

## Usage

The unified entry point is `agents/asset-import.ts` at the repo root. Use `--source dsh` to select the IDE this guide covers; if omitted, it defaults to `auto`, which detects the IDE used by the current workspace.

```bash
# Interactive import: first lists the pending items — skills (number/name/description/source/linked script count) and sessions (id/time range/project path), then prompts you to choose 「全导入 / 不导入 / 部分导入」 ("Import all / Import none / Partial import"); for partial import, enter numbers or IDs separated by commas/spaces, multiple allowed
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid>

# Non-interactive (scripts/CI: imports everything directly, no prompts)
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid> -y

# Specify the project directory
tsx agents/asset-import.ts --source dsh --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Re-import (ignore resume checkpoints, re-import already imported items)
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid> --force

```


