/**
 * not-enough-retry：让 pi 的内置 retry 对所有非永久性 provider 错误生效。
 *
 * 两部分：
 * 1. hint 翻译：message_end 上给未被内置判定器识别的错误追加
 *    "provider returned error" 文本，pi 原生 retry（次数上限、退避、
 *    TUI 状态、abort）完整接管。黑名单仅排除永久性失败（鉴权、模型不存在）。
 * 2. 可选 mixin：给 _prepareRetry 加退避封顶与独立次数上限（见 shared/mixin.ts）。
 *    开关与参数在 pi settings.json 的 "not-enough-retry.mixin" 段，
 *    启动 flag --ner-no-mixin 可应急禁用。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NO_MIXIN_FLAG } from "./shared/config.ts";
import { appendHint, decideHint } from "./shared/error-patterns.ts";
import { installPrepareRetryMixin } from "./shared/mixin.ts";

type AssistantError = Extract<AgentMessage, { role: "assistant" }>;

export default function notEnoughRetry(pi: ExtensionAPI) {
  pi.registerFlag(NO_MIXIN_FLAG, {
    description:
      "Disable the not-enough-retry _prepareRetry mixin and fall back to pi's native retry.",
    type: "boolean",
  });

  installPrepareRetryMixin();

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
