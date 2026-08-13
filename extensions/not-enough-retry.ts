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
 *
 * 建议配合 pi 配置（mixin 关闭时的兜底）：
 *   { "retry": { "maxRetries": 16, "baseDelayMs": 0 } }
 * 0ms 无退避，串行节奏由请求耗时决定；16 次耗尽即终止。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MIXIN_CONFIG, loadMixinConfig, NO_MIXIN_FLAG, type MixinConfig } from "./shared/config.ts";
import { appendHint, decideHint } from "./shared/error-patterns.ts";
import { installPrepareRetryMixin } from "./shared/mixin.ts";

type AssistantError = Extract<AgentMessage, { role: "assistant" }>;

export default function notEnoughRetry(pi: ExtensionAPI) {
  pi.registerFlag(NO_MIXIN_FLAG, {
    description:
      "Disable the not-enough-retry _prepareRetry mixin and fall back to pi's native retry.",
    type: "boolean",
  });

  // 工厂执行时进程 cwd 通常已是项目目录；session_start 后以会话 cwd 为准刷新。
  let mixinConfig: MixinConfig = loadMixinConfig(process.cwd());

  installPrepareRetryMixin(() => {
    if (pi.getFlag(NO_MIXIN_FLAG)) {
      return { ...mixinConfig, enabled: false };
    }
    return mixinConfig;
  });

  pi.on("session_start", (_event, ctx) => {
    mixinConfig = loadMixinConfig(ctx.cwd);
  });

  pi.on("message_end", (event, ctx) => {
    const decision = decideHint(event.message, ctx.getContextUsage()?.contextWindow);
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
