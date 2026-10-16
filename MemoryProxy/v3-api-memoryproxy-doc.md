# v3 API Reference · Volume 3: MemoryProxy

> Service: MemoryProxy (LLM reverse proxy + injection proxy), port `8096`
> This volume covers every `/v3/*` endpoint exposed by MemoryProxy (**6 in total**, all ops/admin). MemoryCore is in Volume 1, MemoryKnowledge in Volume 2.
> Maintenance rule: any endpoint change must update this document in the same PR.

---

## 1. Common Conventions

### 1.1 Service and Port

| Item | Value |
|---|---|
| Service | MemoryProxy |
| Port | 8096 |
| Prefix in this volume | `/v3` (ops/admin plane only; **the main LLM path is `/v1/messages`, `/:agent/:spaceId/v1/*`, etc., which is outside the scope of the v3 docs**) |
| Health check | `GET /health` (not v3; returns bare JSON including status/version/upstream/storage, etc.) |
| `GET /whoami` | Not v3; API key → key ID (plain text) |

### 1.2 Envelope (**not uniform; two kinds**)

MemoryProxy's v3 endpoints use two envelope kinds, **both different from Volume 1 MemoryCore and Volume 2 MemoryKnowledge**:

| Endpoint group | Envelope | Notes |
|---|---|---|
| `instance/proxy-destroy`, `admin/rate-limits` (3 methods) | `{ code, message, data }` | **No `request_id`** (same style as Volume 2 KS) |
| `session/refresh-cache`, `session/force-archive-skill` | `{ code, message, request_id, data }` | Has `request_id`, valued `refresh-${Date.now()}` / `force-archive-${Date.now()}` |

Success is always `code=0, message="ok"`.

### 1.3 Authentication (**only 1 endpoint is authenticated**)

| Endpoint | Auth |
|---|---|
| `POST /v3/instance/proxy-destroy` | `Authorization: Bearer <admin.apiKey>`; **public when `admin.apiKey` is not configured** (`checkAdminAuth` lets an empty key through). Uses `timingSafeEqual` for constant-time comparison |
| `admin/rate-limits` (GET/PUT/DELETE) | **No auth** |
| `session/refresh-cache`, `session/force-archive-skill` | **No auth** |

> ⚠️ Implementation and comments disagree: the header comments in `session-refresh.ts` / `session-force-archive.ts` say they "use admin auth (reusing the admin-auth.ts pattern)", but **the handlers never actually call `checkAdminAuth`**, so they are currently unauthenticated. This document records the code's actual behavior; if the frontend/ops rely on auth, it needs separate hardening.

### 1.4 Error Code Characteristics (**two groups**)

| Endpoint group | Failure code | HTTP status |
|---|---|---|
| `proxy-destroy`, `rate-limits` | Standard 3-digit (400/401/503) | = code |
| `session/*` | **5-digit number** (40001/40401/50001) | 3-digit (400/404/500), **code ≠ HTTP** |

> On `session/*` failures, `code` is a 5-digit number and `message` is plain text, but the HTTP status is a standard 3-digit code (`status = error.includes("not found") ? 404 : 400/500`). Frontends should note that code and HTTP status are decoupled here.

### 1.5 Identity and Auth Headers

The ops endpoints in this volume **do not check** `x-tdai-service-id` / `x-tdai-user-key` (unlike the Volume 1 data plane); only `proxy-destroy` checks a Bearer token.

---

## 2. Endpoint Index

| Method | Path | Description |
|---|---|---|
| POST | `/v3/instance/proxy-destroy` | Ops: clear proxy-side instance cache + STS pool (the only authenticated one) |
| GET | `/v3/admin/rate-limits` | Get rate-limit config (global / dimension override) |
| PUT | `/v3/admin/rate-limits` | Set rate-limit config (global / dimension override) |
| DELETE | `/v3/admin/rate-limits` | Delete rate-limit config (restore defaults / remove override) |
| POST | `/v3/session/refresh-cache` | Refresh the session injection cache (re-fetch agent/task detail + prewarm) |
| POST | `/v3/session/force-archive-skill` | Manually force-archive the session skill buffer |

**6 endpoints in total (4 routes; rate-limits accounts for 3 HTTP methods).**

---

## 3. Endpoint Details

## 3.1 Instance Destroy

### POST /v3/instance/proxy-destroy

Clears the proxy-side cached data for an instance (spaceId) + the STS backend in the kernel-sts pool. Contract field names match Core's `/v3/instance/destroy`; the path uses the `proxy-destroy` action to distinguish it.

**Auth**: `Authorization: Bearer <admin.apiKey>` (public if not configured).

**Request body**: `{ instance_id: string }` (non-empty, no `/`, no `..`; validated with the shared `assertKeySegment`).

**Response** `data`

| Field | Type | Description |
|---|---|---|
| instance_id | string | Echoed back |
| cleaned.storage_backend | string | `cos` / `sqlite` / `fs` / `memory` |
| cleaned.storage_ttl_deleted | number | Number of entries deleted under the `ttl/<id>/` prefix; defaults to 0 |
| cleaned.storage_nottl_deleted | number | Number of entries deleted under the `nottl/<id>/` prefix |
| cleaned.cos_pool_evicted | string | `evicted` / `not-cached` / `unsupported` / `error` |
| cleaned.redis_skipped | string | Always `per-session-ttl-only` |

**Partial-failure policy**: a failed step does not abort the whole operation; `cleaned` includes the corresponding `storage_ttl_error` / `storage_nottl_error` / `cos_pool_error` field (HTTP is still 200).

**Errors**: `400` (invalid JSON / missing instance_id / illegal characters), `401` (auth enabled and Bearer missing or mismatched).

> The Redis session store (`cg:sess:*`) is **not cleared**: the sessionKey comes from `x-conversation-id` / `x-claude-code-session-id` and does not contain the spaceId, so it cannot be SCANned by space; entries expire naturally after the default 1800s TTL.

**Example**

```json
// Request
POST /v3/instance/proxy-destroy
Authorization: Bearer <admin.apiKey>
{ "instance_id": "mem-example001" }

// Response
{
  "code": 0,
  "message": "ok",
  "data": {
    "instance_id": "mem-example001",
    "cleaned": {
      "storage_backend": "cos",
      "storage_ttl_deleted": 3,
      "storage_nottl_deleted": 5,
      "cos_pool_evicted": "evicted",
      "redis_skipped": "per-session-ttl-only"
    }
  }
}
```

---

## 3.2 Rate-Limit Config (3 methods, all unauthenticated)

> Rate limiting has two levels: **global** (`config.rateLimit`) and **dimension override** (`instance_id + model_id`). A dimension override takes precedence over global.

### GET /v3/admin/rate-limits

Get the rate-limit config.

**Query**: `instance_id` + `model_id` (**must be provided together**).

**Response** `data`:

- Without parameters (global): `{ enabled, tpm, qpm, window_seconds: 60, overrides: [...] }`
- With instance_id+model_id (dimension): `{ enabled, instance_id, model_id, input_tpm, qpm, source: "global"|"override", global }`

**Errors**: `400` (only one of instance_id or model_id provided), `503` (store error).

### PUT /v3/admin/rate-limits

Set the rate-limit config.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| input_tpm | number | Yes | Input tokens/minute, **positive integer** |
| qpm | number | Yes | Requests/minute, **positive integer** |
| instance_id | string | No | Paired with model_id |
| model_id | string | No | Paired with instance_id (≤256, no control characters) |

**Response** `data`: without a dimension returns `{ tpm, qpm }`; with a dimension returns `{ instance_id, model_id, input_tpm, qpm }`.

**Errors**: `400` (invalid JSON / not a positive integer / only one dimension field / invalid model_id), `503`.

**Example**

```json
// Request (set global)
PUT /v3/admin/rate-limits
{ "input_tpm": 100000, "qpm": 300 }

// Response
{ "code": 0, "message": "ok", "data": { "tpm": 100000, "qpm": 300 } }
```

### DELETE /v3/admin/rate-limits

Delete the rate-limit config (restore defaults).

**Request body**: optional `instance_id` + `model_id` (paired).

**Response** `data`: without a dimension returns `{ tpm, qpm }` (falls back to config defaults); with a dimension returns `{ instance_id, model_id, deleted: true }`.

**Errors**: `400`, `503`.

---

## 3.3 Session Management (2, both unauthenticated)

> Both endpoints are the underlying implementation of the `mem:` commands (via function call) and are also exposed over HTTP for reuse by the panel frontend.

### POST /v3/session/refresh-cache

Refreshes all injection caches for the current session: re-fetches Agent/Task detail and overwrites it in the SessionStore → reruns `prewarmFromConfig` with `clearBefore=true` (clearing stale snapshots of unbound assets).

**Request body**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| session_key | string | Yes | — | Session key |
| agent_source | string | No | `claude-code` | Proxy source; builds `compositeKey = ${agentSource}:${sessionKey}` |
| user_key | string | No | — | Caller key passed to MetadataClient |
| space_id | string | No | — | Fallback spaceId |

**Response** `data`

| Field | Type | Description |
|---|---|---|
| refreshed | string[] | hookIds refreshed successfully |
| skipped | string[] | hookIds skipped |
| agent_refreshed | boolean | Whether agent detail was re-fetched successfully |
| task_refreshed | boolean | Whether task detail was re-fetched successfully |
| took_ms | number | Elapsed time |

**Errors**: `40001` (invalid JSON / missing session_key / `Session not initialized` / other parameter errors), `40401` (session not found). Failure messages are plain text (`session_key is required`, `Session not initialized: xxx`, `Session not found: xxx`).

**Example**

```json
// Request
POST /v3/session/refresh-cache
{ "session_key": "sess_1", "agent_source": "claude-code", "space_id": "mem-example001" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "refresh-1724112000000",
  "data": {
    "refreshed": ["memory", "knowledge"],
    "skipped": ["skill"],
    "agent_refreshed": true,
    "task_refreshed": false,
    "took_ms": 120
  }
}
```

### POST /v3/session/force-archive-skill

Manually force-archives the current session's skill buffer (the third trigger condition, bypassing the threshold check).

**Request body**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| session_key | string | Yes | — | Session key |
| agent_source | string | No | `claude-code` | Proxy source |
| reason | string | No | — | Archive reason (passed through to Core) |
| space_id | string | No | — | Fallback spaceId |

**Response** `data`

| Field | Type | Description |
|---|---|---|
| status | string | `archived` / `empty` |
| task_id | string? | Archive task ID (only when archived) |
| archive_key | string? | Archive key |
| archived_at_ms | number? | Archive time (ms) |

**Errors**: `40001` (invalid JSON / missing session_key), `40401` (session not found), `50001` (Core `forceArchive` call failed).

**Example**

```json
// Request
POST /v3/session/force-archive-skill
{ "session_key": "sess_1", "reason": "manual" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "force-archive-1724112000000",
  "data": { "status": "archived", "task_id": "skl_1", "archive_key": "archive/xxx", "archived_at_ms": 1724112000000 }
}
```

---

## 4. Appendix

### 4.1 Cross-Service Differences Across the Three Volumes

| Dimension | MemoryCore (Volume 1) | MemoryKnowledge (Volume 2) | MemoryProxy (this volume) |
|---|---|---|---|
| Port | 8420 | 8421 | 8096 |
| Envelope | `{ code, message, request_id, data }` | `{ code, message, data }` | **Two kinds mixed** (see §1.2) |
| Auth | Layered Bearer + service-id + user-key | `x-tdai-service-id` only | Only proxy-destroy checks Bearer; the rest are unauthenticated |
| Methods | All POST | All POST except auto-sync status | **Includes GET/PUT/DELETE** (rate-limits) |
| Failure code | Three kinds (enum / 5-digit / CODE:detail) | Standard 3-digit | proxy-destroy/rate-limits 3-digit; session/* 5-digit |

### 4.2 Known Implementation Deviations (documented per actual code)

| File | Comment claims | Actual implementation |
|---|---|---|
| `session-refresh.ts` | "uses admin auth" | Does not call `checkAdminAuth`; unauthenticated |
| `session-force-archive.ts` | Same as above (not stated explicitly in the comment, but same family) | Unauthenticated |
| `admin/rate-limits` | — | Unauthenticated (hardening recommended if protection is needed) |

### 4.3 Boundary with the Main LLM Path

This volume covers only the `/v3/*` ops endpoints. MemoryProxy's core is the **LLM reverse proxy** (`/v1/messages`, `/v1/chat/completions`, `/:agent/:spaceId/v1/*`, `/codex·workbuddy·dsh/:spaceId/*`, etc.) and the **bridges** (`/skill-bridge/*`, `/memory-bridge/*`). These are **outside the scope of the v3 API docs** and should get a separate volume if they need documenting.
