/**
 * mem:config-unlock — 清除当前用户的账户级 Session 默认配置。
 *
 * 对应 PRD TAPD 1070195170 第 2 个 IDE 命令。
 *
 * 语义:
 *   - 不改变当前 session 的任何状态 (PRD 原文: "不影响当前 Session，下一次
 *     Session Init 恢复手动选择")。只是把 Core 侧的默认记录删掉。
 *   - 幂等: 没有默认配置也返回 ok (对齐 Core delete 的幂等语义)。
 *   - 不要求 session 已 initialized —— 命令只调 Core, 不读本地 state;
 *     用户在任意阶段都能触发。
 *
 * 注意:
 *   - 清除后下次新开 Session 自动回退到: ① header preset → ② 交互表单
 *     (设计文档 §2.2 优先级链)。
 *   - 已经 initialized 的 Session 不受影响;想换一组默认请:
 *       (a) 在面板 "Agents · 我的 Session 默认配置" 重新保存
 *       (b) 或 `mem:config-unlock` 后开新会话重新选, 再 `mem:config-lock`
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getMetadataClient } from "../../meta/client.js";

function makeClient(ctx: MemCommandContext) {
  const sessionInfo = ctx.sessionInfo as Record<string, unknown> | undefined;
  const userKey = (sessionInfo?.user_key as string | undefined) ?? ctx.apiKey ?? "";
  return getMetadataClient(ctx.config.coreSkill, ctx.spaceId, userKey);
}

export async function executeConfigUnlock(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  try {
    const client = makeClient(ctx);
    await client.deleteUserSessionDefault(ctx.userId);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.warn(
      `[mem-command:config-unlock] deleteUserSessionDefault failed for user=${ctx.userId}: ${raw}`,
    );
    const text = [
      "❌ Clearing the account-level default failed.",
      "",
      `Original error: ${raw}`,
    ].join("\n");
    return {
      success: false,
      messageText: text,
      response: buildMemResponse(text, {
        protocol: ctx.protocol,
        stream: ctx.stream,
        requestId,
        thinking: ctx.thinking,
      }),
    };
  }

  console.log(
    `[mem-command:config-unlock] cleared user=${ctx.userId} session=${ctx.sessionKey}`,
  );

  const text = [
    "✅ The account-level default config is cleared",
    "",
    "The next new Session goes back to the manual flow \"link team assets? → Team → Agent → Task\".",
    "This conversation is not affected and continues under the current Agent identity.",
  ].join("\n");

  return {
    success: true,
    messageText: text,
    response: buildMemResponse(text, {
      protocol: ctx.protocol,
      stream: ctx.stream,
      requestId,
      thinking: ctx.thinking,
    }),
  };
}
