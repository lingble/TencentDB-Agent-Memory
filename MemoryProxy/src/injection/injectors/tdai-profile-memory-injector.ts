import type { AgentContext, AnchorTarget, CacheStrategy, ContextBlock, InjectionHook, HookPriority, PrewarmInput } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { TdaiClient } from "../../tdai/client.js";
import type { TdaiMemoryConfig } from "../../tdai/types.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "./tdai-fixed-asset.js";

/**
 * L2/L3 注入（按 openclaw 官方做法重构）：
 *   - L3 (persona) → 注入完整内容（稳定且通常较短，作为长期画像）
 *   - L2 (scenarios) → **只注入 Scene Navigation 索引（路径列表 + summary）**，
 *     不预读全文。LLM 需要细节时主动调 `tdai_read_scene` 工具按 path 拉取。
 *   - 同时附 memory-tools-guide 文案，告诉 LLM 怎么用工具 + 调用上限。
 *
 * 这样可以：
 *   1. 大幅降低首轮 token 消耗（L2 全文经常上千 chars × N 个）
 *   2. 让 LLM 按需取文，而不是被无关的场景污染上下文
 *
 * 跨 agent："自有 + 借入"按 agent 分段；每段下面 L3 + Scene 索引并列。
 *
 * 控制面不可达时降级：仅注入当前 agent 的 L3 + Scene 索引。
 */
export class TdaiProfileMemoryInjector implements InjectionHook {
  id = "tdai-profile-memory-injector";
  point = "system.suffix" as const;
  anchor: AnchorTarget = { slot: "memory", relation: "inside_append" };
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 10;
  description = "Inject TDAI L3 (persona) + L2 scene index (path-only, agent reads via tool)";
  /** L2/L3 profile snapshot is injected once after session registration, like skill listing. */
  cacheStrategy: CacheStrategy = "session_init";

  /**
   * @param baseConfig  starter TdaiClient config; per-request `serviceId` will
   *   be overridden with `session.space_id` in `renderBlocksForContext`. This
   *   config's `serviceId` acts as a fallback when no `space_id` is present.
   * @param coreSkillCfg  kernel gateway config for MetadataClient (fixed-asset
   *   agent resolution).
   */
  constructor(
    private baseConfig: TdaiMemoryConfig,
    private coreSkillCfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs"> | null = null,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];
    return this.renderBlocksForContext(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.chat_memory === false) return [];
    return this.renderBlocksForContext(createPrewarmAgentContext(input));
  }

  private async renderBlocksForContext(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    const session = (ctx.metadata.custom as any)?.session as { user_key?: string; space_id?: string } | undefined;
    const userKey = session?.user_key;
    // spaceId 来自 session 注册时保存的 URL path 中的 `/proxy/<spaceId>/...`；
    // 用作内核的 `x-tdai-service-id` 头做租户路由。空字符串会被内核拒绝（invalid_user_key）
    // —— caller 已在 session-init 阶段做 bypass 处理。
    const spaceId = session?.space_id ?? "";
    const mc = this.coreSkillCfg && userKey
      ? getMetadataClient(this.coreSkillCfg, spaceId, userKey)
      : null;
    const ctxs = await resolveFixedAssetCtxs(ctx, identity, mc);

    // Build a per-request TdaiClient with the correct tenant. Falls back to
    // baseConfig.serviceId (config value) when spaceId is empty.
    const client = new TdaiClient({
      ...this.baseConfig,
      serviceId: spaceId || this.baseConfig.serviceId,
    });

    // 对每个 agent 独立拉 L3 + L2 索引（不读 L2 全文）
    const groups = await Promise.all(ctxs.map((c) => loadAgentProfile(client, c)));

    // 全部为空 → 仍注入 tools-guide（LLM 可主动 search L1 / 读 L2）
    const hasAnything = groups.some((g) => g.l3 || g.l2Entries.length > 0);
    if (!hasAnything) {
      return [{
        type: "text",
        content: MEMORY_TOOLS_GUIDE,
        metadata: { source: this.id, agentCount: 0, l3Count: 0, l2Count: 0, mode: "tools-only" },
      }];
    }

    const lines: string[] = [
      "<tdai_profile_memory>",
      "Below is the long-term working memory TDAI maintains for the current agent (own + imported sections; L2 is index only, read the full text with tools when needed):",
    ];

    let l2TotalCount = 0;
    let l3Count = 0;
    for (const g of groups) {
      if (!g.l3 && g.l2Entries.length === 0) continue;
      const tag = g.ctx.isSelf ? "self" : "imported_from";
      lines.push(
        `<agent name=${JSON.stringify(g.ctx.agentName)} role=${JSON.stringify(tag)} agent_id=${JSON.stringify(g.ctx.agentId)}>`,
      );
      if (g.l3?.content) {
        l3Count++;
        lines.push("<l3_core_memory>", truncate(g.l3.content, 6000), "</l3_core_memory>");
      }
      if (g.l2Entries.length > 0) {
        lines.push("<l2_scene_index>");
        for (const e of g.l2Entries) {
          l2TotalCount++;
          // 索引行：路径 + summary（如果有）；正文用 tool 拉
          if (e.summary) {
            lines.push(`- \`${e.path}\` — ${truncate(e.summary, 200)}`);
          } else {
            lines.push(`- \`${e.path}\``);
          }
        }
        lines.push("</l2_scene_index>");
      }
      lines.push("</agent>");
    }

    lines.push("</tdai_profile_memory>");
    // 紧跟一段 memory-tools-guide，告诉 LLM 三个工具的用法 + 调用上限
    lines.push("");
    lines.push(MEMORY_TOOLS_GUIDE);

    return [
      {
        type: "text",
        content: lines.join("\n"),
        metadata: {
          source: this.id,
          agentCount: groups.length,
          l3Count,
          l2IndexCount: l2TotalCount,
          mode: "index+tools",
        },
      },
    ];
  }
}

function createPrewarmAgentContext(input: PrewarmInput): AgentContext {
  return {
    messages: [],
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic",
      traceId: `prewarm:${input.keyId}`,
      keyId: input.keyId,
      modelId: "prewarm",
      stream: false,
      agentSource: "session-init",
      custom: { session: input.sessionInfo },
    },
  };
}

/** 记忆使用指南：L0/L1 按需用工具检索（不再自动召回），L3 直注、L2 索引直注。 */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## ⚠️ Important: this is not documentation, these are capabilities you can use

The tools listed in the \`<tdai_memory_tools>\` block, such as tdai_memory_search / tdai_conversation_search,
are **capabilities you can actively call** (not reference-only documentation). They are used through **Bash + curl**
(see the full usage instructions and URLs in the \`<tdai_memory_tools>\` block above).

**NEVER** answer with something like "I don't have this tool / I need MCP / I need a slash command".
**Correct approach**: when you decide memory needs to be checked, run curl directly in Bash; the proxy injects identity and auth automatically.

## Memory usage rules (in the following situations you MUST query first, then answer)

L3 (persona long-term profile) and the L2 scene index are already injected into the system prompt. L0/L1 must be searched actively with the tools.
When the injected L2 content is relevant to the current task but insufficient, read the corresponding full text with \`tdai_read_scene\` using the path from the scene index; if the content is already enough, do not read more.

### Situations where you MUST query memory before answering (any one match triggers a tool call)

1. **The user refers to history / the past / earlier**: e.g. "I told you before / I mentioned earlier / last time / do you remember / we talked about / that earlier one"
   → use \`tdai_conversation_search\` (L0 raw text, to find specific messages)
2. **The user asks about their own identity / preferences / habits**: e.g. "what's my name / my name / I like / my team / I usually use / I don't like / I don't allow"
   → use \`tdai_memory_search\` (L1 atomic memory, for preferences/rules)
3. **The user asks you to recall / find something**: e.g. "recall / think back / find / is there any record about X / check what we did before"
   → trigger the tool directly; do not answer from thin air
4. **The answer depends heavily on historical facts**: e.g. "how did we fix that bug / what was the plan last time / what is our convention"
   → turn it into keywords, then \`tdai_memory_search\`

**Typical flow** (user: "what's my name"):
\`\`\`bash
# Step 1: query first
curl -sfk -X POST <bridge>/atomic/search \\
  -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' \\
  -d '{"query": "user name identity", "limit": 5}'
# Step 2: extract the answer from items[].content, then reply
# If empty: tell the user plainly "I couldn't find it in memory, what is your name?" — do not pretend to know
\`\`\`

### Situations where no query is needed

- Requests that do not depend on historical information or past experience and can be completed from the current input alone; do not decide whether retrieval is needed from the task type alone
- The current session context (messages in the same turn) already answers it
- The answer is already directly visible in the \`<l3_core_memory>\` section

### ⚠️ Call constraints

- Per turn, \`tdai_memory_search\` + \`tdai_conversation_search\` may be called **at most 3 times in total** (\`tdai_read_scene\` / \`tdai_scenario_ls\` / \`tdai_atomic_query\` do not count)
- When a search finds nothing, **say so explicitly**: "I couldn't find X in memory". Do not make things up
- Do not read the same L2 path twice
</memory-tools-guide>`;

interface AgentProfileBundle {
  ctx: FixedAssetCtx;
  l3: { content: string } | null;
  /** L2 索引：仅 path + 可选 summary，**不**读全文。 */
  l2Entries: Array<{ path: string; summary?: string }>;
}

async function loadAgentProfile(client: TdaiClient, c: FixedAssetCtx): Promise<AgentProfileBundle> {
  const tdaiCtx = { teamId: c.teamId, userId: c.userId, agentId: c.agentId, agentName: c.agentName };
  const [l3, l2Entries] = await Promise.all([client.readL3ForCtx(tdaiCtx), client.listL2ForCtx(tdaiCtx)]);
  // L3(persona) 可能在尾部内嵌一份「Scene Navigation」场景索引（plugin 侧 read 会带导航段）。
  // 我们已经单独注入 <l2_scene_index>，必须剥掉 persona 尾部这份，避免 L2 索引重复注入。
  const l3Stripped = l3 ? stripSceneNavigation(l3.content) : "";
  return {
    ctx: c,
    l3: l3Stripped.trim() ? { content: l3Stripped } : null,
    l2Entries: (l2Entries ?? []).map((e) => ({ path: e.path, summary: e.summary })),
  };
}

/**
 * 剥离 persona 尾部的「Scene Navigation (Scene Index)」段。
 * 与 plugin 端 scene-navigation.ts 的 NAV_HEADER 对齐（带或不带前置 `---` 都能命中）。
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf("## 🗺️ Scene Navigation");
  if (idx === -1) return personaContent;
  // 连同紧邻的 `---` 分隔符与前后空白一起去掉
  let cut = personaContent.slice(0, idx);
  cut = cut.replace(/\s*-{3,}\s*$/, "");
  return cut.trimEnd();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}
