# Opik → Memory Core Import Tool

Converts the Traces under an Opik Project into conversation messages and writes them to L0 through the Memory Core Gateway's `POST /v3/conversation/add`.

## Capabilities

- Automatically paginates through all Opik Projects and all Traces of the selected Projects
- Select projects by Project name or UUID
- Recognizes common Trace structures such as `messages`, `conversation`, `history`, `prompt/response`, and OpenAI `choices`
- Automatically merges input/output messages, removes overlap, and caps single-message and per-batch size
- Pre-checks per Session before writing; when a Session is expected to exceed 40,000 L0 messages, deduplicates across Traces and imports the latest tail snapshot instead
- Supports Dry Run, resume from checkpoint, network retries, and Pipeline throttling
- Secrets are read only from environment variables

## Prerequisites

- Node.js `>= 22.16.0`
- Project dependencies installed
- Opik REST API reachable
- Remote Memory Core Gateway exposes `/health`, `/v3/conversation/add`, and `/v3/conversation/query`
- Target `service_id`, `team_id`, `agent_id`, and `user_id` decided

Enter the Memory Core directory:

```bash
cd MemoryCore
```

Show all options:

```bash
npm run import:opik -- --help
```

## Opik address and pagination

Recommended: configure only the Opik root URL and workspace:

```bash
export OPIK_URL='http://opik.example.com:5173'
export OPIK_WORKSPACE='default'
```

UI URLs are also accepted:

```text
http://opik.example.com:5173/default/projects?size=25
```

The `size=25` in a UI URL does not limit the import scope. The tool converts it to the `/api/v1/private` API address and reads every page automatically using `page` and `size`; `--page-size` defaults to `100`.

## Configure the remote Memory Core

The addresses below are examples only; replace them with your actual Gateway address:

```bash
export MEMORY_CORE_URL='http://memory-core.example.com:8423'
export MEMORY_CORE_SERVICE_ID='default'
export MEMORY_CORE_TEAM_ID='team-001'
export MEMORY_CORE_AGENT_ID='agent-001'
export MEMORY_CORE_USER_ID='user-001'
```

Optional Task isolation:

```bash
export MEMORY_CORE_TASK_ID='task-001'
```

When no Task is needed:

```bash
unset MEMORY_CORE_TASK_ID
```

Enter the API Key securely so it never lands in code or config files:

```bash
read -s "MEMORY_CORE_API_KEY?Memory Core API Key: "
echo
export MEMORY_CORE_API_KEY
```

Check the Gateway:

```bash
curl --fail --silent --show-error "${MEMORY_CORE_URL}/health"
```

## Run a Dry Run first

Dry Run reads from the real Opik and converts Traces, but does not write to Memory Core or the checkpoint file:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-traces 5 \
  --dry-run
```

`--project` accepts both Project names and UUIDs, and can be repeated or comma-separated:

```bash
npm run import:opik -- \
  --project 'project-a' \
  --project '019fb2e2-16a9-717d-98a8-0cd2e1bef87e' \
  --dry-run
```

Without `--project`, every project in the workspace is processed. If there are many projects, first validate on a small batch by specifying projects and `--max-traces`.

## Real import

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-traces 5 \
  --state-file './opik-import-remote-state.json'
```

On success it prints:

```text
[import] project=... trace=... accepted=...
[done] seen_traces=5 imported_traces=5 ... imported_messages=...
```

The tool actually calls:

```text
POST <MEMORY_CORE_URL>/v3/conversation/add
```

The write scope is determined by these fields together:

- `x-tdai-service-id`: `MEMORY_CORE_SERVICE_ID`
- `team_id`: `MEMORY_CORE_TEAM_ID`
- `agent_id`: `MEMORY_CORE_AGENT_ID`
- `user_id`: `MEMORY_CORE_USER_ID`
- `task_id`: `MEMORY_CORE_TASK_ID`, optional
- `session_id`: derived deterministically from the Opik Project ID and `thread_id`/Trace ID

Each message carries the original Opik time in both:

- `timestamp`: when the message actually happened
- `recorded_at`: L0 ingestion sort time, mapped to TCVDB's `recorded_at_ms`

So when the panel sorts by `recorded_at_ms desc`, messages appear in Opik's historical order rather than by the time this import ran. Ordinary Memory Core writes that do not pass `recorded_at` explicitly still use the server's receive time.

## Oversized Session protection

Default `--max-session-messages 40000`. This counts L0 messages, not user/assistant "turns"; 40,000 messages is roughly 20,000 standard Q&A turns, below the known risk threshold of 50,000 messages per Session.

The tool first groups the Traces to be processed in this run by target `session_id`. If a Session is expected to exceed the limit:

1. Merge the cumulative conversation in Trace time order, eliminating history from earlier Traces that repeats in later ones;
2. Keep only the latest N deduplicated messages;
3. Write them to a separate tail-snapshot Session first, with an ID of the form `<original_session>:t40000:<snapshot_hash>`;
4. Stop writing that source Session's old Traces one by one, so no single new Session exceeds the configured limit.

The snapshot ID changes with the tail content. When the source later gains new messages, a new snapshot Session is created, so the old Session is not appended to and pushed over the limit again.

Dry Run to check for oversized Sessions:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-session-messages 40000 \
  --large-session-strategy tail \
  --dry-run
```

If truncation is not allowed and you want to stop as soon as the limit is exceeded:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-session-messages 40000 \
  --large-session-strategy error \
  --dry-run
```

`--max-session-messages 0` disables the protection, but this is not recommended for Sessions that may exceed 50,000 L0 messages.

## Resume from checkpoint

Resume is enabled by default. Each successful batch is written immediately to `--state-file`, and rerunning the same command skips completed batches:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --state-file './opik-import-remote-state.json'
```

Ignore the existing checkpoint:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --no-resume
```

`--no-resume` may cause duplicate imports; use it only when you explicitly need to re-import. The checkpoint file has `0600` permissions and does not store the API Key.

## Pipeline strategy

By default it waits for L1 to go idle every 20 batches, and at the end waits for L1/L2/L3 to all go idle.

If memory extraction is disabled in the target environment and you only need to write L0:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --wait-every 0 \
  --no-final-wait \
  --state-file './opik-import-remote-state.json'
```

## Verify the import

```bash
curl --fail --silent --show-error \
  -X POST "${MEMORY_CORE_URL}/v3/conversation/query" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${MEMORY_CORE_API_KEY}" \
  -H "x-tdai-service-id: ${MEMORY_CORE_SERVICE_ID}" \
  --data "$(cat <<JSON
{
  \"team_id\": \"${MEMORY_CORE_TEAM_ID}\",
  \"agent_id\": \"${MEMORY_CORE_AGENT_ID}\",
  \"user_id\": \"${MEMORY_CORE_USER_ID}\",
  \"limit\": 100,
  \"offset\": 0
}
JSON
)"
```

## Opik authentication

Self-hosted Opik may not require authentication by default. When auth is enabled:

```bash
read -s "OPIK_API_KEY?Opik API Key: "
echo
export OPIK_API_KEY
export OPIK_AUTH_SCHEME='Bearer'
```

When `OPIK_AUTH_SCHEME` is empty, `OPIK_API_KEY` is sent as-is as the `Authorization` header.

## Common options

| Option | Default | Description |
|---|---:|---|
| `--project` | all projects | Project name or UUID; repeatable or comma-separated |
| `--page-size` | `100` | Items per page for the Opik API |
| `--max-traces` | `0` | Max Traces to process in this run; `0` means unlimited |
| `--max-session-messages` | `40000` | Max L0 messages written to a single target Session; `0` disables the protection |
| `--large-session-strategy` | `tail` | Keep the latest tail when over the limit; `error` stops immediately |
| `--state-file` | `.opik-memory-import-state.json` | Checkpoint file |
| `--dry-run` | off | Fetch and convert only, no writes |
| `--no-resume` | off | Ignore the checkpoint; may cause duplicate imports |
| `--include-system` | off | Convert system/developer messages into prefixed user messages |
| `--wait-every` | `20` | Wait for L1 every N write requests; `0` disables |
| `--no-final-wait` | off | Do not wait for the final L1/L2/L3 idle |
| `--timeout-ms` | `30000` | Timeout per HTTP request |
| `--retries` | `4` | Retry count for network errors, 429, and 5xx |

## Verified pipeline

The tool has been verified end to end against a real Opik API and an isolated local Memory Core:

1. Paginated reads of Opik Projects and Traces
2. Converted 5 Traces into 15 L0 messages
3. Wrote to `/v3/conversation/add`
4. Queried back 15 messages via `/v3/conversation/query`
5. On rerun, the checkpoint hit and 0 writes were made
6. SQLite and JSONL mirror on-disk counts matched
