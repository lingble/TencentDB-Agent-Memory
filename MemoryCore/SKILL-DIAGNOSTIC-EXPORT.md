---
name: openclaw-diagnostic-export
description: Help the user export on-site diagnostic data for OpenClaw + the memory-tencentdb (formerly memory-tdai) memory plugin for troubleshooting. Trigger when the user mentions "export diagnostic data", "export diagnostic", "on-site data", "troubleshoot an issue", "export logs", "collect on-site data", or "package on-site data".
version: 1.0.0
---

## Purpose

Package OpenClaw logs, memory plugin data (L0–L3), and the redacted configuration into a local archive, which the user reviews and then manually sends to the R&D team for troubleshooting.

> **Naming note**: The plugin was renamed from `@tdai/memory-tdai` to `@tencentdb-agent-memory/memory-tencentdb`, but the data directory is still `~/.openclaw/memory-tdai/` (hard-coded). Every reference to the `memory-tdai` directory in this skill means the actual data directory path and is unrelated to the plugin ID.

## Export workflow

### Step 1: Check the environment

Before exporting, confirm the OpenClaw working directory exists and is accessible:

```bash
# Detect the working directory (priority: env var > ~/.openclaw > ~/.clawdbot)
OPENCLAW_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
[ -d "$OPENCLAW_DIR" ] || OPENCLAW_DIR="$HOME/.clawdbot"
ls -la "$OPENCLAW_DIR/" 2>/dev/null && echo "✅ Found: $OPENCLAW_DIR" || echo "❌ OpenClaw working directory not found"
```

Confirm the memory-tdai subdirectory exists:

```bash
ls -la "$OPENCLAW_DIR/memory-tdai/" 2>/dev/null
```

### Step 2: Run the export script

Run the export script in the project's `scripts/` directory:

```bash
bash scripts/export-diagnostic.sh
```

> The script lives at `scripts/export-diagnostic.sh` in this project. If you run it via `pnpm` or another way, make sure the working directory is the project root.

By default the script writes the archive to `~/Downloads/openclaw-diagnostic-<timestamp>.tar.gz`.

To use a different output directory:

```bash
bash scripts/export-diagnostic.sh /tmp
```

### Step 3: Check the export result

After the script finishes, check the output:

1. **Confirm the archive was created** — the script prints the archive path and size at the end
2. **Explain the contents to the user**:

| File/directory | Contents | Privacy risk |
|-----------|------|---------|
| `env-info.txt` | OS version, OpenClaw version, directory layout, disk usage | Low |
| `logs/` | OpenClaw gateway logs + rolling logs (last 3 days, at most 5000 lines per file) | Low |
| `memory-tdai/` | Full memory plugin data: L0 conversations, L1 memories, L2 scenes, L3 persona, SQLite database, checkpoints | **High** — contains the user's raw conversations |
| `openclaw-config-redacted.json` | Redacted config (API keys/tokens/passwords/secrets removed; models/channels/env replaced wholesale) | Low |
| `plugins-info.txt` | Installed plugin list and versions | Low |

3. **Remind the user**:
   - The config file is redacted automatically; API keys, tokens, and other secrets are replaced with `***REDACTED***`
   - **The memory data (memory-tdai/) contains raw user conversations**; confirm it is OK to share before sending
   - The archive stays local and is **not uploaded automatically**; the user must send it to the R&D team manually

### Step 4: Tell the user what to do next

After the export, tell the user:

1. The archive has been saved locally (print the exact path)
2. After reviewing it, send it to the R&D team manually via WeCom, email, or similar
3. If only part of the data is needed (e.g. only logs or only config), extract the archive and send selected files

## Export contents in detail

### OpenClaw log locations

| Log type | Path | Description |
|---------|------|------|
| Gateway stdout | `~/.openclaw/logs/gateway.log` | Gateway daemon standard output |
| Gateway stderr | `~/.openclaw/logs/gateway.err.log` | Gateway daemon error output |
| Rolling log | `/tmp/openclaw/openclaw-YYYY-MM-DD.log` | Rolled daily, JSON Lines format, auto-cleaned after 24h |
| Config audit | `~/.openclaw/logs/config-audit.jsonl` | Audit records of config writes |
| Command log | `~/.openclaw/logs/commands.log` | Command event log (optional hook) |

### Memory plugin data layout

```
~/.openclaw/memory-tdai/
├── conversations/          — L0 raw conversations (daily JSONL shards)
├── records/                — L1 structured memories (daily JSONL shards)
├── scene_blocks/           — L2 scene Markdown files
├── persona.md              — L3 user persona
├── vectors.db              — SQLite database (vectors + full-text index)
├── .metadata/              — checkpoints, scene_index.json
└── .backup/                — rolling backups
```

### Config redaction rules

The export script applies the following redaction to `openclaw.json`:

| Rule | Handling |
|------|---------|
| Field name matches `apiKey/token/password/secret/credential` and the value is a string | Replaced with `***REDACTED(Nchars)***` |
| SecretRef objects (with source/provider/id) | id replaced with `***REDACTED***` |
| Top-level `models`, `secrets`, `channels`, `env` blocks | Replaced wholesale with `***REDACTED_SECTION***` |
| token/password under `gateway.auth` | Replaced with `***REDACTED***` |
| All other fields (including the full `plugins` config) | **Kept as is** (plugin config is the main focus of troubleshooting) |

## Manual export (fallback when the script is unavailable)

If the export script can't run (e.g. Node.js is unavailable), collect the data manually:

```bash
# 1. Create the export directory
EXPORT_DIR=~/Downloads/openclaw-diagnostic-$(date +%Y%m%d-%H%M%S)
mkdir -p "$EXPORT_DIR"

# 2. Copy logs
cp -r ~/.openclaw/logs/ "$EXPORT_DIR/logs/" 2>/dev/null
cp /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log "$EXPORT_DIR/" 2>/dev/null

# 3. Copy memory plugin data
cp -r ~/.openclaw/memory-tdai/ "$EXPORT_DIR/memory-tdai/" 2>/dev/null

# 4. Redact the config manually (⚠️ you must delete sensitive fields by hand!)
# Copy the config, then use an editor to delete the models/secrets/channels blocks and all apiKey/token values
cp ~/.openclaw/openclaw.json "$EXPORT_DIR/openclaw-config-NEEDS-MANUAL-REDACTION.json"

# 5. Package
cd ~/Downloads && tar -czf "$EXPORT_DIR.tar.gz" "$(basename $EXPORT_DIR)"

echo "⚠️ Be sure to manually check and remove sensitive information from the config before sending!"
```

## Common troubleshooting leads

After the data is exported, the R&D team usually looks at:

| Area | File to check | Key information |
|---------|---------|---------|
| Is the plugin loaded? | Search `logs/` for `[memory-tdai]` | Plugin registration and config parsing logs (note: the log tag is still `[memory-tdai]`, unrelated to the plugin ID) |
| Is memory recall working? | Search `logs/` for `[recall]` | Search strategy, latency, hit count |
| Is L1 extraction triggering? | Search `logs/` for `[pipeline]` | Scheduler triggers, L1/L2/L3 execution status |
| Is vector search available? | `plugins.entries` in `openclaw-config-redacted.json` | Whether the embedding config is correct |
| Data volume / disk usage | `env-info.txt` | du output, file counts |
| Checkpoint state | `memory-tdai/.metadata/recall_checkpoint.json` | Progress, cursors, counters |
