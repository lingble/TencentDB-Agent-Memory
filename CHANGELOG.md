# Changelog

This file records notable changes to **TencentDB Agent Memory**. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

It covers every open-source module in the repo: `MemoryCore` / `MemoryPanel` / `MemoryKnowledge` /
`MemoryProxy` / SDK.

---

## [2.0.3-beta.1] — 2026-10-13

### 🧩 可插拔决策服务（默认关闭）

- Skill 选择与 Memory L3 更新判定改为通过统一的决策服务接口调用，内置 JEV，
  可接入其他 decision API；配置用 `provider` 指定（默认 `jev`），旧配置无需修改
- 默认不调用 JEV，行为与之前一致；开启后决策服务调用失败不影响正常对话与记忆写入

### 🧰 技能（Skill）按需选择（默认关闭）

- 开启后由 Proxy 每轮自动选出合适的技能，通过一次客户端工具调用加载，
  不再向系统提示词注入完整技能目录

### 📼 会话轨迹记录

- Proxy 在每轮对话结束后，把发往上游的消息与模型回复记录到 MemoryCore
  （新增 `/v3/session/add`，写入本地存储）；随 `tdai.enabled` 开启

### 🧠 代码知识库

- 私有代码仓支持 SSH 克隆（含非 22 端口），在面板获取 SSH 公钥后即可建图

### 📈 可观测性

- `/health` 新增 `ftsAvailable`，便于排查 BM25 关键词召回不可用的问题
- LLM 调用失败日志补充状态码、URL 与响应内容

---

## [2.0.2] — 2026-10-09

### 🗄️ MongoDB storage backend (experimental, optional, off by default)

- More complete MongoDB backend: adds memory-prompt and generation-ref stores,
  covering more memory data structures
- The one-command entry point `./start-all-mongo.sh` persists `STORE_MODE` to `.env`, so later starts
  keep the same backend without reconfiguring each time
- Fixed self-healing for index conflicts: duplicate default/extraction records no longer cause startup errors

### 🔀 More client integrations

- **OpenCode** gets an official Memory adapter config package (`opencode.json` plus setup docs); follow the instructions to connect, no plugin code needed
- **OpenCode** supports the 2.0 v2 provider config structure; newer clients can reuse the official `opencode.v2.json` directly
- **DeepSeek Harness** adds dsh desktop support; see section 1.6 of `./agents/dsh/README.md` for configuration
- Added the **Pi** client integration (a Codex-like AI agent client that uses the OpenAI Chat protocol)

### 🧠 External source import (Wiki / code / tasks)

- Added importing Tasks from external task management systems; task cards show the source and support ID copy
  and pagination
- Added registration of external code sources (private repos) with credential isolation; each team holds its own credentials, invisible to others
- Added Wiki import from external sources, completing the external asset import pipeline alongside code and task sources

### 🧰 Skill experience improvements

- Cold-start batch skill extraction adds a strict mode for more controllable extraction quality
- Skill extraction automatically follows the user's language, so generated content better fits how they work
- The skill list can be sorted by usage activity, making frequently used skills easier to find

### 🎛️ Memory Hub panel

- Task cards show the source, support ID copy, and have improved pagination; batch import is smoother
- Manual refresh resets the time filter automatically, so newly created memories show up immediately

### 🔄 Session and integration experience

- Session onboarding is more stable across more clients: the only Agent is auto-selected, asset confirmation is more precise, and preset failures
  are bypassed automatically instead of hanging
- Fixed repeated popups from WorkBuddy parallel sub-agents; session consolidation is more robust
- Fixed memory commands, tool-result pollution, duplicated history messages, and other UX issues across several clients

### 🐛 Fixes

- Fixed BM25 recall errors, L0 tool-result pollution, and raw-text display issues when no embedding is configured
- Fixed empty memory recall, duplicated history messages, and truncated lists when switching between teams
- Fixed lost AGENTS.md instructions in Claude Code and related issues
- Fixed deploy script compatibility issues in some environments

---

## [2.0.2-beta.1] — 2026-09-07

### 🗄️ MongoDB storage backend (experimental, optional, off by default)

The default store is still sqlite; existing deployments need no changes. MongoDB is offered as an optional backend
for cases that need native mongot full-text search or want to evaluate a non-sqlite data plane:

- Added the one-command entry point `./start-all-mongo.sh`; when `MONGODB_ENDPOINT` is not set,
  the script starts a local `mongodb-atlas-local` container (not cloud Atlas)
- Once enabled, `MEMORY_CORE_STORE_MODE=mongodb` is written to `.env`, so later starts
  keep that backend and never silently fall back to sqlite
- **Switching storage backends does not migrate existing data.** sqlite and MongoDB use separate
  data directories / instances, and after switching the old data stays in the old backend. In this version you must back up and
  migrate manually; a future version will provide an official migration tool

See the "Optional: MongoDB storage backend (experimental, off by default)" section of [INSTALL.md](./INSTALL.md) for usage.

### 🧰 Skill experience improvements

- Skill search and display are more structured, with clearer information and more stable invocation
- Legacy malformed skill data is repaired automatically, so old assets stay compatible

### 🔄 Session and integration experience

- Smoother onboarding for more clients; text-mode clients also work out of the box
- Team / Agent selection lists show every entry, so nothing gets missed when there are many teams
- Clearer completion message after a session reset

### 🔐 OAuth2 support · Enterprise OA login

- Panel login supports the standard OAuth2 protocol and can connect to an enterprise's internal OA / SSO system
- Since OA protocols differ, the repo provides an integration skeleton and config options;
  you only need small adaptations for your OA's `authorize` / `token` / `userinfo` endpoints
- Once connected, team members can log in to the Panel with their OA accounts, and user identity is linked to `user_key`
  automatically, so there's no need to hand out or remember an `sk-mem-...` key

### 📊 Analytics and observability (optional, off by default)

- A new analytics page shows team usage at a glance, helping you judge how well memory assets are accumulating
- Added instrumentation and observability data at key stages for easier troubleshooting
- **Off by default**; enabling it requires configuring ClickHouse in three services: Proxy / Knowledge
  report events (Proxy records memory / skill tool calls, Knowledge records
  wiki / code-graph tool calls), and Core serves the query API. The Panel calls the
  config discovery endpoints of Core and Knowledge to decide whether it's enabled, then calls the query API
  to fetch data. See the
  "Optional: Analytics & observability (off by default)" section of [INSTALL.md](./INSTALL.md)

### 🐛 Fixes

- Fixed empty memory recall and search fallback not taking effect in some cases
- Fixed occasional memory parse failures and duplicated history messages
- Fixed truncated, incomplete lists when switching between teams
- Fixed deploy script compatibility issues in some environments

---

## [2.0.1] — 2026-08-25

### 🚀 Support for more agent clients

Whichever coding agent you use, you can now plug it straight into team memory:

- Added the **OpenCode** client integration
- Added the **DeepSeek Harness (dsh)** integration: Web UI sessions of DeepSeek's official agent harness
  can connect to the Proxy directly and get team memory / skill / knowledge injection automatically
- Added the **Codex CLI** integration
- Added the **WorkBuddy** client integration, ready out of the box
- First-run onboarding and reset behave consistently across clients, so switching is smoother

### 🤖 Commands directly in the session

Handle common operations in the conversation without switching to the panel:

- Reset the binding mid-session in one step (switch team / Agent / task)
- Create / update tasks directly in the conversation
- Faster command responses, less waiting

### 🧠 Cold start out of the box

- Creating a team or user automatically generates a default Agent, no manual setup
- Admins can customize the default Agent template, applied automatically to new users at cold start
- Import assets from an Agent already in your IDE in one step to get started fast
- A task is bound by default after connecting, ready to use immediately

### 🔄 More stable session binding

- Session bindings are persisted and survive restarts
- After switching Agents, memories and skills switch with it correctly instead of leaking across
- Fixed history replay being misdetected in some clients

### 🧰 Skill experience upgrade

- Skills created in a session are searchable immediately, with no more "search blind spot"
- Restored display and one-click copy of skill IDs
- Skills can be edited online
- Added a setup wizard skill: follow the guided steps, or finish the Proxy setup automatically with a single command

### 🎛️ Memory Hub panel

- New login page with a dot-matrix ripple animation
- Team edit / delete actions moved into the team switcher for easier use; fixed switching glitches
- Admins can set a custom User_Key when creating accounts
- Added conversation memory search: semantic and keyword search across sessions, with visibility precisely controlled by permissions;
  supports directly overwriting a single memory layer
- Asset IDs are shown and copyable; lists load fully, fixing pagination truncation

### ⚙️ One-command deploy improvements

- The start script supports interactive configuration and pre-checks LLM connectivity and port conflicts to avoid deployment pitfalls
- Copy the client connection URL in one click; in single-host deployments it resolves to the host address automatically so external clients can connect directly

### ⚡ Performance

- Faster knowledge base list loading and quicker response on common paths
- Wiki pages build concurrently and failed pages retry automatically, greatly reducing large document import times

### 📚 Docs

- Split setup docs per client, so each agent has its own clear setup guide
- Added Panel and API usage docs
- Added English Panel screenshots and README updates

### 🐛 Fixes

- Fixed empty memory search in multi-Agent setups
- Fixed asset unbinding not taking effect and the memory tab disappearing when there are many assets
- Fixed scrambled timestamps on imported history sessions, restoring the original timeline
- Fixed some content being expanded twice when editing scenes
- Fixed deploy script compatibility on macOS
- Fixed install errors caused by missing dependencies
- Fixed compatibility of the first-run onboarding form with older versions of some clients
- Added clearing conversation memory, with batch delete

---

## [2.0.1-beta.1] — 2026-08-13

### 🧠 Cold start out of the box · Default Agent + preset Skills

- Creating a team/user automatically generates a default Agent, no manual setup
- Copy the client connection URL in one click, with support for pointing at the Memory Proxy
- In single-host deployments the connection URL resolves to the host address automatically so external clients can connect directly

### ⚡ Faster Wiki generation

- Optimized Wiki generation with concurrent page builds, greatly reducing large document import times
- Failed pages retry automatically instead of stalling the whole batch
- Generation progress and per-page status are visible in real time

### 🧰 Skill ecosystem

- Added Skill export
- Improved Skill search: private Skills are searchable and results are more accurate
- Improved Skill extraction to capture a wider range

### 🔀 Memory Proxy · New client integrations

- Added the Codex CLI integration
- Added the WorkBuddy client integration
- Added the DeepSeek Harness (dsh) integration: Web UI sessions of DeepSeek's official agent harness
  can connect to the Proxy directly and get team memory / skill / knowledge injection; supports short-circuiting aux requests
  (compaction / title-gen) and CLI headless bypass
- Improved the association between code-graph resources and workspaces

### 🎛️ Memory Hub panel

- Reworked the first-run onboarding flow and added an Agent binding step
- Improved panel interactions, loading skeletons, and transition animations
- Improved user display name resolution on the Task page
- Improved the Assets page layout and the explanation of ownership/sharing rules
- Fixed the memory tab disappearing when there are many assets

### 🐛 Fixes

- Fixed empty memory search in multi-Agent setups
- Fixed asset unbinding not taking effect
- Imported history sessions keep their original timestamps, so the timeline is no longer scrambled
- Fixed memory loss in some scenarios
- Added clearing conversation memory, with batch delete

---

## [2.0.0] — 2026-08-03

> **Positioning**: turn agents' experience, docs, and code into reusable assets, so the next agent
> can pick up where the last one left off. See [README.md](./README.md).

### 🧠 Four memory asset types · fully open-sourced for the first time

All four asset types are distilled automatically from "conversation/work traces":

- **Chat Memory** — extracted layer by layer from conversations: L0 raw records → L1 facts → L2 scenes → L3
  long-term understanding; preferences, decisions, and interaction history persist across sessions.
- **Skill** — reusable SOPs distilled from completed tasks, with version / resource files / trigger boundaries /
  execution steps / validation rules. Adds forced Skill archiving.
- **Wiki** — turns documents into structured pages plus a link graph (inspired by Karpathy's LLM knowledge base
  practice).
- **CodeGraph** — indexes a repo's symbols / files / call relationships / impact paths, so the agent runs impact analysis
  before changing code. Adds scheduled automatic codebase sync.

### 🎛️ Memory Hub · Team console

Control panel (`agentmemory/memory-hub` image, including Panel + Knowledge Service):

- Create Teams / Agents and manage assets uniformly by Owner / version / status / visibility
- Three visibility levels: `private` / `team` / `restricted` (User / Role / Agent ACL),
  plus targeted `agent` assembly
- Agent Loadout: bind different assets to different Agents and adjust priority and usage
- Wiki + CodeGraph workshop built into the Hub; import a codebase/docs and it builds automatically
- System Admins can now use asset management too
- Full Chinese/English switching across the panel; unified page design, improved list interactions and pagination

### 🔀 Memory Proxy · The channel that plugs agents into memory

`agentmemory/memory-proxy` lets coding agents such as Claude Code use team memory directly:

- **Anthropic / OpenAI dual protocol**: both `/claude-code/<spaceId>/v1/messages` and
  `/v1/chat/completions` are supported
- **First-turn onboarding**: sessionInit uses `AskUserQuestion` to let the user pick team / agent /
  task, and the proxy remembers the binding
- **Per-turn injection**: the agent's L2/L3 memory, matched skills, and wiki/code-graph
  are assembled into the system prompt and forwarded to the upstream LLM
- **Auth**: `x-tdai-user-key` → kernel `/v3/meta/auth/verify` exchanges it for a `user_id`,
  controlling asset visibility per user
- Cost Guard supports configuring different models per Agent to cut costs

### 🚀 One command brings up the full trio

All three images are published multi-arch (`linux/amd64` + `linux/arm64`) to
[Docker Hub `agentmemory`](https://hub.docker.com/u/agentmemory), publicly pullable
with no login:

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env    # fill in the two sets of LLM parameters
./start-all.sh                          # start everything
```

On first start, `start-all.sh` automatically runs `init-admin`, generates an admin `sk-mem-...` and saves it to
`.admin-key`; after self-checking `/v3/meta/auth/verify` it prints a copyable `claude` launch command.
`stop-all.sh --purge` fully clears the volumes and admin key for an easy reset.

See [INSTALL.md](./INSTALL.md).

### 🧰 Official SDKs

- **TypeScript** — `@tencentdb-agent-memory/memory-sdk-ts-v2`

  ```ts
  import { MemoryClient, SkillClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

  const memory = new MemoryClient({
    endpoint, apiKey, serviceId,
    teamId, agentId, userId,     // v3 strict isolation: all three are required
  });
  ```

  The top-level export is the v3 strict-isolation version; old code using the `.../v2/v3` subpath
  keeps working (the subpath is kept as a backward-compatible alias).

- **Python** — `pip install tencentdb-agent-memory-sdk-python`

  ```python
  from tencentdb_agent_memory import MemoryClient                     # default (v2 compatible)
  from tencentdb_agent_memory.v3 import MemoryClient, MetadataClient, SkillClient
  ```

### 📖 Docs

- Added setup guides for CodeBuddy / Hermes / OpenClaw
- Updated the role permission notes in the install guide

---

## [2.0.0-beta.1] — 2026-07-21

First public release. SemVer starts at `2.0.0-beta.1` (npm package names moved to a `-v2` suffix:
`@tencentdb-agent-memory/memory-tencentdb-v2`, `memory-sdk-ts-v2`).
Docker image tags are independent of npm versions; this release's images are `:1.0.0-beta.1`.

> **Positioning**: turn agents' experience, docs, and code into reusable assets, so the next agent
> can pick up where the last one left off. See [README.md](./README.md).

### 🧠 Four memory asset types · fully open-sourced for the first time

All four asset types are distilled automatically from "conversation/work traces":

- **Chat Memory** — extracted layer by layer from conversations: L0 raw records → L1 facts → L2 scenes → L3
  long-term understanding; preferences, decisions, and interaction history persist across sessions.
- **Skill** — reusable SOPs distilled from completed tasks, with version / resource files / trigger boundaries /
  execution steps / validation rules.
- **Wiki** — turns documents into structured pages plus a link graph (inspired by Karpathy's LLM knowledge base
  practice).
- **CodeGraph** — indexes a repo's symbols / files / call relationships / impact paths, so the agent runs impact analysis
  before changing code.

### 🎛️ Memory Hub · Team console

Control panel (`agentmemory/memory-hub` image, including Panel + Knowledge Service):

- Create Teams / Agents and manage assets uniformly by Owner / version / status / visibility
- Three visibility levels: `private` / `team` / `restricted` (User / Role / Agent ACL),
  plus targeted `agent` assembly
- Agent Loadout: bind different assets to different Agents and adjust priority and usage
- Wiki + CodeGraph workshop built into the Hub; import a codebase/docs and it builds automatically

### 🔀 Memory Proxy · The channel that plugs agents into memory

`agentmemory/memory-proxy` lets coding agents such as Claude Code use team memory directly:

- **Anthropic / OpenAI dual protocol**: both `/claude-code/<spaceId>/v1/messages` and
  `/v1/chat/completions` are supported
- **First-turn onboarding**: sessionInit uses `AskUserQuestion` to let the user pick team / agent /
  task, and the proxy remembers the binding
- **Per-turn injection**: the agent's L2/L3 memory, matched skills, and wiki/code-graph
  are assembled into the system prompt and forwarded to the upstream LLM
- **Auth**: `x-tdai-user-key` → kernel `/v3/meta/auth/verify` exchanges it for a `user_id`,
  controlling asset visibility per user

### 🚀 One command brings up the full trio

All three images are published multi-arch (`linux/amd64` + `linux/arm64`) to
[Docker Hub `agentmemory`](https://hub.docker.com/u/agentmemory), publicly pullable
with no login:

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env    # fill in the two sets of LLM parameters
./start-all.sh                          # start everything
```

On first start, `start-all.sh` automatically runs `init-admin`, generates an admin `sk-mem-...` and saves it to
`.admin-key`; after self-checking `/v3/meta/auth/verify` it prints a copyable `claude` launch command.
`stop-all.sh --purge` fully clears the volumes and admin key for an easy reset.

See [INSTALL.md](./INSTALL.md).

### 🧰 Official SDKs

- **TypeScript** — `@tencentdb-agent-memory/memory-sdk-ts-v2`

  ```ts
  import { MemoryClient, SkillClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

  const memory = new MemoryClient({
    endpoint, apiKey, serviceId,
    teamId, agentId, userId,     // v3 strict isolation: all three are required
  });
  ```

  The top-level export is the v3 strict-isolation version; old code using the `.../v2/v3` subpath
  keeps working (the subpath is kept as a backward-compatible alias).

- **Python** — `pip install tencentdb-agent-memory-sdk-python`

  ```python
  from tencentdb_agent_memory import MemoryClient                     # default (v2 compatible)
  from tencentdb_agent_memory.v3 import MemoryClient, MetadataClient, SkillClient
  ```
