# New Client Adapter Development Guide

> **Purpose**: If you want to connect Memory Proxy to a new AI Agent client that is **not yet supported** (Aider / Cursor / some new desktop IDE / an in-house CLI / some future harness), follow this guide end to end: "capture traffic and survey → list the adaptation scope → 20 code steps → e2e passing". It has been proven on 5 clients (Claude Code / CodeBuddy / Codex / Workbuddy / dsh), and it captures the generic pitfalls and adaptation points hit each time so the next client doesn't have to rediscover them all.
>
> **Don't skip steps to save time** — every step was extracted from a pitfall someone hit. When you hit a problem, check [§3 Common Pitfalls Quick Reference](#phase-3-common-pitfalls-quick-reference) first.
>
> **Reference implementation**: dsh is the integration that hit the most pitfalls so far, and all its code is in this repo. See the [Reference Implementation: dsh (grouped by capability)](#reference-implementation-dsh-grouped-by-capability) section at the end — it lists, **capability by capability**, where dsh was changed, so you can copy it for your own client.

---

## Phase 0: Capture Traffic and Survey (30–60 minutes, no code changes)

**Why capture first**: assuming clients are equivalent = hitting a pitfall every time. **Every one** of the 5 clients differs in body shape / session_id header / metadata wrapper / options limit / ask-user tool name. **Pin down these 5 differences first**, then touch code.

### 0.1 Capture 3–5 real requests

Use **mitmproxy**:

```bash
pip3 install --user mitmproxy    # skip if already installed
mitmdump -p 8888 -s /tmp/capture.py --set stream_large_bodies=100m
```

The addon in `/tmp/capture.py` does one thing: it greps the target client's requests by `user-agent` and saves the request/response bodies as one JSON file each. Just replace the grep keyword with the new client's fingerprint.

**Key point**: Node ≥18 clients need `NODE_OPTIONS='--use-env-proxy'` to honor `HTTPS_PROXY` (undici ignores it by default). See [§3 Pitfall G](#pitfall-g-node-22-https_proxy-has-no-effect-when-capturing-traffic).

### 0.2 After capturing, fill in the table for the 5 differences

Create a `<client>-recon/` directory (outside this repo or locally) to store fixtures + analysis, and go through the table item by item:

| Dimension | What to look for in the capture |
|---|---|
| **body shape** | Is the main body field `messages[]` (OpenAI/Anthropic) or `input[]` (OpenAI Responses)? Is the user text in `messages[i].content[j].text`, `messages[i].content` (str), or `input[i].content[j].text`? |
| **session_id header** | Which headers are there, and which one is the sid? Is there a backup field in the body? |
| **First-turn metadata role=user** | Count how many role=user entries the client puts in `messages[]` and identify each one's stable signature (e.g. prefixes like `<system-reminder>` / runtime context / available_skills). Only the real user input should be treated by the proxy as the "user message"; other metadata entries must be filtered out |
| **ask-user tool name + shape** | Find the client source `packages/*/tool-ask-user/**` or similar and get the tool name + parameter schema (required fields / snake vs camel case) |
| **options limit** | Open the client UI source and search for `options.length` / `maxOptions` / `slice`; no truncation = no pagination needed |

**These 5 differences determine the subsequent code changes**. Missing any one of them means hitting a pitfall.

### 0.3 Decide whether an aux short-circuit is needed

Check whether the client sends **separate request types** (compaction / title-gen / memgen, etc.). Criteria:

- A separate endpoint path? (codex has `/responses/compact`; workbuddy is similar)
- A separate header? (dsh has `x-deepseek-harness-compact:1`)
- Body characteristics? (dsh title-gen relies on missing tools + `thinking.disabled` + `max_tokens ≤ 128` + system prompt prefix)

**For any client that sends aux requests, the adapter's `classifyRequest` must be able to detect them**. CC/CB are all main with no aux; codex/workbuddy/dsh all have aux.

---

## Phase 1: Adaptation Scope Overview (decide what to do first)

Memory Proxy does **at least** the following 10 things for a client. Don't jump straight into diffing dsh and copying code — **tick through the table below first**: which capabilities **must** work on the new client, which are **optional**, and which **don't apply**. Finish the list before moving on to Phase 2 so you have a clear sense of the workload.

| # | Capability | Problem it solves | Required? | Related modules |
|---|---|---|---|---|
| 1 | **Routing & allowlists** | Makes the proxy recognize the `/<client>/<spaceId>/...` path and adds `<client>` to the various regex allowlists; otherwise auth 401 / the request falls through to 404 | ✅ Required | `MemoryProxy/src/server.ts`, `MemoryProxy/src/credit-reporter.ts` |
| 2 | **Session ID resolution** | Finds a stable "unique conversation identifier" in the client's headers/body so all requests of one conversation land on the same sessionKey; if missed → all sessions collide on one key and session-init state gets corrupted | ✅ Required | `MemoryProxy/src/session/session-key.ts::resolveConversationId` |
| 3 | **Request classification (main / aux / headless)** | Distinguishes "real user conversation" from "client background auxiliary requests" (title-gen / compaction / memgen); aux must **skip all of** session-init / mem / injection / L0 / skill trigger and pass straight through | ✅ Required | `MemoryProxy/src/agent-adapters/<client>.ts::classifyRequest`, top of `MemoryProxy/src/handler.ts` |
| 4 | **User text extraction** | Picks the "real user input" string out of the body (for mem command detection / L0 archiving / skill extraction), skipping metadata role=user entries | ✅ Required | `MemoryProxy/src/agent-adapters/<client>.ts::extractUserText`, `MemoryProxy/src/session/store.ts::tryHistoryScan`, `MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation` |
| 5 | **Session Init Form** | On the first conversation, shows a 4-step form for the user to choose team / agent / task (`asset_confirm → team → agent → task`); the carrier is the `ask_user_question` (or equivalent) tool_call registered in the client preset | ⚠️ Required if the client is interactive; optional for pure CLI headless (use the bypass from Pitfall C) | `MemoryProxy/src/session/<client>/form.ts`, `MemoryProxy/src/session/index.ts` dispatch, `MemoryProxy/src/session/codebuddy/init.ts` split-stage gate |
| 6 | **Header pre-selection (skip the form)** | CI/CD / automation / clients that cannot respond to a form can send `x-team-id` + `x-agent-id` + `x-task-id` + `x-conversation-id` headers to register the session in one step; already supported generically, so most clients **need no code changes** | ➖ Optional (already generic) | No changes needed; handled generically by `MemoryProxy/src/session/registrar.ts` |
| 7 | **Asset injection (Injection)** | On every main-conversation turn, inserts asset blocks such as `<agent_skills>` / `<user_memory>` / `<session_context>` / `<tdai_profile_memory>` into the system message to deliver team memory to the LLM | ✅ Required | Use the existing `MemoryProxy/src/injection/adapters/{openai,anthropic}.ts`; if the client wire format has special fields (e.g. dsh `reasoning_content`), add a metadata round-trip |
| 8 | **Wire compatibility / special-field passthrough** | The client may strictly require certain non-standard fields to round-trip (dsh's `reasoning_content` / DeepSeek thinking chain); the injection pipeline's parse→serialize must not strip them | ⚠️ Only needed if the client has special fields | `parseMessage` / `serializeMessage` in `MemoryProxy/src/injection/adapters/openai.ts` or `anthropic.ts`, stored via `ContextMessage.metadata` |
| 9 | **Mem command interception** | When the user sends `mem:help` / `mem:sync` / `mem:create-skill` / `mem:session-reset` in the conversation, the proxy intercepts it and returns a short-circuit response (open the panel / refresh assets / trigger extraction / reset state) without calling the upstream LLM | ✅ Fully works when the client supports forms; headless-bypass clients support only some | The mem-command section of `MemoryProxy/src/handler.ts` (generic; works automatically as long as the `agentSource` is recognized) |
| 10 | **L0 archiving / Skill extraction** | Both directions of the main conversation are written via `tdai-recorder:write-l0`; when the conversation exceeds the threshold or the user force-archives, `skill/conversation/add` is triggered so core extracts skills | ✅ Required | Tail of `MemoryProxy/src/handler.ts` (generic; works automatically as long as the aux/headless criteria are correct) |
| 11 | **Observability / Langfuse** | Traces carry the `agent_source:<client>` tag, plus logs for each session-init stage and tool_call instrumentation, for production troubleshooting | ✅ Required (one-line tag, near-zero cost) | Injected generically via `agentAdapter.agentKind`; confirm the new `agent_source` appears in Langfuse trace tags |

**Decision rules**:

- Only when **every** "Required" capability is done is the integration basically usable
- "Optional" ones depend on the client's scenario (a CLI-only client can skip 5 and 9 and keep only 6, header pre-selection)
- The client has unique wire fields (e.g. DeepSeek thinking chain) → capability 8 is mandatory, otherwise upstream returns 400
- The client sends aux requests such as title-gen / compact → capability 3 is mandatory, otherwise aux requests wrongly show the form / wrongly write L0

**Effort estimate**: a full adaptation (covering 1–11), with the proven dsh reference available, takes roughly 3–4 working days for capture + coding + unit tests + e2e; unseen pitfalls are extra.

---

## Phase 2: Code Changes (20-step checklist, in order)

Map the capabilities ticked in the Phase 1 table to concrete files. Each step has a corresponding capability number (capability #1 = "Routing & allowlists", and so on).

### 2.1 Skeleton, 4 steps (30 minutes) — capabilities #1, #3, #4

| # | File | Change | Capability |
|---|---|---|---|
| 1 | `MemoryProxy/src/agent-adapters/<client>.ts` | New — `classifyRequest` with three signals + `extractUserText` | #3 #4 |
| 2 | `MemoryProxy/src/agent-adapters/types.ts` | Add `"<client>"` to the `AgentKind` union | #3 |
| 3 | `MemoryProxy/src/agent-adapters/index.ts` | Add a case to the factory switch | #3 |
| 4 | `MemoryProxy/src/server.ts` | Add 9 routes (with/without `v1` × main endpoint/aux/cost-guard/analyse marker); copy from the dsh section | #1 |

### 2.2 Allowlists & session identification, 3 steps — capabilities #1, #2, #7

| # | File | Change | Capability |
|---|---|---|---|
| 5 | `MemoryProxy/src/credit-reporter.ts::extractSpaceIdFromPath` | Add `\|<client>` to the regex — **if missed, auth returns 401 `missing service_id`** | #1 |
| 6 | `MemoryProxy/src/session/session-key.ts::resolveConversationId` | Add the client-specific session header to the header fallback chain | #2 |
| 7 | Skip if no separate profile is needed; otherwise add a set under `MemoryProxy/src/injection/agents/<client>/*` (see `MemoryProxy/src/injection/agents/workbuddy/`) | #7 |

### 2.3 Session Init Form carrier, 4 steps — capability #5

| # | File | Change | Capability |
|---|---|---|---|
| 8 | `MemoryProxy/src/session/<client>/form.ts` | New — tool name / parameter shape exactly per the client preset; don't reuse another client's | #5 |
| 9 | `MemoryProxy/src/session/index.ts` | Add a dispatch branch (see the workbuddy section: the CB state machine produces `formData`, then the outer layer re-renders it) | #5 |
| 10 | `MemoryProxy/src/session/codebuddy/init.ts` split-stage gate | Add `\|\| agentSource === "<client>"` to the 5 gates — if missed, agent+task are asked together in one go and it bypasses directly | #5 |
| 11 | `tool_call_id` regex in `MemoryProxy/src/session/codebuddy/cleaner.ts` | Add `\|<client>_` prefix recognition | #5 |

### 2.4 Metadata filtering & wire compatibility, 3 steps — capabilities #4, #8

| # | File | Change | Capability |
|---|---|---|---|
| 12 | `MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation` | Skip user counting based on the client's first-turn metadata signatures — if missed, it wrongly decides "has history" and skips session-init | #4 |
| 13 | `MemoryProxy/src/session/store.ts::tryHistoryScan` | Same filtering logic | #4 |
| 14 | Wire special-field round-trip (e.g. dsh's `reasoning_content`) — preserve via metadata in parse/serialize of `MemoryProxy/src/injection/adapters/openai.ts` or `anthropic.ts`; must be verified by comparing inbound/outbound body dumps with the debug env vars | #8 |

### 2.5 Handler short-circuits, 2 steps — capabilities #3, #5, #9, #10

| # | File | Change | Capability |
|---|---|---|---|
| 15 | Top of `MemoryProxy/src/handler.ts` | Call `agentAdapter.classifyRequest(body, path, headers)` to classify; when `isAuxiliary=true`, **skip all of** session-init / mem / injection / L0 / skill trigger and pass straight through | #3 #9 #10 |
| 16 | Top of `MemoryProxy/src/handler.ts` | If the client has a CLI headless scenario (preset has fewer tools and no ask-user), add a `_headless` criterion like dsh's that skips the form just like aux; mem commands show a hint or fall back to header pre-selection | #5 #9 |

### 2.6 Testing & verification, 4 steps — capabilities #5, #9, #10, #11

| # | Content | Capability |
|---|---|---|
| 17 | Unit tests: adapter `classifyRequest` + form builder shape + real-capture fixture end to end — in `MemoryProxy/src/__tests__/agent-adapters/<client>.test.ts` + `MemoryProxy/src/session/<client>/__tests__/form.test.ts` | #3 #5 |
| 18 | curl smoke: hit `/<client>/default/*` directly to trigger the form and verify session-init state transitions (`asset_confirm → team → agent → task`) | #5 |
| 19 | Web e2e (playwright recommended): **actually run the client web UI once** (4 session-init steps + 1 real conversation turn, verifying injection + archiving + Langfuse trace) | #5 #7 #10 #11 |
| 20 | mem / L0 / skill end to end: in an initialized session send `mem:help` / `mem:sync` / `mem:create-skill` / a long conversation to trigger skill extraction / grep the proxy log to verify the L0 write | #9 #10 |

---

## Phase 3: Common Pitfalls Quick Reference

Each of the first 5 clients hit at least 3 pitfalls. **Check here before debugging on your own**.

### Pitfall A: `missing service_id (spaceId not in request path)` 401

**Root cause**: the allowlist regex in `credit-reporter.ts::extractSpaceIdFromPath` doesn't include the new client name.

**Fix**: add it to `^(claude-code|codebuddy|codex|cursor|openclaw|workbuddy|dsh|<new-client>)$`.

### Pitfall B: the session-init form shows up wrong / or never shows up

- **Never shows up** = the `resolveConversationId` fallback doesn't recognize the client's session header → sessionKey falls back to keyId, or `isFreshCBConversation` treats the first-turn metadata user entries as "has history" → markerless bypass.
  - Fix the `session-key.ts` fallback chain + `codebuddy/init.ts::isFreshCBConversation` + add metadata signature filtering to `store.ts::tryHistoryScan`
- **Shows up, but no task prompt after choosing the agent** = the split-stage gate wasn't extended to the new client → falls into CB's old combined pending_agent_task question → empty task bypasses directly.
  - Fix: add `|| agentSource === "<client>"` to the 5 gates in `codebuddy/init.ts`
- **Infinite paging loop / the default task appears at the top of every page** = reused CC's 4-per-page pagination without MORE interception.
  - Fix: if the client UI has no options limit, **turn pagination off and render everything** (that's what dsh does)

### Pitfall C: upstream 400 `unknown tool ""`

**Root cause**: the client preset doesn't register `ask_user_question` (or this client's UI tool), so the fake `tool_call` inserted by the proxy fails validation.

**Fix**: add a headless bypass — when `body.tools` is non-empty but lacks that tool, pass through directly without showing the form.

### Pitfall D: upstream 400 `The reasoning_content in the thinking mode must be passed back to the API`

**Root cause** (two pitfalls hit together):

1. The fake session-init assistant message doesn't carry a `reasoning_content` field
2. An empty string `""` was inserted → the client's translate.ts drops it via a `length > 0` check

**Fix**: put a **non-empty** placeholder string in the fake response (e.g. `[proxy session-init form]`).

**Secondary pitfall**: with a non-empty placeholder the client does replay it back to the proxy, but **the injection pipeline's parse→serialize strips the field**.

- Use the two env vars `PROXY_DEBUG_DUMP_INBOUND` + `PROXY_DEBUG_DUMP_BODY` to capture inbound/outbound bodies and compare.
- Fix `parseMessage`/`serializeMessage` in `MemoryProxy/src/injection/adapters/openai.ts` / `anthropic.ts` to store passthrough fields in `ContextMessage.metadata`.

### Pitfall E: aux requests (compaction / title) wrongly go through session-init and show the form

**Root cause**: no `classifyRequest` at the top of `handler.ts`, so every request is treated as main.

**Fix**: call `agentAdapter.classifyRequest(body, path, headers)` at the top of `handler.ts`; when `isAuxiliary=true`, **skip all of** session-init / mem / injection / L0 / skill trigger.

### Pitfall F: client-specific wire fields (e.g. `reasoning_content`) lost in round-trip

See the secondary pitfall of Pitfall D. **General approach**: compare inbound/outbound fields with `PROXY_DEBUG_DUMP_INBOUND` + `PROXY_DEBUG_DUMP_BODY`; if any field is lost, patch the adapter.

### Pitfall G: Node 22 HTTPS_PROXY has no effect when capturing traffic

**Fix**: add `NODE_OPTIONS='--use-env-proxy'`. It's experimental in undici, but currently the only option.

### Pitfall H: capturing in headless mode and concluding a tool doesn't exist

**Lesson**: the preset system decides the tools, and different profiles registering different tools is normal. **The tools array in web / tui scenarios is always more complete than in headless**. Capture from web if possible, or capture both once.

---

## Done Criteria

The adaptation is complete only when **all** of the following are verified (the left column shows the capability number):

| Capability | Done criterion |
|---|---|
| #1 Routing | `curl -X POST /<client>/default/chat/completions` returns neither 404 nor 401 `missing service_id` |
| #2 sessionKey | Multiple requests with the same session_id show the same `sessionKey=` in the proxy log |
| #3 Request classification | For aux requests (compaction / title-gen) the proxy log shows `[request-classify] → auxiliary (skip ...)` and they pass straight through |
| #5 Session Init | The first turn returns the form (role=assistant + the `tool_call` is the client preset's ask-user tool name); playwright completes the 4 steps `asset_confirm → team → agent → task` |
| #7 Injection | Upstream returns 200 for the main conversation, and the system message upstream sees contains asset blocks such as `<agent_skills>` / `<user_memory>` |
| #8 Wire compatibility | Upstream **does not return** 400 for the main conversation (`reasoning_content` / `unknown tool` / `invalid_request_error`) |
| #9 Mem commands | The three commands `mem:help` / `mem:sync` / `mem:create-skill` are intercepted and return short-circuit responses |
| #10 L0 & skill | `tdai-recorder:write-l0` in the proxy log means L0 was persisted; `[skill-conversation-add] archived reason=tool_calls` means skill extraction was triggered |
| #11 Observability | Langfuse traces carry the `agent_source:<client>` tag |
| — Unit tests | `npx vitest run src/session/<client> src/__tests__/agent-adapters/<client>.test.ts` all green |
| — Full test suite | `npx vitest run` with zero regressions |

---

## Reference Implementation: dsh (grouped by capability)

dsh is the integration that **hit the most pitfalls and has the most complete coverage so far**. The table below follows the capability numbers of the [Phase 1 adaptation scope](#phase-1-adaptation-scope-overview-decide-what-to-do-first) and lists **where in the code dsh implements each capability**, so you can copy it for your own client and rename.

| Capability | dsh implementation location | Notes |
|---|---|---|
| #1 Routing & allowlists | dsh section of `MemoryProxy/src/server.ts` (9 routes)<br>`MemoryProxy/src/credit-reporter.ts::extractSpaceIdFromPath` | Main `/chat/completions` × (with/without v1) × (main/aux/cost-guard/analyse marker) combinations |
| #2 Session ID resolution | `MemoryProxy/src/session/session-key.ts::resolveConversationId` (`x-deepseek-harness-session-id` fallback) | dsh gets the sid only from the header; no body fallback |
| #3 Request classification | `MemoryProxy/src/agent-adapters/dsh.ts::classifyRequest`<br>aux short-circuit at the top of `MemoryProxy/src/handler.ts` | Three signals: compact header > title body-shape > main |
| #4 User text & metadata filtering | `MemoryProxy/src/agent-adapters/dsh.ts::extractUserText`<br>`MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation`<br>`MemoryProxy/src/session/store.ts::tryHistoryScan` | dsh puts 3 metadata role=user entries in the first turn; skipped by signature match |
| #5 Session Init Form | `MemoryProxy/src/session/dsh/form.ts` (tool = `ask_user_question`, call_id prefix `call_dsh_session_init_`)<br>dsh dispatch branch in `MemoryProxy/src/session/index.ts`<br>`agentSource === "dsh"` added to the 5 split-stage gates in `MemoryProxy/src/session/codebuddy/init.ts`<br>`dsh_` prefix added to the `tool_call_id` regex in `MemoryProxy/src/session/codebuddy/cleaner.ts` | Reuses the CB state machine; the dsh UI has no options limit, so **no pagination** |
| #7 Injection | Reuses `MemoryProxy/src/injection/adapters/openai.ts` (no separate profile) | dsh is standard OpenAI Chat; the injection template follows CB's |
| #8 Wire compatibility | `MemoryProxy/src/injection/adapters/openai.ts::parseMessage`/`serializeMessage` (`reasoning_content` preserved via `ContextMessage.metadata`) | The DeepSeek thinking chain is strictly validated and must round-trip |
| #9 Mem commands | The generic mem-command section works automatically; degrades only in dsh headless (`handler.ts::_dshHeadless` criterion) | Headless-bypass clients get a dedicated degraded hint for `mem:session-reset` |
| #10 L0 & Skill | The generic handler tail works automatically; skipped when `_dshHeadless` (the relevant `if !_dshHeadless` in `handler.ts`) | No dsh-specific handling needed once the aux criterion is correct |
| #11 Observability | `agentAdapter.agentKind = "dsh"` is injected generically into Langfuse trace tags | No extra instrumentation code needed |
| — Headless Bypass (dsh-only capability) | `MemoryProxy/src/handler.ts::_dshHeadless` (`body.tools` non-empty but no `ask_user_question` → bypass) | dsh CLI scenarios have no preset, so the whole flow skips form / mem / injection |
| — Unit tests (39, the most complete fixture set) | `MemoryProxy/src/__tests__/agent-adapters/dsh.test.ts` (19 adapter tests)<br>`MemoryProxy/src/session/dsh/__tests__/form.test.ts` (17 form tests)<br>`MemoryProxy/src/injection/adapters/__tests__/openai.test.ts` (3 openai round-trip tests) | Copying and renaming to your client mostly just works |

For user-facing configuration docs (baseURL / config files / session-init interaction flow from the user's perspective), see [`agents/dsh/README.md`](./dsh/README.md).
