# Opik → Memory Core Skill Import Tool (Python)

**Uses only the Python standard library, no third-party dependencies.** Runs directly on Python 3.9+.

## Three subcommands

- `list-projects` — list Opik projects only
- `fetch` — pull data from Opik and aggregate it into local session JSON files (does not write to core)
- `import` — load local session files into Memory Core

**Recommended: run fetch and import separately.** Once fetch finishes you can disconnect from Opik and let import run at its own pace. Import supports resume (on by default): if it dies halfway, rerunning only fills in the remainder.

## Relationship to the TS version (`../import-opik-to-memory-skill/`)

| Aspect | TS version | Python version |
|---|---|---|
| Fetch vs. load | One step | **Two separate steps** (fetch → import) |
| Dependencies | Node ≥ 22.16 + `npm install` | Python 3.9+, zero dependencies |
| Load batching | Packed by bytes/count | **Batched per "conversation turn"** (one user message plus the assistant/tool_call/tool_result messages that follow it) |
| Load pacing | As fast as possible | Sleep per turn (default 3s); Opik global rate limit 500ms |
| Resume | Yes | **Yes for import, per-session granularity** |
| Extraction output stats | Polls `skill/list` until it converges | Not checked; view output in the UI or via `/v3/skill/list` |

## Prerequisites

- Python 3.9+
- Opik REST API reachable
- Memory Core Gateway business endpoints (`/v3/skill/*`) reachable
- Skill extraction and the LLM are running on the Memory Core side (otherwise there is no output)
- `team_id` + `agent_id` are registered in the metadata layer
  - ⚠️ The agent id is `agt-xxx`, not `apt-xxx`. The `asset_id` returned by metadata `/api/v1/meta/asset/list-accessible` is `skl-*` (the skill primary key); to find the corresponding `agent_id`, look up `owner_agent_id` via core's `/v3/skill/list`

## Only secrets come from environment variables; everything else is a CLI argument

This is deliberate: env vars are easy to get wrong, forget to unset, or leak into other processes. Identity arguments (`--team-id / --agent-id / --user-id / --service-id / --memory-url / --opik-url`) **must be given explicitly on the command line**, so every invocation shows which environment it targets.

Secrets are read only from environment variables, never from CLI arguments (to keep them out of shell history and `ps aux`):

```bash
export MEMORY_CORE_API_KEY='ck_xxx.xxx'
# Only needed when Opik auth is enabled:
# export OPIK_API_KEY='...'
# export OPIK_AUTH_SCHEME='Bearer'
```

> `user_id` / `team_id` / `agent_id` / `session_id` must not contain `|` (the Redis queue element separator). The script validates this at startup.

## Usage

### 1. List Opik projects

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py list-projects \
  --opik-url 'http://<opik-host>:5173'
```

No Memory Core arguments or secrets required.

### 2. Fetch: pull data from Opik to local disk only

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py fetch \
  --opik-url 'http://<opik-host>:5173' \
  --project '3367b740' \
  --out-dir ./opik-dump-3367b740
```

- `--project` accepts an exact id, exact name, id prefix, or name prefix
- The output directory contains one `.json` file per session (`session_id + .json`, with illegal characters replaced by `-`)
- The directory also contains a `manifest.json` recording the project id, trace count, session count, and fetch time
- Existing files are skipped by default; add `--overwrite` to overwrite them

**Important:** fetch only loads Opik, not Memory Core. The two are decoupled.

### 3. Import: load from the local directory into Memory Core

```bash
MEMORY_CORE_API_KEY='ck_xxx.xxx' \
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir ./opik-dump-3367b740 \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id  team-xxx \
  --agent-id agt-xxx \
  --user-id  usr-xxx \
  --task-id  opik-import-2026-08 \
  --concurrency 5 \
  --turn-gap-ms 2000
```

On the first run you will see a rough ETA (the script prints these log lines in Chinese; English gloss below):

```
[import] 总 sessions=87 (已完成 0, 待办 87) 总 turns=412 待办 turns=412
[import] 并发=5 turn-gap=2000ms → 粗略 ETA ~2m44s（HTTP 耗时另计）
```

Gloss: `total sessions=87 (done 0, pending 87) total turns=412 pending turns=412` and `concurrency=5 turn-gap=2000ms → rough ETA ~2m44s (HTTP time not included)`.

While running, one progress line is printed each time a session completes:

```
[progress] sessions 12/87  turns 68/412  elapsed 34s  ETA ~2m5s
```

The checkpoint is saved to `--in-dir/.import-state.json` (override with `--state-file`). If the run dies, rerunning automatically skips completed sessions; to force a full reload, add `--no-resume`.

### Dry-run

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir ./opik-dump-3367b740 \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id  team-xxx --agent-id agt-xxx --user-id usr-xxx \
  --dry-run
```

Sends nothing to core and writes no checkpoint; it only runs the grouping logic once. Dry-run still requires the identity arguments (the script reads them for validation and ETA calculation).

## Argument reference

### `fetch`

| Argument | Default | Description |
|---|---:|---|
| `--project` | **required** | id / name / prefix |
| `--out-dir` | **required** | Output directory |
| `--max-traces` | 0 | Max number of traces to pull from Opik (0 = unlimited) |
| `--max-sessions` | 0 | Keep only the first N sessions |
| `--page-size` | 100 | Opik page size |
| `--opik-request-gap-ms` | 500 | Minimum interval between Opik requests (protects Opik) |
| `--include-system` | off | Keep system messages (dropped by default) |
| `--overwrite` | off | Overwrite existing files |

### `import`

| Argument | Default | Description |
|---|---:|---|
| `--in-dir` | **required** | Directory produced by fetch |
| `--max-sessions` | 0 | Load only the first N sessions |
| `--concurrency` | 2 | Max concurrency across different sessions |
| `--turn-gap-ms` | 3000 | Interval between turns within a session |
| `--no-force-archive` | off | Skip the trailing force-archive |
| `--dry-run` | off | Read only, no writes |
| `--state-file` | `<in-dir>/.import-state.json` | Checkpoint file |
| `--no-resume` | off | Ignore the checkpoint |

## Data flow

```
Opik /projects
    ↓ (select project)
Opik /traces?project_id=...   (paginated; global rate limit of 500ms per request)
    ↓
Aggregate by thread_id → per thread keep only the trace with the most messages (cumulative snapshot)
    ↓
Local JSON file: <out-dir>/<session_id>.json
    ↓ (fetch ends; Opik can be disconnected now)
    ↓ (import starts)
Read local files → split each session into "conversation turns"
    ↓
Run different sessions concurrently with concurrency=N; serial within a session
    ↓
POST /v3/skill/conversation/add per turn (same session_id)
    ↓ sleep turn-gap-ms
    ↓
Fallback force-archive → record in checkpoint
```

**Key points:**
- A session always uses the same `session_id`; only one turn is pushed per request
- Sleep between turns within a session (default 3s); different sessions run concurrently
- Global minimum interval for Opik fetches (default 500ms)
- Import checkpoints are per session; if a turn within a session fails, it warns and continues with the next turn

## Extraction thresholds

The server-side `add-handler` triggers archiving when any of these conditions is met:

| Condition | Threshold |
|---|---:|
| Cumulative `tool_call` count | 10 |
| Cumulative bytes | 40 KB |
| Bytes in a single request | ≥ 40 KB triggers immediate compression and archiving |

If a session has few tool_calls and short content, only the `force-archive` call archives it; if the extractor decides it is "not worth keeping", you get 0 skills. This is a **normal result**.

## Quick check (1 session, end-to-end smoke test)

```bash
# fetch 1 session
python3 scripts/import-opik-to-memory-skill-py/import_opik.py fetch \
  --opik-url 'http://<opik-host>:5173' \
  --project '019ed0c0' --out-dir /tmp/opik-smoke \
  --max-sessions 1 --max-traces 20

# load into core
MEMORY_CORE_API_KEY='ck_xxx.xxx' \
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir /tmp/opik-smoke \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id team-xxx --agent-id agt-xxx --user-id usr-xxx \
  --turn-gap-ms 1000
```

## Known limitations

- No filtering of evaluation data such as SWE-bench (avoid those projects manually when selecting)
- Extraction output is not checked; look at the UI / `/v3/skill/list` later yourself
- A failed turn within a session warns and continues, with no rollback of the whole session. (Will rerunning the same session avoid re-archiving since the content is identical? No, it will archive again: checkpoints are per session and not subdivided within a session. If many turns fail, delete that session's checkpoint entry and rerun.)
