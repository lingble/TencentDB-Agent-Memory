/**
 * stages/session-reset-confirmation.ts — mem:session-reset 完成后的确认响应。
 *
 * 提取自 4 处 30 行完全相同的代码块 (blueprint §2.4):
 *   - openai-chat runner: reset 后跑完 session-init 弹 form → 提示 ok
 *   - anthropic runner:   同上
 *   - codex runner:       同上
 *   - workbuddy runner:   同上
 *
 * 语义: session-init state machine 完成 reset 流程后, 拿 agent/team/task detail
 * 组装成 "✅ Team assets re-linked" 文案, 通过 buildMemResponse 返回。
 * caller 拿返回值直接下发。
 */

import type { SessionResetProtocol } from "./session-reset-pre-hook.js";

export interface ResetFlowResult {
  agentName: string;
  agentIdShort: string;
  teamName?: string;
  teamId: string;
  taskName?: string | null;
  bypassed?: boolean;
}

export interface SessionResetConfirmationInput {
  resetFlowResult: ResetFlowResult;
  protocol: SessionResetProtocol;
  isStream: boolean;
  /** anthropic 传 body.thinking */
  thinking?: unknown;
}

/**
 * 构造 mem:session-reset 完成的确认响应。
 */
export async function stageSessionResetConfirmation(
  input: SessionResetConfirmationInput,
): Promise<Response> {
  const { agentName, agentIdShort, teamName, teamId, taskName, bypassed } = input.resetFlowResult;
  const teamLine = teamName
    ? `- **Team**: ${teamName}${teamId ? ` (${teamId})` : ""}`
    : teamId
      ? `- **Team**: ${teamId}`
      : null;
  const lines = bypassed
    ? ["✅ Team asset linking skipped", "", "Later conversations will not inject any team assets (Skill / Memory / Knowledge)."]
    : [
        "✅ Team assets re-linked",
        "",
        `- **Agent**: ${agentName}${agentIdShort ? ` (${agentIdShort})` : ""}`,
        teamLine,
        taskName ? `- **Task**: ${taskName}` : "- **Task**: not linked",
        "",
        "Later conversations will use the new Agent's Skill, Memory and Knowledge assets.",
      ].filter(Boolean);
  const text = (lines as string[]).join("\n");

  const { buildMemResponse } = await import("../../mem-command/response-builder.js");
  console.log(`[mem-command:session-reset] completed: bypassed=${!!bypassed} agent=${agentName} (${agentIdShort}) team=${teamName ?? "-"} (${teamId || "-"})`);
  return buildMemResponse(text, {
    protocol: input.protocol,
    stream: input.isStream,
    requestId: `mem-reset-${Date.now()}`,
    thinking: input.thinking as boolean | undefined,
  });
}
