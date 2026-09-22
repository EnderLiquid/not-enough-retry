/**
 * not-enough-retry：让 pi 的内置 retry 对所有非永久性 provider 错误生效。
 *
 * 做法：message_end 上给未被内置判定器识别的错误追加
 * "provider returned error" 文本，pi 原生 retry（次数上限、退避、
 * TUI 状态、abort）完整接管。黑名单仅排除永久性失败（鉴权、模型不存在）。
 *
 * 0.4.0 起不再包含 mixin 补丁：pi 0.86.0 已修复原生退避无封顶的问题
 * （retry.maxAgentDelayMs），0.87.0 起 SessionManager 成为 canonical 源，
 * 旧补丁的摘除手法随之失效，补丁失去存在价值。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendHint, decideHint } from "./shared/error-patterns.ts";

type AssistantError = Extract<AgentMessage, { role: "assistant" }>;

export default function notEnoughRetry(pi: ExtensionAPI) {
  pi.on("message_end", (event, ctx) => {
    // ctx 也带 staleness guard；读取失败时按缺少辅助信息继续判定。
    let contextWindow: number | undefined;
    let signal: AbortSignal | undefined;
    try {
      contextWindow = ctx.getContextUsage()?.contextWindow;
      signal = ctx.signal;
    } catch {
      // 迟到的事件可能落在已经失效的 ctx 上。
    }

    const decision = decideHint(event.message, contextWindow, signal);
    if (!decision.append) return;

    const message = event.message as AssistantError;
    const text = typeof message.errorMessage === "string" ? message.errorMessage : "";
    return {
      message: {
        ...message,
        errorMessage: appendHint(text),
      } as AssistantError,
    };
  });
}
