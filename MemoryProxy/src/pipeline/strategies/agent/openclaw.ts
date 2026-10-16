/**
 * openclaw AgentStrategy (addendum §4.3 契约补齐)。
 *
 * addendum §4.3 原文:
 *   > `HEADER_ONLY_AGENTS` 与 `isHeaderOnlyAgent(agentSource)` 是**跨 stage 硬约束**,
 *   > 不是可选特化。`AgentStrategy` 里表达为:
 *   >   - `supportsSessionForm: false`
 *   >   - `bypassOnPresetFail: true`
 *
 * openclaw 列在 `HEADER_ONLY_AGENTS` 里 (session/preset.ts), 与 pi 对称:
 *   > - `openclaw` — anthropic, no ask-user tool available
 *
 * ⚠️ 契约完善, 非行为修复: 补齐前后运行时行为一致。
 *   - 那两个字段当前无消费点 (原消费点 `stages/session-init.ts` 已在 Round 18
 *     被 `stages/session-init-orchestrate.ts` 取代并删除), 见 types.ts 字段 JSDoc
 *   - 真正生效的 header-only bypass 在 `session/codebuddy/init.ts` 的
 *     `isHeaderOnlyAgent(agentSource)` 分支, 按 `HEADER_ONLY_AGENTS` Set 判定,
 *     与 strategy 无关
 *   - strategy 唯一被真实消费的字段是 `stageGates`, 落 default 时
 *     也是 `STAGE_PRESETS.full`, 取值一致
 *
 * 协议: openclaw 走 anthropic /v1/messages (supported-agents.ts 标注
 * protocol="anthropic")。archive 的 protocol 由 runner 以字面量传给 stageArchive,
 * strategy 上不持有该字段。
 *
 * 行为: 复用 defaultAdapter 的 classifyRequest/extractUserText (未做抓包特化);
 * agentKind 显式标 "openclaw" (AgentKind 联合类型已收录, 见 agent-adapters/types.ts)。
 */

import { defaultAdapter } from "../../../agent-adapters/default.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const openclawStrategy: AgentStrategy = {
  ...defaultAdapter,
  agentKind: "openclaw",      // 覆盖 defaultAdapter 的 "unknown"
  supportsSessionForm: false, // header-only 客户端不认 proxy 伪造的 form tool_call
  bypassOnPresetFail: true,   // preset 失败任何场景一律 bypass, 绝不弹 form
  stageGates: STAGE_PRESETS.full,
};
