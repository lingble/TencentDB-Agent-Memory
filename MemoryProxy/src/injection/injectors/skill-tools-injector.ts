/**
 * Skill Tools Injector — injects a static `<skill_tools>` block describing
 * cloud-skill operations as curl recipes.
 *
 * Why static: the LLM does NOT see these as native tools (we don't push to
 * `body.tools` — the agent host wouldn't know how to handle them). Instead
 * the LLM uses its existing Bash tool to curl `<proxy_base>/skill-bridge/...`,
 * which the proxy's `/skill-bridge/*` reverse proxy then forwards to core
 * with auth + IdFields injected from the session.
 *
 * The block is rendered once per session (at session_init prewarm) — its
 * content depends only on the proxy base URL, which is stable for the
 * session.
 *
 * Tools injected:
 *   Always (read-only): skill_search, skill_view, skill_files_read,
 *                       skill_extract
 *   Only when allowLlmWrite=true: skill_create, skill_update, skill_patch,
 *                                skill_delete, skill_files_write, skill_files_remove
 *
 * Note: skill_list is intentionally omitted — the <available_skills> block
 * already provides the agent's owned skill catalogue at session init.
 *
 * Sister hook: `skill-injector.ts` produces the dynamic `<available_skills>`
 * block (agent-owned skill listing from /v3/skill/listing).
  *
 * See `docs/design/2026-06-17-team-skill-proxy-runtime.md` §4.
 */

import type {
  AgentContext,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";

export interface SkillToolsInjectorConfig {
  /**
   * Base URL the LLM should curl. Filled into every `<tool>` recipe.
   * E.g. `http://127.0.0.1:8096`. Trailing slash trimmed.
   */
  proxyBaseUrl: string;
  /**
   * 是否允许主模型创建/修改 skill。默认 false。
   * false 时只注入只读工具（search/list/view/files_read）。
   * 显式设为 true 后注入全部 10 个工具。
   */
  allowLlmWrite?: boolean;
}

/**
 * Render the entire `<skill_tools>` block as a single text string. Pure
 * function for ease of testing.
 */
export function renderSkillToolsBlock(
  proxyBaseUrl: string,
  allowLlmWrite = true,
  sessionId?: string,
  spaceId?: string,
): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/skill-bridge/v3/skill`;

  // gateway 需要 `x-tdai-service-id: <spaceId>` 才放行；`x-conversation-id`
  // 让 proxy 复用 session 里的身份 (user_id / team_id / agent_id)。
  const sessionHeader = sessionId ? ` -H 'x-conversation-id: ${sessionId}'` : "";
  const tenantHeader = spaceId ? ` -H 'x-tdai-service-id: ${spaceId}'` : "";
  const authHeader = `${tenantHeader}${sessionHeader}`;

  // ── skill_view 用 skill_id(get) 还是 skill_name(get-by-name) ──
  // 默认 id → skill_view 打 /get，body 传 skill_id（配合 available_skills 渲染带 id）。
  // SKILL_VIEW_MODE=name → 回退到 /get-by-name + skill_name（旧行为）。
  // 依据 skill_eval v9(name) vs v10(id) 对比实验：id 模式有调用时 correct% 更高、unknown 减半。
  const skillViewMode = (process.env.SKILL_VIEW_MODE ?? "id").toLowerCase() === "name" ? "name" : "id";
  const skillViewTool =
    skillViewMode === "id"
      ? [
          `  <tool name="skill_view">`,
          `    path: ${bridge}/get`,
          `    body: {"skill_id": "<skill id, e.g. skl-xxx>", "include_content": true, "include_manifest": true}`,
          `    use:  **The entry point for opening a skill**: returns the full SKILL.md plus the resource directory tree (manifest). To read the bytes of a resource file, you MUST call this tool first, pick a path from the manifest, then use skill_files_read. Take skill_id from the \`id=\` field on each line of <available_skills> (e.g. skl-xxxxxx), or from the skill_id field in skill_search results.`,
          `  </tool>`,
        ]
      : [
          `  <tool name="skill_view">`,
          `    path: ${bridge}/get-by-name`,
          `    body: {"skill_name": "<skill name>", "include_content": true, "include_manifest": true}`,
          `    use:  **The entry point for opening a skill**: returns the full SKILL.md plus the resource directory tree (manifest). To read the bytes of a resource file, you MUST call this tool first, pick a path from the manifest, then use skill_files_read. Use the name from the \`- name: description\` lines in <available_skills> as skill_name, or the name field in skill_search results.`,
          `  </tool>`,
        ];

  const readTools = [
    `  <tool name="skill_search">`,
    `    path: ${bridge}/search`,
    `    body: {"query": "keywords describing the skill you are looking for (required, >=1 character)"}`,
    `    use:  Search by keyword + semantics among the skills **you have permission to access in your team** (across agents, but **excluding** skills others have set to private — consistent with what the frontend "Team Assets" tab shows). query must be a non-empty string; 2-5 relevant keywords are recommended. When the skills you already have are not enough, use this to discover other skills available in the team. The number of results is fixed by the server; if the results are poor, retry with a different set of keywords, and do not add other fields such as top_k/mode to the body (they are ignored).`,
    `  </tool>`,
    "",
    // 暂时下线：<available_skills> 块已经注入 agent 自带的 skill 列表，功能重叠。
    // 后续如果需要分页刷新（skill 太多截断时）再恢复。
    // `  <tool name="skill_list">`,
    // `    path: ${bridge}/list`,
    // `    body: {"filters": {"owner_agent_id": "?可选", "name_prefix": "?可选"}, "pagination": {"limit": 50}}`,
    // `    use:  列出 head + active skill；按 owner / 前缀过滤`,
    // `  </tool>`,
    // "",
    ...skillViewTool,
    "",
    `  <tool name="skill_files_read">`,
    `    path: ${bridge}/files/read`,
    `    body: {"skill_id": "skl-xxx", "path": "scripts/run.sh", "encoding": "utf-8|base64"}`,
    `    use:  read the content of a single resource file. **You MUST call skill_view first to get the manifest**, and pick skill_id + path from it; otherwise this tool cannot locate the file. Returns a JSON envelope by default (with base64/utf-8 encoded bytes).\n    To download to local disk: append -o <local path> to the curl; the proxy returns the raw bytes, which are written straight to the file and never enter the context. Downloaded scripts need chmod +x before they are run.`,
    `  </tool>`,
    "",
    `  <tool name="skill_extract">`,
    `    path: ${bridge}/extract`,
    `    body: {"reason": "?optional, briefly explain why the current conversation is worth extracting as a skill (being clear helps the background extractor identify boundaries)"}`,
    `    use:  archive the current conversation now and trigger one skill extraction (an async task: a background agent analyzes the conversation and generates a skill). The proxy takes identity from the session and uses the conversation buffer accumulated on the core side, so you do not need to pass messages. Good to trigger proactively when "the user has just completed a full workflow that is worth reusing".`,
    `  </tool>`,
  ];

  const writeTools = [
    `  <tool name="skill_create">`,
    `    path: ${bridge}/create`,
    `    body: {"name": "string", "content": "full SKILL.md (including frontmatter)", "resources": "?optional array"}`,
    `    use:  create a new skill; owner is automatically the current agent`,
    `  </tool>`,
    "",
    `  <tool name="skill_update">`,
    `    path: ${bridge}/update`,
    `    body: {"skill_id": "skl-xxx", "content": "new SKILL.md"}`,
    `    use:  replace SKILL.md (version+1)`,
    `  </tool>`,
    "",
    `  <tool name="skill_patch">`,
    `    path: ${bridge}/patch`,
    `    body: {"skill_id": "skl-xxx", "old_string": "...", "new_string": "...", "replace_all": false}`,
    `    use:  substring replacement in SKILL.md (avoids large diffs)`,
    `  </tool>`,
    "",
    `  <tool name="skill_delete">`,
    `    path: ${bridge}/delete`,
    `    body: {"skill_id": "skl-xxx"}`,
    `    use:  permanently delete all versions of the skill`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_write">`,
    `    path: ${bridge}/files/write`,
    `    body: {"skill_id": "skl-xxx", "files": [{"path": "scripts/x.sh", "content": "...", "encoding": "utf-8", "is_executable": true}]}`,
    `    use:  add/modify resource files (version+1)`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_remove">`,
    `    path: ${bridge}/files/remove`,
    `    body: {"skill_id": "skl-xxx", "paths": ["scripts/old.sh"]}`,
    `    use:  delete resource files (version+1)`,
    `  </tool>`,
  ];

  const note = allowLlmWrite
    ? "Error handling: the response is a `{code, message, request_id, data?}` envelope; `code != 0` means a business error. Common ones:"
    : "Note: only read-only operations are currently available. Contact an administrator if you need to create/modify skills.\nError handling: the response is a `{code, message, request_id, data?}` envelope; `code != 0` means a business error. Common ones:";

  const readErrors = [
    "- 40001 parameter validation failed: a body field is missing or malformed; see the specific field name in message.",
    "- 40101 session not initialized: the session was not recognized (you are probably using this tool in the wrong conversation environment).",
    "- 40401 SKILL_NOT_FOUND: the skill does not exist or does not belong to your agent; use skill_search first to find similar skills.",
    "- 50301 upstream unavailable: core is temporarily unreachable; retry later.",
  ];
  const writeErrors = [
    "- 40301 SKILL_NOT_OWNER: you are not the owner and cannot modify it.",
    "- 40901 SKILL_VERSION_STALE: the version is stale; call skill_view to get the latest version before writing.",
    "- 42201 SKILL_NAME_DUPLICATE: the name already exists in the same team.",
    "- 42202 SKILL_PATCH_NOT_UNIQUE: old_string is not unique; pass replace_all=true.",
  ];

  return [
    "<skill_tools>",
    "Below are the cloud skill operation tools. **These are not local tools**; run them with Bash by calling curl against the proxy's skill-bridge path.",
    "The proxy injects identity and auth automatically (user_id / team_id / agent_id are determined by the session), so you only need to pass the business fields in the body.",
    "",
    "Call template:",
    `  curl -sSk -X POST <bridge>/<action> -H 'content-type: application/json'${authHeader} -d '{...business fields...}'`,
    `  where <bridge> = ${bridge}`,
    "",
    "Available tools:",
    "",
    ...readTools,
    ...(allowLlmWrite ? [""] : []),
    ...(allowLlmWrite ? writeTools : []),
    "",
    note,
    ...readErrors,
    ...(allowLlmWrite ? writeErrors : []),
    "</skill_tools>",
  ].join("\n");
}

/**
 * Skill tools injector.
 *
 * Anchor: lands BEFORE the `skills` slot (CodeBuddy: `<agent_skills>`),
 * priority just before SkillInjector so `<skill_tools>` reads naturally
 * before `<cloud_skills>`.
 */
export class SkillToolsInjector implements InjectionHook {
  id = "skill-tools-injector";
  point = "system.before_tools" as const;
  /** Place ahead of `<available_skills>` (which uses slot=skills, before). */
  anchor: AnchorTarget = { slot: "skills", relation: "before" };
  /** Slightly higher priority than SkillInjector so this block precedes it. */
  priority: HookPriority = HOOK_PRIORITY.SKILL - 1;
  description = "Inject the static <skill_tools> curl-recipe block.";
  /** Block content depends only on proxy base URL — fully session-static. */
  cacheStrategy: CacheStrategy = "session_init";

  constructor(private config: SkillToolsInjectorConfig) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { skill?: boolean } | undefined;
    if (caps?.skill === false) return [];
    return this.renderBlocks(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.skill === false) return [];
    return this.renderBlocks(undefined, input.sessionInfo.session_id, input.sessionInfo.space_id);
  }

  private renderBlocks(ctx?: AgentContext, prewarmSessionId?: string, prewarmSpaceId?: string): ContextBlock[] {
    const allowLlmWrite = this.config.allowLlmWrite ?? false;

    let sessionId = prewarmSessionId;
    let spaceId = prewarmSpaceId;
    if (ctx) {
      const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
      const session = custom?.session as Record<string, unknown> | undefined;
      const sid = session?.session_id;
      if (typeof sid === "string" && sid.length > 0) {
        sessionId = sid;
      }
      const sp = session?.space_id;
      if (typeof sp === "string" && sp.length > 0) {
        spaceId = sp;
      }
    }

    const content = renderSkillToolsBlock(this.config.proxyBaseUrl, allowLlmWrite, sessionId, spaceId);
    return [{
      type: "text",
      content,
      metadata: {
        source: this.id,
        // Stable cache-dedup key — varies by allowLlmWrite + skillViewMode to avoid stale cache
        // (SKILL_VIEW_MODE=id/name 须区分缓存,否则两模式串同一份 session_init 块)
        cacheKey: `skill-tools-injector:catalog:${allowLlmWrite ? "rw" : "ro"}:${(process.env.SKILL_VIEW_MODE ?? "id").toLowerCase() === "name" ? "name" : "id"}`,
      },
    }];
  }
}
