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
import { DEFAULT_MIXIN_CONFIG, loadMixinConfig, NO_MIXIN_FLAG, type MixinConfig } from "./shared/config.ts";
import { appendHint, decideHint } from "./shared/error-patterns.ts";
import { installPrepareRetryMixin } from "./shared/mixin.ts";

type AssistantError = Extract<AgentMessage, { role: "assistant" }>;

/** 读取配置；失败时回退默认值并调用 notify（无 UI 场景可传空操作）。 */
function reloadMixinConfig(cwd: string, notify: (message: string) => void): MixinConfig {
  try {
    return loadMixinConfig(cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(`not-enough-retry config issue: ${message}`);
    return DEFAULT_MIXIN_CONFIG;
  }
}

export default function notEnoughRetry(pi: ExtensionAPI) {
  pi.registerFlag(NO_MIXIN_FLAG, {
    description:
      "Disable the not-enough-retry _prepareRetry mixin and fall back to pi's native retry.",
    type: "boolean",
  });

  // 工厂执行时进程 cwd 通常已是项目目录；session_start 后以会话 cwd 为准刷新。
  // 首读无 UI 上下文，失败静默回退；session_start 读到时再通知。
  let mixinConfig: MixinConfig = reloadMixinConfig(process.cwd(), () => {});

  installPrepareRetryMixin(() => {
    if (pi.getFlag(NO_MIXIN_FLAG)) {
      return { ...mixinConfig, enabled: false };
    }
    return mixinConfig;
  });

  pi.on("session_start", (_event, ctx) => {
    mixinConfig = reloadMixinConfig(ctx.cwd, (message) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    });
  });

  pi.on("message_end", (event, ctx) => {
    const decision = decideHint(event.message, ctx.getContextUsage()?.contextWindow, ctx.signal);
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
