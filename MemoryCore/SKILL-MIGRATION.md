---
name: openclaw-memory-tencentdb-migration
description: Help existing users migrate the OpenClaw memory plugin from the old package @tdai/memory-tdai to the new package @tencentdb-agent-memory/memory-tencentdb. Trigger when the user mentions "plugin migration", "changing the memory plugin package name", "memory-tdai upgrade", "package rename", or hits install errors related to the old package.
version: 1.0.0
---

## Purpose

Help existing users who installed `@tdai/memory-tdai` (old package name) migrate smoothly to `@tencentdb-agent-memory/memory-tencentdb` (new package name), making sure no existing memory data is lost and the configuration is fully restored.

## Background

- **Old package name**: `@tdai/memory-tdai` (plugin ID: `memory-tdai`)
- **New package name**: `@tencentdb-agent-memory/memory-tencentdb` (plugin ID: `memory-tencentdb`)
- The old and new plugins share the same data directory (`~/.openclaw/memory-tdai/`). Uninstalling the old plugin **does not delete the data directory**, so existing memory data is unaffected
- Uninstalling the old plugin **does delete** its config section in `openclaw.json`, so back it up first

## When to use

- The user has `@tdai/memory-tdai` installed and needs to move to the new package name
- `openclaw plugins install @tdai/memory-tdai` fails with 404 / not found
- The user has been told the old package is deprecated and needs to migrate

## When not to use

- The user has never installed a memory plugin (use the `openclaw-memory-tencentdb-setup` skill instead)
- The user is on a different memory plugin (e.g. `openclaw-mem0`)

## Standard workflow

### 1) Confirm the current state

Check whether the old plugin is installed:

```bash
openclaw plugins list | grep -i memory
```

You should see `memory-tdai` or `@tdai/memory-tdai` in the loaded state.

If the old plugin isn't listed, skip the migration and do a fresh install with the `openclaw-memory-tencentdb-setup` skill.

### 2) Back up the existing config (critical step)

Uninstalling the old plugin deletes its config section in `openclaw.json`. **You must back it up first.**

Run the following to extract the old plugin config:

```bash
cat ~/.openclaw/openclaw.json | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
plugins = cfg.get('plugins', {}).get('entries', {})
old_cfg = plugins.get('memory-tdai', {})
if old_cfg:
    print(json.dumps(old_cfg, indent=2, ensure_ascii=False))
    with open('/tmp/memory-tdai-config-backup.json', 'w') as f:
        json.dump(old_cfg, f, indent=2, ensure_ascii=False)
    print('\n✅ Config backed up to /tmp/memory-tdai-config-backup.json')
else:
    print('⚠️ No memory-tdai config section found (possibly using defaults)')
"
```

**Pay particular attention to whether the following settings exist (record them if present)**:

- `embedding` config (`provider`, `baseUrl`, `apiKey`, `model`, `dimensions`, `proxyUrl`)
- `extraction.model` (model used for extraction)
- `persona.model` (model used for the persona)
- `capture.excludeAgents` (list of excluded agents)
- `capture.l0l1RetentionDays` (data retention in days)

### 3) Confirm the data directory exists

```bash
ls -la ~/.openclaw/memory-tdai/
```

You should see files such as `conversations/`, `records/`, `scene_blocks/`, `vectors.db`, `persona.md`.

Record the current data volume as a baseline for post-migration verification:

```bash
echo "=== Pre-migration data stats ==="
wc -l ~/.openclaw/memory-tdai/conversations/*.jsonl 2>/dev/null || echo "No conversation data"
wc -l ~/.openclaw/memory-tdai/records/*.jsonl 2>/dev/null || echo "No record data"
ls ~/.openclaw/memory-tdai/scene_blocks/*.md 2>/dev/null | wc -l | xargs -I{} echo "Scene blocks: {}"
wc -c ~/.openclaw/memory-tdai/persona.md 2>/dev/null || echo "No persona"
```

### 4) Uninstall the old plugin

```bash
openclaw plugins uninstall memory-tdai
```

Afterwards, confirm:

- The `memory-tdai` config section in `openclaw.json` has been removed (expected)
- The `~/.openclaw/memory-tdai/` data directory **still exists** (it is not deleted)

```bash
# Verify the data directory is still there
ls ~/.openclaw/memory-tdai/ && echo "✅ Data directory intact" || echo "❌ Data directory missing!"
```

### 5) Install the new plugin

```bash
openclaw plugins install @tencentdb-agent-memory/memory-tencentdb
```

### 6) Restore the config

Write the config backed up in step 2 back into `openclaw.json`. Note that the new plugin's config key is `memory-tencentdb`:

```bash
python3 -c "
import json, os

# Read the backed-up config
backup_path = '/tmp/memory-tdai-config-backup.json'
if os.path.exists(backup_path):
    with open(backup_path) as f:
        old_cfg = json.load(f)
    print('📋 Backed-up config:')
    print(json.dumps(old_cfg, indent=2, ensure_ascii=False))
else:
    old_cfg = {'enabled': True}
    print('⚠️ No backup found, using minimal config')

# Read the current openclaw.json
config_path = os.path.expanduser('~/.openclaw/openclaw.json')
with open(config_path) as f:
    cfg = json.load(f)

# Write the new plugin config
cfg.setdefault('plugins', {}).setdefault('entries', {})['memory-tencentdb'] = old_cfg

with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

print('\n✅ Config written to memory-tencentdb')
"
```

If the backup is lost or the user needs to restore manually, at least write the minimal config:

```json
{
  "memory-tencentdb": {
    "enabled": true
  }
}
```

### 7) Restart the Gateway and verify

```bash
openclaw gateway restart
```

Checks:

- The `[memory-tdai]` prefix appears in the Gateway logs (note: the log tag is still memory-tdai; this is expected)
- The data directory contents are unchanged

```bash
echo "=== Post-migration verification ==="
# Confirm the new plugin is loaded
openclaw plugins list | grep -i memory

# Confirm the data volume matches the pre-migration baseline
wc -l ~/.openclaw/memory-tdai/conversations/*.jsonl 2>/dev/null
wc -l ~/.openclaw/memory-tdai/records/*.jsonl 2>/dev/null
```

### 8) Functional smoke test

Run one conversation to confirm the memory pipeline works:

1. Send a message containing personal information (e.g. preferences, habits)
2. Confirm the logs contain `[before_prompt_build]` and `[agent_end]` output
3. If embedding is configured, confirm vector search works (no embedding errors in the logs)

## Rollback plan

If problems appear after migration, roll back quickly:

```bash
# 1. Uninstall the new plugin
openclaw plugins uninstall memory-tencentdb

# 2. Reinstall the old plugin (if the npm source is still available)
openclaw plugins install @tdai/memory-tdai

# 3. Restore the config manually (from the backup)
# Write the contents of /tmp/memory-tdai-config-backup.json back into the memory-tdai section of openclaw.json

# 4. Restart
openclaw gateway restart
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|------|----------|----------|
| No log output from the new plugin | `enabled` not set to `true` in the config | Check `memory-tencentdb.enabled` in `openclaw.json` |
| Error installing the new plugin | npm source unavailable | Check network / npm registry config |
| No historical memories after migration | Config restore incomplete | Compare `/tmp/memory-tdai-config-backup.json` with the current config |
| Embedding errors | `apiKey` or other config lost | Restore the `embedding` section from the backup |
| Data directory empty | Unexpected deletion during uninstall (very rare) | Check whether `~/.openclaw/memory-tdai/` exists |

## Security and compliance constraints

- The backup file `/tmp/memory-tdai-config-backup.json` may contain an `apiKey`; delete it after the migration: `rm /tmp/memory-tdai-config-backup.json`
- Never show `apiKey` in plain text in chat or logs
- Modify only the `memory-tencentdb` config section; don't affect the user's other plugins

## Definition of Done

The migration is complete only when all of the following hold:

- [x] The old plugin `@tdai/memory-tdai` is uninstalled
- [x] The new plugin `@tencentdb-agent-memory/memory-tencentdb` is installed and loaded
- [x] `openclaw.json` contains a complete `memory-tencentdb` config (including user-customized embedding and other settings)
- [x] The Gateway has been restarted
- [x] The `[memory-tdai]` prefix appears in the logs
- [x] The data directory is intact and the data volume matches the pre-migration baseline
- [x] At least 1 conversation verified the memory pipeline works
- [x] Sensitive information in the backup file has been cleaned up

## Delivery message template

> Memory plugin migration complete:
> - Old plugin `@tdai/memory-tdai` → new plugin `@tencentdb-agent-memory/memory-tencentdb`
> - Existing memory data fully preserved (conversations / records / scene blocks / vector store all unaffected)
> - Config fully restored from the old plugin (including custom embedding / extraction / persona settings)
> - Gateway restarted and the memory pipeline verified
