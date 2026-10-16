# Docker deployment

This directory contains the container build files for **team-memory-control** (the Control panel backend).

## Layout

```
docker/
├── README.md                          # This file
└── local/
    ├── Dockerfile.local               # Control single image (multi-stage build)
    └── Dockerfile.local.dockerignore  # Build context ignore rules
```

## Images

| Image name (example) | Dockerfile | Build context | Description |
|----------------|------------|------------|------|
| `team-memory-control:local` | `docker/local/Dockerfile.local` | **Repo root** `.` | Control HTTP service, default `:8123` |

---

## `docker/local/Dockerfile.local`

### Purpose

Builds the **Control panel** monolithic image: the backend runs `src/index.ts` directly with `tsx` (stateless panel, entry `src/panel/`), and the `web/` frontend is compiled in a separate stage and served as static assets.

### Stages

| Stage | Role |
|-------|------|
| `base` | `node:22-slim` + native build toolchain (`better-sqlite3` needs `python3`/`make`/`g++`) |
| `ui-builder` | Builds `web/`: `npm install` + `npm run build` → `dist/` |
| `runtime` | Copies the full repo source, runs `npm install`, embeds the UI build output, starts Control |

### Build args

| Arg | Default | Description |
|------|--------|------|
| `PANEL_UI` | `web` | Frontend project directory (the active panel is `web/`; `frontend/` is a legacy directory and no longer maintained) |
| `WEB_UI` | `1` | `1` builds the panel UI normally; `0` skips the UI build and generates a placeholder `index.html` (see [Disabling the panel UI build](#disabling-the-panel-ui-build-web_ui0) below) |

At runtime, `METADATA_INSTANCES_CONFIG` points to the instance registry and `UI_DIST_DIR=./web/dist` serves the frontend.

### Exposed port and health check

- Port: `8123`
- Health check: `GET http://127.0.0.1:8123/health`

---

## Build and run

### Prerequisites

- Docker (BuildKit recommended)
- Node engine requirement matches the repo: `>=22` (see the root `package.json`)
- Run the build from the **repo root** (the context is the whole repo)

```bash
# From the repo root
docker build \
  --build-arg PANEL_UI=web \
  -t team-memory-control:local \
  -f docker/local/Dockerfile.local .

docker run -d --name tmc-control \
  -p 8123:8123 \
  -e UI_DIST_DIR=./web/dist \
  -e METADATA_INSTANCES_CONFIG=/app/config/metadata-instances.json \
  -e KNOWLEDGE_SERVICE_URL=http://host.docker.internal:8421 \
  -e KNOWLEDGE_AUTH_TOKEN=<ks-token> \
  -e KNOWLEDGE_LLM_PROXY_BASE_URL=http://host.docker.internal:8096 \
  -v "$(pwd)/config/metadata-instances.json:/app/config/metadata-instances.json:ro" \
  team-memory-control:local
```

Login: open `http://localhost:8123/` in a browser, choose the instance ID and enter the Gateway **user_key**. See [`config/metadata-instances.README.md`](../config/metadata-instances.README.md) for the instance registry fields.

If the Gateway runs on the host, `gateway_endpoint` in the mounted `metadata-instances.json` must be an address reachable from the container (e.g. `http://host.docker.internal:8420`), not `127.0.0.1`.

### Disabling the panel UI build (`WEB_UI=0`)

The panel UI depends on internal packages such as `@tencent/*`, which the public npm registry does not provide. If the build environment **cannot reach the internal npm registry** (e.g. an offline machine or external CI), `npm install` will fail. In that case, skip the UI build with `WEB_UI=0`:

```bash
docker build \
  --build-arg PANEL_UI=web \
  --build-arg WEB_UI=0 \
  -t team-memory-control:local-no-ui \
  -f docker/local/Dockerfile.local .
```

The image generates a placeholder `dist/index.html`. **The Control backend, `/health` and `/api/*` are fully functional**; only the static panel pages are unavailable (frontend routes return a placeholder message). When you need the panel UI, use the default `WEB_UI=1` and make sure the internal dependencies can be fetched.

### Common environment variables

| Variable | Default | Description |
|------|------|------|
| `UI_DIST_DIR` | `./web/dist` | Static frontend directory (the Dockerfile sets it via `ENV` to `./${PANEL_UI}/dist`) |
| `METADATA_INSTANCES_CONFIG` | `./config/metadata-instances.json` | Instance registry path |
| `METADATA_REMOTE_TIMEOUT_MS` | `15000` | Timeout for forwarding to the Gateway |
| `KNOWLEDGE_SERVICE_URL` | `http://127.0.0.1:8421` | Knowledge Service (KS) address; inside a container it must point to a KS reachable from the container |
| `KNOWLEDGE_AUTH_TOKEN` | — | Bearer token for calling KS; set per deployment |
| `KNOWLEDGE_TIMEOUT_MS` | `15000` | Timeout for KS calls |
| `KNOWLEDGE_LLM_BINDING_SYNC` | `true` | On startup, ensure a KS LLM binding for each instance (routed through the proxy for usage accounting); `false` skips it |
| `KNOWLEDGE_LLM_PROXY_BASE_URL` | `http://127.0.0.1:8096` | LLM accounting proxy address (must be reachable from the container) |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | Set `LOG_FORMAT=pretty` locally |

> Note: `LLM_MODEL` (the wiki ingest model) is not configured in the Panel; it is determined solely by `LLM_MODEL` on the KS side (default `Memory-Model`).

---

## `docker/local/Dockerfile.local.dockerignore`

BuildKit prefers `<dockerfile>.dockerignore` over the repo-root `.dockerignore`.

Main exclusions:

- `**/node_modules`, `**/dist` — keep host-compiled `better-sqlite3` and stale build output out of the image
- `.env`, `data/`, `*.db` — never bake secrets or local data into the image
- `docs/`, test reports, etc. — shrink the build context

**Security note**: `config/metadata-instances.json` **is** copied into the image by `COPY . .`. If it contains a real `api_key`, production images should mount it at runtime instead, or exclude the file in dockerignore and require a `-v` mount.

---

## Local development comparison

| Mode | Command |
|------|------|
| Source development | `pnpm dev` |
| Docker single image | See `docker build` / `docker run` above |

---

## Troubleshooting

| Symptom | Likely cause |
|------|----------|
| `GET /` 404 | `UI_DIST_DIR` is not set to `./web/dist`, or the frontend stage `npm run build` failed |
| API 401 / no team after login | `gateway_endpoint` in `metadata-instances.json` is unreachable, or `api_key` doesn't match the Gateway |
| Knowledge assets fail to load / 500 | `KNOWLEDGE_SERVICE_URL` is unreachable from the container, or `KNOWLEDGE_AUTH_TOKEN` doesn't match |
| Startup hangs at "ensure LLM binding" | `KNOWLEDGE_LLM_PROXY_BASE_URL` is unreachable from the container; set `KNOWLEDGE_LLM_BINDING_SYNC=false` to skip it temporarily |
