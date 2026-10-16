# TDAI Global Images: Local Deployment

Local startup scripts for the three global images — `memory-core` + `memory-hub` + `proxy`. Each can run on its own, or all three can be started with a single command.

> To deploy on a cloud server shared by a team (HTTPS, ports bound to loopback only, Claude subscription passthrough), see [REMOTE_DEPLOY.md](./REMOTE_DEPLOY.md).

## Components and ports

| Component | Container name | Image (public on Docker Hub) | Host port | Purpose |
|---|---|---|---|---|
| **memory-core** | `tdai-memory-core` | [`agentmemory/memory-core`](https://hub.docker.com/r/agentmemory/memory-core) | `8420` | Kernel gateway: memory reads/writes, auth, skill/RAG data plane |
| **memory-hub**  | `tdai-memory-hub`  | [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub)   | `8125` / `8424` | Combined image of the management Panel and the Knowledge service |
| **proxy**       | `tdai-proxy`       | [`agentmemory/memory-proxy`](https://hub.docker.com/r/agentmemory/memory-proxy) | `8096` | LLM request forwarding proxy; the API entry point for coding agents |

> All three images are published under the [`agentmemory`](https://hub.docker.com/u/agentmemory) namespace on Docker Hub,
> multi-arch (`linux/amd64` + `linux/arm64`), publicly pullable with no login. To pin a version, change the tag in `.env` from
> `:latest` to a specific version, e.g. `:1.0.0-beta.1`.
>
> Tencent-internal users can also point at the internal private registry `mirrors.tencent.com/memory-team-control/` — see the
> commented-out alternative block in `.env.example`.

## Requirements

- macOS / Linux
- Docker (any of Docker Desktop / colima / OrbStack)
- `bash` 4+ (the 3.2 that ships with macOS also works)

## Quick start

```bash
cd TencentDB-Agent-Memory/deploy/global-images

# One command: auto-copy .env → interactively fill in the LLMs → auto-check connectivity → start all three
./start-all.sh
```

`start-all.sh` is now **interactive**. When run, it:

1. Copies `.env.example` to `.env` automatically if `.env` doesn't exist (no manual `cp` needed)
2. Walks you through filling in two LLM groups (**Enter = keep the current default**):
   - `memory` group (prompts labeled `memory 组`): `BASE_URL` / `API_KEY` / `MODEL` (protocol defaults to `openai`)
   - `proxy` group (prompts labeled `proxy 组`): first asks whether to reuse the memory group's config (`proxy 组是否复用 memory 组的 LLM 配置？`); if you reuse it, this step is skipped
3. **Checks LLM connectivity immediately** after you fill them in; if it fails, you are asked to re-enter until it passes
4. **Writes the values back to `.env`** so they persist (reused as defaults on the next start)
5. Starts all three containers once the check passes

> You can also skip the interactive input and just use `.env`: manually `cp .env.example .env`, fill in the LLM settings,
> then run `./start-all.sh` and press Enter at every prompt (the defaults are the values from `.env`).

### MongoDB storage backend (experimental, optional)

The default storage is still **sqlite** (zero dependencies, data stored in a container volume). The MongoDB data plane is an **experimental feature**,
off by default, and not recommended as the default production backend. When enabled, L0/L1/profile/skill documents are stored in MongoDB with mongot
native BM25 retrieval, and metadata is also stored in Mongo by default:

```bash
./start-all-mongo.sh    # same flow as start-all.sh; writes MEMORY_CORE_STORE_MODE=mongodb to .env
```

- The script writes `MEMORY_CORE_STORE_MODE=mongodb` to `.env`, so later runs of `./start-all.sh`
  also stay on MongoDB and never silently fall back to sqlite. To go back to sqlite, comment out that line or set it to
  `sqlite`, then run `./start-all.sh`.
- If `MONGODB_ENDPOINT` is not set, the script starts a local `mongodb-atlas-local` container
  (mongod + mongot in one; this is **not** cloud Atlas). Data persists in `mongo-local-*` volumes, which
  `stop-all.sh --purge` also removes.
- To use an external Mongo (cloud Atlas / a self-hosted replica set with mongot), set
  `MONGODB_ENDPOINT` in `.env`.
- **Switching storage backends does not migrate existing data.** sqlite data lives in the `MEMORY_CORE_VOLUME` volume, mongo data
  in the `mongo-local-*` volumes (or the external instance); after a switch, the old data stays in the old backend. In the current version you must
  back it up and migrate it manually; an official migration tool will come in a later version. L2/L3 files live in the
  `MEMORY_CORE_VOLUME` volume in both modes.

### Dry-run check (optional)

`verify.sh` can still be used on its own; it only checks the environment and does not start containers:

```bash
./verify.sh              # full check by default (including the LLM connectivity pre-check)
./verify.sh --skip-llm   # skip the LLM check (offline environments)
```

## LLM connectivity pre-check

By default `verify.sh` pre-checks connectivity for both LLM groups (disable with `--skip-llm`):

- **OpenAI-compatible protocol**: `GET {base}/models`, which only validates the API key + URL and **consumes no tokens**
- **Anthropic protocol**: `POST {base}/v1/messages` with a minimal `max_tokens=1` message, consuming ≤ 10 tokens
- The **memory group** and **proxy group** are checked independently; if both have identical config, the duplicate check is skipped
- **When containers are already running**, it also execs a curl from inside the container to verify "container → LLM" reachability (in some corporate proxy / DNS-isolated environments the host can reach the LLM but the container cannot)

Example failure (the script's message is printed in Chinese; it reads "memory group API key is invalid (HTTP 401): <url>"):

```
[error] memory 组 API key 无效（HTTP 401）：https://api.deepseek.com/v1/models
{"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid",...}}
```

— A wrong API key, URL or model name is caught before startup, instead of surfacing as a 401 later during wiki ingest / chat.

Once startup completes:

- Panel UI: <http://localhost:8125/>
- Knowledge API: <http://localhost:8424/v3/>
- Knowledge Swagger: <http://localhost:8424/docs>
- Memory Gateway: <http://localhost:8420/>
- Proxy: <http://localhost:8096/>

## Two independent parameter groups

**This is the core of the script design** — the memory group and proxy group LLMs are fully independent and can point to different providers / models.

### memory group (used by memory-core + memory-hub)

Kernel memory embed/summarize and Knowledge wiki ingest / summarization use this config.

| Variable | Description | Example |
|---|---|---|
| `MEMORY_LLM_BASE_URL` | OpenAI-compatible base URL | `https://api.deepseek.com/v1` |
| `MEMORY_LLM_API_KEY` | API key for that endpoint | `sk-xxxxxxxx` |
| `MEMORY_LLM_MODEL` | Model ID | `deepseek-chat` |
| `MEMORY_LLM_PROTOCOL` | `openai` or `anthropic`, defaults to `openai` | `openai` |

### proxy group (used by proxy)

When the proxy receives a user request, it forwards it to this endpoint.

| Variable | Description | Example |
|---|---|---|
| `PROXY_UPSTREAM_URL` | Forwarding target base URL | `https://api.deepseek.com/v1` |
| `PROXY_UPSTREAM_API_KEY` | API key used for forwarding | `sk-xxxxxxxx` |
| `PROXY_UPSTREAM_MODEL` | User-facing model ID | `deepseek-chat` |

> The two groups can have the same values (both pointing at the same LLM) or be completely different: for example, a cheap model for embedding in the memory group and a strong model for the main conversation in the proxy group.

If parameters are missing, the script **lists all missing items at once before startup** and exits with `exit 1`, instead of failing halfway through.

## Memory prompt mode (chat / code)

memory-core uses `MEMORY_PROMPT_MODE` to switch the prompt family of the L1/L2/L3 pipeline:

| Mode | `.env` value | What is extracted | L3 output | Use case |
|---|---|---|---|---|
| **code** (default) | `MEMORY_PROMPT_MODE=code` | Project facts / tasks / decisions / SOPs / anti-patterns | Team Operating Doctrine | Coding agents, team collaboration, engineering projects |
| chat | `MEMORY_PROMPT_MODE=chat` | persona / episodic / instruction | persona.md (personal profile) | Personal assistants, casual chat, teaching |

> **Note**: in `code` mode, pure casual chat may yield 0 memories (the LLM sees no engineering content worth keeping). If L1 never produces anything, first check that `MEMORY_PROMPT_MODE` matches the actual conversation type.

## Internal credentials (must read for production)

The three services authenticate to each other with `MEMORY_CORE_GATEWAY_API_KEY`, and the first start also creates a
`system_admin` account via `init-admin`. For a **zero-config local experience**, the script defaults are:

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_CORE_GATEWAY_API_KEY` | `local` | Bearer for memory-hub / proxy → memory-core |
| `MEMORY_CORE_ADMIN_USERNAME` | `admin` | Username of the initial system_admin |
| `MEMORY_CORE_ADMIN_USER_KEY` | `admin` | Login key of that admin user |
| `KNOWLEDGE_SERVICE_KEY` | **auto-generated random value** | Panel ↔ Knowledge service-to-service Bearer (enforced on write/admin endpoints) |

> `KNOWLEDGE_SERVICE_KEY` has no fixed default: on first start the script generates a random `ks-svc-*` string
> and writes it back to `.env` (reused across restarts, so it doesn't drift). The same value is injected into the memory-hub container twice —
> as `KNOWLEDGE_SERVICE_KEY` (the Knowledge validation side) and `KNOWLEDGE_AUTH_TOKEN` (the Panel calling side).
> To distribute it yourself (multi-host / external orchestration), set it explicitly in `.env`; the script respects an existing value.

> These three defaults are only suitable for running the flow locally for yourself. **Before production / integration testing / public exposure, replace them with long random strings**;
> otherwise anyone who can reach the port gets system_admin privileges.
>
> Uncomment the corresponding three lines in `.env` and override them (`_lib.sh` runs `require_vars`
> on the other required values, but because these three have fallback defaults, the script prints a `[warn]` at startup reminding you to change them).

## Using each component on its own

The three scripts can be run individually, which is handy for debugging or when you only need some of the functionality:

```bash
./start-memory-core.sh       # kernel gateway only (8420)
./start-memory-hub.sh   # Panel + Knowledge only (8125 + 8424); needs the MEMORY_LLM_* parameters
./start-proxy.sh        # proxy only (8096); needs the PROXY_UPSTREAM_* parameters
```

Dependencies:

- **memory-core**: no external dependencies; can start on its own
- **memory-hub**: can start on its own (LLM_MODE=custom connects to the LLM directly), but the internal Knowledge calls to memory-core for RAG will fail → start memory-core first
- **proxy**: can start on its own (falls back to passthrough, forwarding directly, when cost-guard is unavailable), but auth / tdai memory / skill injection only work with memory-core

When any component is missing, the script prints a `warn` but does not block.

## Data persistence

- `tdai-memory-core-data` (named volume) → memory-core's SQLite / memory data
- `tdai-panel-data` (named volume) → SQLite / git clones / wiki files for Knowledge inside memory-hub

Data is kept until you `docker volume rm`. To rename the volumes, change `MEMORY_CORE_VOLUME` / `PANEL_VOLUME` in `.env`.

## Stop / clean up

```bash
./stop-all.sh            # stop containers, keep volumes (data is still there on next start)
./stop-all.sh --purge    # stop containers + remove volumes + remove network (full cleanup)
```

## Viewing logs

```bash
docker logs -f tdai-memory-core
docker logs -f tdai-memory-hub
docker logs -f tdai-proxy
```

memory-hub runs two processes (panel + knowledge); their logs are at `/data/knowledge/logs/panel.log` and `.../knowledge.log` inside the container.

## Port conflicts

If `8125` / `8420` / `8424` / `8096` conflict with existing local services, change them in `.env`:

```bash
MEMORY_CORE_PORT=18420
PANEL_PORT=18125
KNOWLEDGE_PORT=18424
PROXY_PORT=18096
# the externally reachable Knowledge address must follow KNOWLEDGE_PORT
KNOWLEDGE_PUBLIC_BASE_URL=http://host.docker.internal:18424/v3
```

## Using the proxy as a coding agent's API base

Using Claude Code as an example:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8096
export ANTHROPIC_API_KEY=any-string-if-auth-disabled
# clients using the openai protocol are similar: OPENAI_BASE_URL=http://localhost:8096/v1
```

The Panel UI "Client Access Endpoint" card automatically combines the host's LAN IP + `PROXY_PORT` (e.g.
`http://192.168.1.100:8096/codebuddy/default`), so others can copy it onto their machines and connect directly.
It is injected into `metadata-instances.json.proxy_endpoint` in memory-hub from `MEMORY_HUB_PROXY_PUBLIC_URL` (when unset, the script auto-detects it with `hostname -I` / macOS `ipconfig getifaddr en0`,
falling back to `localhost` only if detection fails).
Panel backend → Kernel forwarding is not affected by this variable (it always goes through `REMOTE_INSTANCE_URL` → memory-core:8420).
If the auto-detected address is wrong (multiple NICs / public domain / reverse proxy in front), set
`MEMORY_HUB_PROXY_PUBLIC_URL=http://<actual-value>:8096` explicitly in `.env`. To make the UI card use the old behavior (falling back to
gateway_endpoint), explicitly set `MEMORY_HUB_PROXY_PUBLIC_URL` to an empty string.

`proxy` disables `auth` / `sessionInit` / `costGuard` by default (these depend on internal services) and only does pure forwarding + `tdai-memory` context injection (the injector name, not a container name). To enable the full pipeline, configure it separately — see `context_proxy/config.example.yaml`.

## FAQ

**Q: `./start-all.sh` hangs at wait_healthy?**
The images may still be pulling. Pre-pull manually once with `docker pull <IMAGE>`, then rerun the script.

**Q: memory-hub is up but the Panel won't open?**

Check that `KNOWLEDGE_PUBLIC_BASE_URL` in `.env` includes `/v3` — without `/v3` the panel errors out.

**Q: proxy forwarding returns 401?**
`PROXY_UPSTREAM_API_KEY` is invalid or `PROXY_UPSTREAM_URL` doesn't match. Check the error with `docker logs tdai-proxy`.

**Q: How do I reach other services on the host (Ollama, Langfuse, etc.) from inside a container?**
The script sets `--add-host=host.docker.internal:host-gateway` by default. Inside the container, use `http://host.docker.internal:<port>`.
