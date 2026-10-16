# memory-tdai CLI

The `openclaw memory-tdai` command namespace, providing offline data management tools.

## seed — Import Historical Conversation Data

Imports a historical conversation JSON file into the memory pipeline and runs the full L0→L1→L2→L3 flow. Use it to:

- Load existing conversation data into the memory system
- Batch-test memory extraction quality
- Migrate/restore memory data

### Usage

```bash
openclaw memory-tdai seed --input <file> [options]
```

### Options

| Option | Required | Description |
|------|------|------|
| `--input <file>` | ✅ | Path to the input JSON file |
| `--output-dir <dir>` | — | Output directory (defaults to an auto-generated timestamped directory) |
| `--session-key <key>` | — | Fallback session key (used when the input data lacks one) |
| `--config <file>` | — | Config override file (JSON, deep-merged with the plugin config in openclaw.json) |
| `--strict-round-role` | — | Strictly require every round to contain both user and assistant messages |
| `--yes` | — | Skip interactive confirmations (e.g. confirming timestamp auto-fill) |

### Examples

```bash
# Basic usage
openclaw memory-tdai seed --input conversations.json

# Specify the output directory
openclaw memory-tdai seed --input data.json --output-dir ./seed-output

# Use a custom config override (e.g. tune pipeline parameters)
openclaw memory-tdai seed --input data.json --config seed-config.json

# Skip all confirmations
openclaw memory-tdai seed --input data.json --yes

# Strict mode + custom config
openclaw memory-tdai seed --input data.json --config seed-config.json --strict-round-role --yes
```

### Input File Format

Two JSON formats are supported:

#### Format A: Object Wrapper

```json
{
  "sessions": [
    {
      "sessionKey": "user-alice",
      "sessionId": "conv-001",
      "conversations": [
        [
          { "role": "user", "content": "Hello", "timestamp": 1711929600000 },
          { "role": "assistant", "content": "Hi! How can I help you?", "timestamp": 1711929601000 }
        ],
        [
          { "role": "user", "content": "What's the weather like today?" },
          { "role": "assistant", "content": "It's sunny today, a good day to go out." }
        ]
      ]
    }
  ]
}
```

#### Format B: Top-Level Array

```json
[
  {
    "sessionKey": "user-alice",
    "conversations": [
      [
        { "role": "user", "content": "Hello" },
        { "role": "assistant", "content": "Hi!" }
      ]
    ]
  }
]
```

#### Field Reference

| Field | Type | Required | Description |
|------|------|------|------|
| `sessionKey` | string | ✅ | Session identifier (e.g. user ID, channel name) |
| `sessionId` | string | — | Conversation instance ID (one sessionKey can have multiple sessionIds) |
| `conversations` | message[][] | ✅ | Array of conversation rounds; each round is a group of messages |
| `role` | string | ✅ | Message role: `user` or `assistant` |
| `content` | string | ✅ | Message content |
| `timestamp` | number \| string | — | Timestamp: epoch milliseconds or an ISO 8601 string. If missing, seed offers to auto-fill it |

### Config Override

`--config` takes a JSON file that is **deep-merged two levels deep** with the plugin config in `openclaw.json`:

- If a top-level key is an object on both sides → shallow merge (fields in base that aren't overridden are kept)
- Any other type → replaced outright

Common case: use more aggressive pipeline parameters during seed to speed up processing:

```json
{
  "pipeline": {
    "everyNConversations": 3,
    "enableWarmup": false,
    "l1IdleTimeoutSeconds": 2,
    "l2DelayAfterL1Seconds": 1,
    "l2MinIntervalSeconds": 1,
    "l2MaxIntervalSeconds": 10
  }
}
```

To seed into a separate TCVDB database:

```json
{
  "storeBackend": "tcvdb",
  "tcvdb": {
    "database": "my_seed_test_db"
  },
  "pipeline": {
    "everyNConversations": 3,
    "enableWarmup": false,
    "l1IdleTimeoutSeconds": 2
  }
}
```

### Output Directory Structure

```
<output-dir>/
├── conversations/          — L0 JSONL files
├── records/                — L1 JSONL files
├── scene_blocks/           — L2 scene blocks
├── vectors.db              — SQLite vector database (sqlite backend only)
├── .metadata/
│   ├── manifest.json       — Metadata (store binding + seed run record)
│   └── checkpoint.json     — Pipeline progress
└── .backup/                — Rolling backups
```

After seed finishes, `manifest.json` records information about the run:

```json
{
  "version": 1,
  "createdAt": "2026-04-01T22:00:00.000Z",
  "store": {
    "type": "sqlite",
    "sqlite": { "path": "vectors.db" }
  },
  "seed": {
    "inputFile": "conversations.json",
    "sessions": 3,
    "rounds": 42,
    "messages": 128,
    "startedAt": "2026-04-01T22:00:00.000Z",
    "completedAt": "2026-04-01T22:05:30.000Z"
  }
}
```
