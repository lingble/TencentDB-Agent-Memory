# Memory Hub

**Memory Hub** is a combined image: one container runs two services — Team Memory Control (Panel) and the Knowledge Service (KS).

- **Panel**: console for managing team / Agent / Knowledge resources
- **KS**: Wiki / Code Graph knowledge service that Agents call through tools

The image is published on Docker Hub: [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub) (pulling `latest` is recommended).

---

## Prerequisites

### 1. Instance config file

After purchasing a Memory instance in the cloud, you get an **instance ID**, a **Gateway address** and an **API Key**. Put them in a JSON file (e.g. `metadata-instances.json`):

```json
{
  "instances": [
    {
      "id": "mem-xxxxxxxx",
      "name": "My Memory Instance",
      "gateway_endpoint": "<your-gateway>.ap-shanghai",
      "api_key": "your-gateway-api-key"
    }
  ]
}
```

Set `gateway_endpoint` to the Gateway address shown in the console (the example above is just a Shanghai-region sample; use your actual address). For multiple instances, add more objects to the `instances` array.

### 2. Externally reachable KS address

KS must expose an address so Agents (and the cloud Gateway) can reach the KS tools API. This address **must be externally reachable** (not `127.0.0.1` / `localhost`) and **must include** `/v3`.

For example, if the host's public/internal IP is `10.2.3.4` and port `8424` is mapped:

`http://10.2.3.4:8424/v3`

### 3. LLM Proxy address

KS features such as Wiki ingest / summarization call an LLM, and by default go through the LLM forwarding provided by Memory.

`KNOWLEDGE_LLM_PROXY_BASE_URL` is **the same address** as `gateway_endpoint` above: the Gateway address from the Memory console. For example, in the Shanghai region:

`<your-gateway>.ap-shanghai`

(For other regions, use the actual address shown in the console.)

To use your own LLM endpoint instead, see [Custom mode](#custom-mode-direct-llm-no-proxy) below.

---

## Quick start

```bash
docker run -d --name memory-hub \
  -p 8125:8125 -p 8424:8424 \
  -v memory-hub:/data/knowledge \
  -v /path/to/metadata-instances.json:/app/panel/config/metadata-instances.json:ro \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://10.2.3.4:8424/v3 \
  -e KNOWLEDGE_LLM_PROXY_BASE_URL=<your-gateway>.ap-shanghai \
  agentmemory/memory-hub:latest
```

> Replace `/path/to/metadata-instances.json`, `10.2.3.4` (the external KS address) and `KNOWLEDGE_LLM_PROXY_BASE_URL` (same as `gateway_endpoint`; use the actual Gateway address from the console) with your real values.

### Required settings (only these 3)

| Setting | How | Description |
| --- | --- | --- |
| Instance config | Mount `metadata-instances.json` | ID, Gateway address and API Key of the cloud Memory instance |
| External KS address | `KNOWLEDGE_PUBLIC_BASE_URL` | Externally reachable address of KS; **must include** `/v3` |
| LLM Proxy address | `KNOWLEDGE_LLM_PROXY_BASE_URL` | Same as `gateway_endpoint`: the Gateway address from the Memory console |

These 3 must be provided by the user. Everything else has built-in defaults in the image; adjust as needed.

---

## Optional settings

All of the following have built-in defaults in the image and work fine if not passed. Override as needed.

### LLM settings

| Environment variable | Default | Description |
| --- | --- | --- |
| `LLM_PROTOCOL` | `openai` | LLM protocol: `openai` uses `/chat/completions`, `anthropic` uses `/messages` |
| `LLM_MODEL` | `Memory-Model` | Model ID, passed through to proxy/TokenHub |
| `LLM_MODE` | `proxy` | `proxy`: use the Memory Gateway LLM forwarding; `custom`: connect directly to a BYO endpoint |
| `LLM_MAX_TOKENS` | `32768` | Max output tokens per LLM call |
| `LLM_TIMEOUT_MS` | `1200000` | LLM call timeout in ms (20 minutes; reasoning models need a long time) |
| `LLM_API_KEY` | empty | Required only when `LLM_MODE=custom` |
| `LLM_BASE_URL` | empty | Required only when `LLM_MODE=custom`, e.g. `https://api.openai.com/v1` |

**Protocol / model pairing rules**:

| Protocol | Models | Endpoint |
| --- | --- | --- |
| `openai` (default) | `Memory-Model`, `deepseek-v4-pro` | `/chat/completions` |
| `anthropic` | `ep-pksklwtb`, `claude-sonnet-4-5`, etc. | `/messages` |

When switching models, the protocol must match:

```bash
# Default (OpenAI protocol + Memory-Model)
# No extra config needed; this is the image default

# Switch to an Anthropic model
-e LLM_PROTOCOL=anthropic -e LLM_MODEL=ep-pksklwtb
```

### Network and storage

| Environment variable | Default | Description |
| --- | --- | --- |
| `PANEL_PORT` | `8125` | Panel service port |
| `KNOWLEDGE_PORT` | `8424` | KS service port |
| `KNOWLEDGE_DATA_DIR` | `/data/knowledge` | KS data directory (SQLite, git clones, wiki files, logs) |
| `KNOWLEDGE_DB_PATH` | `/data/knowledge/knowledge.db` | KS SQLite database path |
| `TMC_CALLBACK_URL` | `http://127.0.0.1:8125` | Root URL KS uses to call back the Panel when ingest finishes (loopback inside the container; usually no need to change) |
| `KNOWLEDGE_TIMEOUT_MS` | `15000` | Request timeout for Panel → KS calls |
| `METADATA_REMOTE_TIMEOUT_MS` | `15000` | Request timeout for Panel → remote Gateway calls |
| `REMOTE_INSTANCE_PROXY_URL` | empty | Base URL shown on the Panel UI "Client Access Endpoint" card. For an open-source local deployment with core and proxy running separately, set it to the proxy's external address (e.g. `http://host.docker.internal:8096`) so the CodeBuddy/ClaudeCode access URLs copied from the Panel UI point at the proxy. Leave empty for the old behavior — the UI falls back to `gateway_endpoint`. **Panel backend → Kernel forwarding always uses `REMOTE_INSTANCE_URL` and is unrelated to this variable.** (Ignored when `metadata-instances.json` is mounted; add a `proxy_endpoint` field in the JSON instead.) |

### TLS certificates

Official public certificates usually need no extra config. When the LLM Proxy or Gateway uses HTTPS with a certificate the container doesn't trust (e.g. self-signed, internal CA), there are two options:

**Option A: skip TLS verification (for quick tests; not recommended for production)**

```bash
-e NODE_TLS_REJECT_UNAUTHORIZED=0
```

**Option B: mount the CA certificate (recommended)**

```bash
-v /path/to/your-ca.pem:/usr/local/share/ca-certificates/extra-ca.crt:ro \
-e NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/extra-ca.crt
```

| Environment variable | Default | Description |
| --- | --- | --- |
| `NODE_TLS_REJECT_UNAUTHORIZED` | not set | Set to `0` to skip TLS certificate verification (testing only) |
| `NODE_EXTRA_CA_CERTS` | not set | Path to an extra CA certificate; supported natively by Node.js and also read by the AI SDK's fetch |

### Logging

| Environment variable | Default | Description |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | Log level (`debug` / `info` / `warn` / `error`) |
| `LOG_FORMAT` | `json` | Log format (`json` / `text`) |
| `LOG_DIR` | `/data/knowledge/logs` | Log file directory |

Logs are written to `${LOG_DIR}/panel.log` and `${LOG_DIR}/knowledge.log`, rotated into a `.prev` copy on each start, and also sent to stdout (visible via `docker logs`).

### Observability (Langfuse)

Once all three are set, KS LLM calls automatically report traces to Langfuse.

| Environment variable | Default | Description |
| --- | --- | --- |
| `LANGFUSE_BASE_URL` | empty | Langfuse service address |
| `LANGFUSE_PUBLIC_KEY` | empty | Langfuse public key |
| `LANGFUSE_SECRET_KEY` | empty | Langfuse secret key |

### LLM Binding sync

| Environment variable | Default | Description |
| --- | --- | --- |
| `KNOWLEDGE_LLM_BINDING_SYNC` | `1` | Whether the Panel syncs the KS llm_binding for instances at startup. Forced to `1` when `LLM_MODE=proxy`; in `custom` mode set it to `0` so KS uses the global config |

---

## Endpoints

| Service | Address |
| --- | --- |
| Panel UI | `http://localhost:8125/` |
| Panel API | `http://localhost:8125/api/v1/` |
| KS Health | `http://localhost:8424/health` |
| KS API | `http://localhost:8424/v3/` |
| KS Swagger docs | `http://localhost:8424/docs` |

---

## Custom mode (direct LLM, no proxy)

If you don't use the Memory Gateway LLM forwarding, you can point at your own LLM endpoint directly. `KNOWLEDGE_LLM_PROXY_BASE_URL` is not needed in this case.

```bash
docker run -d --name memory-hub \
  -p 8125:8125 -p 8424:8424 \
  -v memory-hub:/data/knowledge \
  -v /path/to/metadata-instances.json:/app/panel/config/metadata-instances.json:ro \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://10.2.3.4:8424/v3 \
  -e LLM_MODE=custom \
  -e LLM_API_KEY=sk-your-llm-key \
  -e LLM_BASE_URL=https://api.openai.com/v1 \
  -e LLM_MODEL=gpt-4o \
  -e KNOWLEDGE_LLM_BINDING_SYNC=0 \
  agentmemory/memory-hub:latest
```

---

## Data persistence

| Mount point | Description |
| --- | --- |
| `/data/knowledge` | KS data (SQLite, git clones, wiki files, logs) |

A named volume is recommended: `-v memory-hub:/data/knowledge` (matching the container name).

---

## FAQ

### Q: How do I reach host services from inside the container?

The cloud Gateway (`KNOWLEDGE_LLM_PROXY_BASE_URL`) is usually directly reachable and doesn't need to be changed to a host address. If other services (e.g. Langfuse) run on the host, use `172.17.0.1` (the docker0 bridge) instead of `localhost`:

```bash
-e LANGFUSE_BASE_URL=http://172.17.0.1:8400
```

Or add `--add-host=host.docker.internal:host-gateway` and use `host.docker.internal`.

### Q: Wiki ingest times out?

Reasoning models may need more than 20 minutes for large files:

```bash
-e LLM_TIMEOUT_MS=1800000  # 30 minutes
```

### Q: tools/list returns 404?

`KNOWLEDGE_PUBLIC_BASE_URL` must include the `/v3` prefix. Correct format: `http://host:port/v3`.

### Q: Errors after switching the LLM protocol?

Make sure `LLM_PROTOCOL` and `LLM_MODEL` match:

```bash
# OpenAI model (default)
-e LLM_PROTOCOL=openai -e LLM_MODEL=Memory-Model

# Anthropic model
-e LLM_PROTOCOL=anthropic -e LLM_MODEL=ep-pksklwtb
```

---

## Building

### Prerequisites

All source code lives under this repository's root:

```text
memory-tencentdb/
├── MemoryPanel/                         # Panel backend + web frontend
├── MemoryKnowledge/                     # Knowledge Service
└── deploy/panel-knowledge-combined/     # this recipe
```

### Local single-arch build (for debugging)

```bash
cd deploy/panel-knowledge-combined
IMAGE_TAG=1.0.0-beta.1 ./build.sh          # defaults to linux/amd64 → team-memory-panel-knowledge:1.0.0-beta.1
PLATFORM=linux/arm64 IMAGE_TAG=arm64 ./build.sh   # build natively if your machine is arm64
```

### Publishing to Docker Hub (amd64 + arm64)

Tag conventions:

| Tag | Meaning |
| --- | --- |
| `1.0.0-beta.N` | Pinned version (use this for docs/reproduction) |
| `beta` | Floating channel: always points to the latest beta (pushed with each release by default) |
| `latest` | Reserved for stable releases (not pushed by default) |

For the first release, push: `agentmemory/memory-hub:1.0.0-beta.1` + `agentmemory/memory-hub:beta`.

```bash
cd deploy/panel-knowledge-combined

# 1) Log in to Docker Hub (requires push access to the agentmemory org)
docker login

# 2) Only scan for secrets + prepare the context (no build)
DRY_RUN=1 VERSION=1.0.0-beta.1 ./publish.sh

# 3) Optional: load amd64 locally first and spot-check that no .env / metadata-instances.json is in the image layers
PUSH=0 VERSION=1.0.0-beta.1 ./publish.sh

# 4) Real multi-arch build and push (also tags :beta by default)
VERSION=1.0.0-beta.1 ./publish.sh

# Version tag only, without moving :beta:
# ALSO_BETA=0 VERSION=1.0.0-beta.1 ./publish.sh

# Tag latest only for a stable release (don't enable during beta):
# ALSO_LATEST=1 ALSO_BETA=0 VERSION=1.0.0 ./publish.sh
```

`publish.sh` runs these steps in order:

1. Runs `scripts/secret-scan.sh` on `MemoryPanel` / `MemoryKnowledge`
2. `PREPARE_ONLY=1 ./build.sh` generates the rsync context (excluding `.env*`, `metadata-instances.json`, etc.)
3. Scans the context again
4. `docker buildx build --platform linux/amd64,linux/arm64 --push` to `agentmemory/memory-hub:<VERSION>` (also tags `:beta` by default; the local name `team-memory-panel-knowledge` is only used with `PUSH=0` and is never pushed)

Post-push self-check:

```bash
docker buildx imagetools inspect agentmemory/memory-hub:1.0.0-beta.1
docker buildx imagetools inspect agentmemory/memory-hub:beta
# both should show Platform: linux/amd64 and linux/arm64, with the same digest
docker pull agentmemory/memory-hub:beta
```

Environment variable quick reference:

| Variable | Default | Description |
| --- | --- | --- |
| `VERSION` | `1.0.0-beta.1` | Version tag |
| `HUB_IMAGE` | `agentmemory/memory-hub` | Repository name |
| `PLATFORMS` | `linux/amd64,linux/arm64` | buildx targets |
| `BUILDER` | `multiarch` | buildx builder name (created automatically if missing) |
| `DRY_RUN` | `0` | `1` = scan only |
| `PUSH` | `1` | `0` = local single-arch `--load` |
| `ALSO_BETA` | `1` | `1` = also push the floating `:beta` |
| `ALSO_LATEST` | `0` | `1` = also push `:latest` |
