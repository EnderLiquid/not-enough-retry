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
 * 生命周期约定：pi 的 ExtensionAPI 与 ExtensionContext 都带 staleness 守卫，
 * 会话替换或 reload 之后调用即抛 "extension ctx is stale ..."。本插件的 mixin
 * 跑在 pi 的 run 路径里，那里的异常会中止当轮回复并在 TUI 里显示为一行错误。
 * 因此对 pi/ctx 的读取全部放在事件处理器里，结果缓存到普通变量，run 路径只读缓存。
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

/**
 * 读取应急 flag --ner-no-mixin。
 *
 * pi 在扩展模块加载结束后才把命令行 flag 值写入 runtime，加载期读到的是注册时的
 * 默认值，真值通常在 session_start 才可见（session_start 覆盖 startup/reload/new/
 * resume/fork 全部时机）。getFlag 带 staleness 守卫，会话替换后调用会抛，这里保留
 * 上一次读到的值。
 */
function readNoMixinFlag(pi: ExtensionAPI, previous: boolean): boolean {
  try {
    return Boolean(pi.getFlag(NO_MIXIN_FLAG));
  } catch {
    return previous;
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
  let noMixin = readNoMixinFlag(pi, false);

  // 配置源只读普通变量，run 路径保持零 pi API 调用。
  installPrepareRetryMixin(() => (noMixin ? { ...mixinConfig, enabled: false } : mixinConfig));

  pi.on("session_start", (_event, ctx) => {
    noMixin = readNoMixinFlag(pi, noMixin);
    mixinConfig = reloadMixinConfig(ctx.cwd, (message) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    });
  });

  pi.on("message_end", (event, ctx) => {
    // ctx 同样带守卫：取不到就按缺省输入判定，hint 逻辑照常执行。
    let contextWindow: number | undefined;
    let signal: AbortSignal | undefined;
    try {
      contextWindow = ctx.getContextUsage()?.contextWindow;
      signal = ctx.signal;
    } catch {
      // 迟到的事件可能落在已失效的 ctx 上。
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
