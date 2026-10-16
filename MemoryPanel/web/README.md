# Team Memory Control Web

The web management UI for Team Memory Control, backed by the stateless Control service in the same repo.

## Tech stack

- React 18
- TypeScript
- Vite
- React Router
- Zustand
- Tailwind CSS

## Local development

First start Control from the repository root:

```bash
pnpm install
cp .env.example .env
cp config/metadata-instances.example.json config/metadata-instances.json
pnpm dev
```

Then start the frontend:

```bash
cd web
npm install
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173` in your browser.

## Dev proxy

Defaults in `vite.config.ts`:

| Request prefix | Default target | Environment variable |
|----------|----------|----------|
| `/api/v1`, `/health` | `http://127.0.0.1:8123` | `VITE_TMC_BACKEND_URL` |
| `/v3` | `http://127.0.0.1:8420` | `VITE_SKILL_GATEWAY_URL` |

To connect to another dev environment, put the real addresses in an uncommitted `web/.env`. Do not write internal addresses, accounts or credentials into the README, source code or tracked env files.

## Build

```bash
npm run build
```

Output goes to `web/dist/`. Control can serve these static files same-origin via `UI_DIST_DIR=./web/dist`.

## API boundary

The frontend uses the following Control APIs:

- `/api/v1/meta/*`
- `/api/v1/skill/*`
- `/api/v1/chat-memory/*`
- `/api/v1/knowledge/*`
- `/api/v1/agent-overview/*`
- `/api/v1/agent/*`

Login credentials are stored in the browser's `localStorage`, and business requests are sent with the `X-Tdai-Service-Id` and `X-Tdai-User-Key` headers. The frontend must never log, display or upload the full credentials.

The public contracts under the repo's `docs/api/` are the source of truth for API integration; external service APIs not listed in the public contracts are out of scope for the frontend.

## Common commands

| Command | Description |
|------|------|
| `npm run dev` | Start the dev server |
| `npm run build` | Type-check and build |
| `npm run preview` | Preview the build output |
| `npm run lint:check` | Run ESLint checks |
| `npm run format:check` | Check formatting |
