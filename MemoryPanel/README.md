# Team Memory Control

Team Memory Control is a stateless team memory management console for managing teams, users, agents, tasks and their associated Skill, Wiki, Code Graph and Chat Memory assets.

## Scope

Control is responsible for:

- Providing the web management UI and the public Control API;
- Validating caller credentials and forwarding authorized requests;
- Aggregating metadata, memory assets and knowledge assets;
- Managing asset assignment, binding and display.

Control keeps no server-side login sessions and maintains no local user database. Business data is persisted by the external services configured at deployment time.

## Tech stack

- Backend: Node.js 22+, TypeScript, Hono, tsx
- Frontend: React 18, Vite, TypeScript, Tailwind CSS, Zustand
- Testing: Vitest
- Package managers: pnpm (backend) and npm (frontend)

## Layout

```text
src/
├── index.ts                  # Service entry point
└── panel/
    ├── config/               # Config and instance registry
    ├── domain/               # Domain rules
    ├── http/                 # Middleware and public routes
    ├── infra/                # Infrastructure such as logging
    ├── kernel/               # External service adapters
    └── startup/              # Startup tasks

web/                          # React management UI
config/                       # Instance registry example and docs
docker/                       # Container build files
docs/api/                     # Public API contracts
scripts/                      # Generation, test and security check scripts
tests/                        # Unit and E2E tests
```

## Local development

### Prerequisites

- Node.js 22 or later
- pnpm
- npm
- A reachable Memory Gateway
- A reachable Knowledge Service if you use Wiki or Code Graph

### 1. Install dependencies

```bash
pnpm install
cd web
npm install
cd ..
```

### 2. Prepare config

```bash
cp .env.example .env
cp config/metadata-instances.example.json config/metadata-instances.json
```

Edit `config/metadata-instances.json` with the instance ID, Gateway address and API Key for your deployment. This file contains credentials, is ignored by Git and must not be committed.

See `.env.example` for environment variables and `config/metadata-instances.README.md` for the instance registry fields.

### 3. Start the backend

```bash
pnpm dev
```

Listens on `http://127.0.0.1:8123` by default; the health check is `GET /health`.

### 4. Start the frontend

```bash
cd web
npm run dev
```

Open `http://127.0.0.1:5173` in your browser. The dev server forwards `/api/v1` and `/health` to the local Control by default.

## Common commands

| Command | Description |
|------|------|
| `pnpm dev` | Start the backend dev server |
| `pnpm build` | Compile the backend to `dist/` |
| `pnpm typecheck` | Run TypeScript type checking |
| `pnpm test` | Run unit tests |
| `pnpm generate:meta-openapi` | Generate the Meta OpenAPI doc |
| `pnpm test:panel:e2e` | Run the Panel Meta E2E tests |
| `pnpm test:knowledge:e2e` | Run the Knowledge E2E tests |
| `cd web && npm run dev` | Start the frontend dev server |
| `cd web && npm run build` | Build the frontend to `web/dist/` |
| `bash scripts/secret-scan.sh` | Scan for secrets |

## Public API

All public Control endpoints live under `/api/v1`:

- `/api/v1/meta/*`: instance, identity and metadata management
- `/api/v1/skill/*`: Skill management
- `/api/v1/chat-memory/*`: Chat Memory management
- `/api/v1/knowledge/*`: Wiki and Code Graph management
- `/api/v1/agent-overview/*`: Agent asset aggregation
- `/api/v1/agent/*`: Agent lifecycle operations

For integration, the public contracts under `docs/api/` and the route registrations in the source are the source of truth. External service APIs not listed in the public contracts are not covered by Control's compatibility guarantees.

## Container deployment

This repo provides a single-service Control image with default port `8123`. See `docker/README.md` for build and run instructions.

Deployments must provide `metadata-instances.json` through a read-only mount. Never put real API Keys into the image, example files or version control.

## Security requirements

- `user_key` is a user credential. Pass it only in request headers; never write it to logs, docs or frontend static assets.
- `api_key` in the instance registry is only for server-side calls to external services and must never be returned to the browser.
- Never commit `.env`, real instance registries, smoke-test env files, logs or test reports.
- Docs and examples may only use `example.com`, loopback addresses and obvious placeholders.
- Run `bash scripts/secret-scan.sh --strict` before committing.

If a credential ever entered Git history, rotate it immediately and clean the history before publishing the repo.

## Documentation

- Frontend development: `web/README.md`
- Meta API: `docs/api/meta-api.openapi.yaml`
- Knowledge API: `docs/api/knowledge-panel-api.md`
- Chat Memory API: `docs/api/chat-memory.md`
- Docker: `docker/README.md`
