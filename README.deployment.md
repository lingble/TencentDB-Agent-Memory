# Deployment and Integration Guide (Open-Source Standalone / Cloud Service)

> 📖 **This document covers deployment modes, the Gateway API, and configuration.**
> For the plugin's core capabilities, configuration options, and CLI tools, go back to the **[main README](README.md)**.

`memory-tencentdb` offers **two independent deployment modes**. In both, external agents call it over an HTTP API (through MemoryProxy, adapters, or the SDKs), and each mode suits a different deployment scale and set of operational requirements:

| Mode | Storage backend | State backend | Multi-tenancy | Use cases |
|------|----------|----------|--------|----------|
| **Standalone (open-source single-node)** | SQLite + local files | In-process Map / Timer | Single space | Local development, single-agent sidecar, all-in-one Docker, offline deployment |
| **Service (cloud service)** | TCVDB + COS | Redis (distributed locks + task queue) | Multiple spaces, per-`service_id` | Multi-replica K8s, multi-tenant SaaS, memory shared across agents |

```
L0  Raw conversation records (Conversation)  ← written automatically
L1  Atomic structured memory (Atomic Memory) ← LLM extraction + dedup
L2  Scene blocks (Scene Blocks)              ← LLM scene extraction
L3  User persona (Persona)                   ← LLM persona synthesis
```

Both modes share the same Gateway binary and the same v1/v2 HTTP API; only the configuration and backends differ. Switching modes only requires changing the `TDAI_DEPLOY_MODE` environment variable.

---

## Quick Start (3 Steps)

```bash
# 1. Enter MemoryCore and install dependencies
cd MemoryCore
npm install

# 2. Configure the LLM
export TDAI_LLM_API_KEY="your-api-key"
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"
export TDAI_LLM_MODEL="deepseek-chat"

# 3. Start the Gateway
npx tsx src/gateway/server.ts
```

By default the Gateway listens on `http://127.0.0.1:8420` and stores data in `~/.memory-tencentdb/memory-tdai/`.

---

## Deployment Modes

### Standalone Mode (Single Node)

No external dependencies; all data is stored locally. Use it for local development, a single-agent sidecar, or an all-in-one Docker deployment.

**Storage**: SQLite (vectors + records) + local file system (L2/L3 documents)
**State management**: In-process Map/Timer

#### Environment Variables

```bash
# Required — LLM configuration
export TDAI_LLM_API_KEY="sk-xxx"
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"   # default https://api.openai.com/v1
export TDAI_LLM_MODEL="deepseek-chat"                     # default gpt-4o
export TDAI_LLM_MAX_TOKENS=4096
export TDAI_LLM_TIMEOUT_MS=120000

# Optional — server configuration
export TDAI_GATEWAY_PORT=8420            # listen port, default 8420
export TDAI_GATEWAY_HOST="127.0.0.1"    # listen address, default 127.0.0.1
export TDAI_DATA_DIR="~/.memory-tencentdb/memory-tdai"  # data directory
```

#### YAML Config File (Optional)

Config file search order: `$TDAI_GATEWAY_CONFIG` → `./tdai-gateway.yaml` → `<dataDir>/tdai-gateway.yaml`

```yaml
# tdai-gateway.yaml — Standalone mode
server:
  port: 8420
  host: "127.0.0.1"

data:
  baseDir: "~/.memory-tencentdb/memory-tdai"

llm:
  baseUrl: "https://api.deepseek.com/v1"
  apiKey: "${TDAI_LLM_API_KEY}"
  model: "deepseek-chat"
  maxTokens: 4096
  timeoutMs: 120000

# memory config (optional; everything has sensible defaults)
memory:
  capture:
    enabled: true
    excludeAgents: []
  recall:
    maxResults: 5
    scoreThreshold: 0.3
    strategy: "hybrid"            # hybrid / embedding / keyword
  embedding:
    enabled: true
    provider: "openai"            # none / openai / deepseek / qclaw
    baseUrl: "${TDAI_LLM_BASE_URL}"
    apiKey: "${TDAI_LLM_API_KEY}"
    model: "text-embedding-3-small"
    dimensions: 1536
  bm25:
    enabled: true
    language: "zh"
  storeBackend: "sqlite"          # sqlite (standalone) or tcvdb (service)
  pipeline:
    everyNConversations: 5
    enableWarmup: true
    l1IdleTimeoutMs: 30000
    l2IntervalMs: 300000
    l3IntervalMs: 600000
```

#### Docker Deployment

```bash
# Gateway only
docker run -d \
  -e TDAI_LLM_API_KEY="sk-xxx" \
  -e TDAI_LLM_BASE_URL="https://api.deepseek.com/v1" \
  -e TDAI_LLM_MODEL="deepseek-chat" \
  -e TDAI_GATEWAY_HOST="0.0.0.0" \
  -p 8420:8420 \
  -v tdai-data:/root/.memory-tencentdb/memory-tdai \
  agentmemory/memory-core:latest
```

#### Data Directory Layout

```
~/.memory-tencentdb/memory-tdai/
  ├── vectors.db              # SQLite vector database (L0 + L1)
  ├── conversations/          # L0 raw conversation JSONL
  ├── records/                # L1 structured memory
  ├── scene_blocks/           # L2 scene Markdown files
  ├── persona.md              # L3 user persona
  └── checkpoint.json         # Pipeline progress
```

---

### Service Mode (Cloud Service)

Uses external storage (TCVDB vector database + COS object storage) and supports horizontal scaling across multiple replicas. Use it for K8s clusters, multi-tenant SaaS, or memory shared across agents.

**Storage**: TCVDB (vector search) + COS (L2/L3 documents, isolated by per-serviceId paths)
**State management**: Redis (distributed locks + task queue)
**Config source**: Shark service (dynamic VDB/COS credentials) or environment variables (static credentials)

#### Environment Variables

```bash
# ── Deployment mode ──
export TDAI_DEPLOY_MODE="service"           # key: enables service mode

# ── LLM (same as standalone) ──
export TDAI_LLM_API_KEY="sk-xxx"
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"
export TDAI_LLM_MODEL="deepseek-chat"

# ── Server port ──
export TDAI_GATEWAY_PORT=3100
export TDAI_GATEWAY_HOST="0.0.0.0"

# ── Redis (distributed state backend) ──
export STATE_BACKEND="redis"                # redis or local (single-node testing)
export REDIS_HOST="redis.example.com"
export REDIS_PORT=6379
export REDIS_PASSWORD="your-password"
export REDIS_KEY_PREFIX="tdai_memory"

# ── VDB vector database (direct mode) ──
export VDB_ENDPOINT="http://vdb.example.com:8100"
export VDB_USER="root"
export VDB_API_KEY="your-vdb-api-key"
export VDB_DATABASE="memory-production"

# ── COS object storage (direct mode) ──
export COS_SECRET_ID="AKIDxxxx"
export COS_SECRET_KEY="xxxxx"
export COS_TOKEN=""                         # set when using STS temporary credentials
export COS_URL="https://your-bucket.cos.ap-guangzhou.myqcloud.com"
export COS_PATH_PREFIX="tenants/prod/"

# ── Or use the Shark config service (recommended for production) ──
export SHARK_BASE_URL="http://shark.example.com:8080"
# Shark automatically provides per-instance VDB and COS config

# ── Optional tuning ──
export CONFIG_VDB_TTL_MS=300000             # VDB config cache TTL, default 5 minutes
export CONFIG_COS_BUFFER_MS=120000          # how early to refresh COS credentials
export CONFIG_MAX_INSTANCES=1000            # max cached instances
export SCANNER_SPACES="space1,space2"       # spaces scanned by the Timer Scanner
export TDAI_SPACE_ID="default"              # space ID of this instance
```

#### YAML Config File

```yaml
# tdai-gateway.yaml — Service mode
deployMode: service

server:
  port: 3100
  host: "0.0.0.0"

data:
  baseDir: "/data/tdai-memory"

llm:
  baseUrl: "${TDAI_LLM_BASE_URL}"
  apiKey: "${TDAI_LLM_API_KEY}"
  model: "deepseek-chat"

memory:
  storeBackend: "tcvdb"
  tcvdb:
    embeddingModel: "bge-large-zh"    # server-side embedding model in VDB
    timeout: 10000
  embedding:
    enabled: false                     # TCVDB embeds server-side; no client embedding needed
    provider: "none"
  bm25:
    enabled: true
    language: "zh"
  recall:
    strategy: "hybrid"
    maxResults: 10
```

#### K8s Deployment

```yaml
# Core environment variables (injected via ConfigMap/Secret)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tdai-memory-gateway
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: gateway
          image: agentmemory/memory-core:latest
          env:
            - name: TDAI_DEPLOY_MODE
              value: "service"
            - name: TDAI_GATEWAY_PORT
              value: "3100"
            - name: TDAI_GATEWAY_HOST
              value: "0.0.0.0"
            - name: STATE_BACKEND
              value: "redis"
            - name: REDIS_HOST
              valueFrom:
                configMapKeyRef:
                  name: tdai-config
                  key: redis-host
            - name: SHARK_BASE_URL
              value: "http://shark-svc:8080"
          ports:
            - containerPort: 3100
---
apiVersion: v1
kind: Service
metadata:
  name: tdai-memory-gateway
spec:
  selector:
    app: tdai-memory-gateway
  ports:
    - port: 3100
      targetPort: 3100
```

#### Multi-Replica Architecture

```
                    ┌─────────────┐
                    │  Agent #1   │─┐
                    └─────────────┘ │
                    ┌─────────────┐ │    ┌──────────────────┐    ┌──────────┐
                    │  Agent #2   │─┼───→│  TDAI Gateway    │───→│  TCVDB   │
                    └─────────────┘ │    │  (N replicas)    │    │  vectors │
                    ┌─────────────┐ │    │                  │───→│          │
                    │  Agent #3   │─┘    │  ┌─ Scanner ─┐   │    └──────────┘
                    └─────────────┘      │  │  Worker   │   │    ┌──────────┐
                                         │  └───────────┘   │───→│   COS    │
  Each agent uses a unique               └──────────────────┘    │  objects │
  x-tdai-service-id                              │               └──────────┘
  for data isolation                     ┌──────────────┐
                                         │    Redis     │
                                         │ state + jobs │
                                         └──────────────┘
```

---

## API Overview

### v1 API (Standalone-Compatible)

| Method | Path | Description |
|------|------|------|
| GET | `/health` | Health check |
| POST | `/recall` | Memory recall (prefetch) |
| POST | `/capture` | Conversation capture (sync_turn) |
| POST | `/search/memories` | L1 memory search |
| POST | `/search/conversations` | L0 conversation search |
| POST | `/session/end` | End session + flush |
| POST | `/seed` | Bulk import of historical conversations |

### v2 API (Multi-Tenant; Requires Bearer Token + x-tdai-service-id)

| Method | Path | Description |
|------|------|------|
| POST | `/v2/conversation/add` | L0 add conversation |
| POST | `/v2/conversation/query` | L0 query conversations |
| POST | `/v2/conversation/search` | L0 search conversations |
| POST | `/v2/conversation/delete` | L0 delete conversations |
| POST | `/v2/atomic/add` | L1 add memory |
| POST | `/v2/atomic/query` | L1 query memories |
| POST | `/v2/atomic/search` | L1 search memories |
| POST | `/v2/atomic/delete` | L1 delete memories |
| POST | `/v2/scenario/ls` | L2 list scenes |
| POST | `/v2/scenario/read` | L2 read scene |
| POST | `/v2/scenario/write` | L2 write scene |
| POST | `/v2/scenario/rm` | L2 delete scene |
| POST | `/v2/persona/read` | L3 read persona |
| POST | `/v2/persona/write` | L3 write persona |

---

## Configuration Reference

### All Environment Variables

| Variable | Default | Mode | Description |
|------|--------|----------|------|
| **Gateway basics** |
| `TDAI_DEPLOY_MODE` | `standalone` | All | `standalone` or `service` |
| `TDAI_GATEWAY_PORT` | `8420` | All | Listen port |
| `TDAI_GATEWAY_HOST` | `127.0.0.1` | All | Listen address |
| `TDAI_DATA_DIR` | `~/.memory-tencentdb/memory-tdai` | All | Data directory |
| `TDAI_GATEWAY_CONFIG` | (searched) | All | Config file path |
| **LLM** |
| `TDAI_LLM_API_KEY` | `""` | All | LLM API key |
| `TDAI_LLM_BASE_URL` | `https://api.openai.com/v1` | All | LLM API URL |
| `TDAI_LLM_MODEL` | `gpt-4o` | All | Model name |
| `TDAI_LLM_MAX_TOKENS` | `4096` | All | Max output tokens |
| `TDAI_LLM_TIMEOUT_MS` | `120000` | All | LLM request timeout |
| **Service mode** |
| `STATE_BACKEND` | (auto) | service | `redis` or `local` |
| `REDIS_HOST` | `127.0.0.1` | service | Redis host |
| `REDIS_PORT` | `6379` | service | Redis port |
| `REDIS_PASSWORD` | (none) | service | Redis password |
| `REDIS_KEY_PREFIX` | `tdai_memory` | service | Redis key prefix |
| **VDB (direct mode)** |
| `VDB_ENDPOINT` | `""` | service | VDB URL |
| `VDB_USER` | `root` | service | VDB username |
| `VDB_API_KEY` | `""` | service | VDB API key |
| `VDB_DATABASE` | `default` | service | VDB database name |
| **COS (direct mode)** |
| `COS_SECRET_ID` | (none) | service | COS access key ID |
| `COS_SECRET_KEY` | (none) | service | COS secret key |
| `COS_TOKEN` | (none) | service | COS STS token |
| `COS_URL` | (none) | service | COS bucket URL |
| `COS_PATH_PREFIX` | (none) | service | COS path prefix |
| **Shark (production mode)** |
| `SHARK_BASE_URL` | (none) | service | Shark config service URL |
| **Tuning** |
| `CONFIG_VDB_TTL_MS` | `300000` | service | VDB config cache TTL |
| `CONFIG_COS_BUFFER_MS` | `120000` | service | How early to refresh COS credentials |
| `CONFIG_MAX_INSTANCES` | `1000` | service | Max cached instances |
| `SCANNER_SPACES` | `default` | service | Spaces scanned by the Scanner |
| `TDAI_SPACE_ID` | `default` | service | Current space ID |

---

## Typical Deployment Examples

### Example 1: Local Development (Minimal)

```bash
export TDAI_LLM_API_KEY="sk-xxx"
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"
export TDAI_LLM_MODEL="deepseek-chat"
npx tsx src/gateway/server.ts
```

### Example 2: Multiple Agents + Shared Gateway

```bash
# 1. Start the Gateway (service mode)
cd MemoryCore
TDAI_DEPLOY_MODE=service \
TDAI_GATEWAY_PORT=3100 \
TDAI_GATEWAY_HOST=0.0.0.0 \
STATE_BACKEND=local \
VDB_ENDPOINT="http://vdb.example.com:8100" \
VDB_API_KEY="your-key" \
VDB_DATABASE="memory-shared" \
npx tsx src/gateway/server.ts

# 2. Give each agent a different service_id
# Agent A:
export TDAI_MEMORY_ENDPOINT="http://gateway-host:3100"
export TDAI_MEMORY_API_KEY="shared-key"
export TDAI_MEMORY_SERVICE_ID="agent-code-assistant"

# Agent B:
export TDAI_MEMORY_ENDPOINT="http://gateway-host:3100"
export TDAI_MEMORY_API_KEY="shared-key"
export TDAI_MEMORY_SERVICE_ID="agent-customer-support"
```

### Example 3: K8s Production Deployment

This repository does not currently include ready-to-apply Kubernetes manifests. Use the Deployment, ConfigMap, and Secret examples in this section as configuration templates, and adjust them to your actual images, domains, and cluster environment.
