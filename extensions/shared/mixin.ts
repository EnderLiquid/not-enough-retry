/**
 * AgentSession.prototype._prepareRetry 的可开关增强补丁。
 *
 * 原生实现（pi 0.84.x，core/agent-session.js）结构：读 settings → 计数 →
 * 发 auto_retry_start → 摘除末尾 error 消息 → 退避 sleep → 返回。
 * 缺陷是退避 `baseDelayMs * 2^(attempt-1)` 无封顶，maxRetries 调大后
 * 单次等待会指数爆炸到小时级。
 *
 * 本补丁仅替换退避来源：独立配置的 maxRetries 与封顶退避曲线。
 * 其余行为（摘除 error 消息、auto_retry 事件、abort 处理、成功清零）
 * 与原生完全一致，事件语义不变（N 次尝试共享一次 agent_settled）。
 *
 * 抗升级设计：
 * - 补丁前保存原方法引用；
 * - 每次调用先做 sanity check，pi 升级导致内部字段变化时自动交还原生实现；
 * - 配置 enabled=false 或启动 flag --ner-no-mixin 时完全不介入。
 *
 * 依赖事实：pi 扩展加载器（core/extensions/loader.js）通过 jiti alias /
 * virtualModules 把 @earendil-works/pi-coding-agent 强制解析到宿主自身模块，
 * 因此这里的 prototype 补丁作用的就是宿主正在使用的类。
 */
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MIXIN_CONFIG, type MixinConfig } from "./config.ts";

/** 与原方法交互所需的内部成员（无真私有，运行时按需检查存在性）。 */
type PrepareRetryHost = {
  _retryAttempt?: number;
  _emit?: (event: Record<string, unknown>) => void;
  _retryAbortController?: AbortController | undefined;
  agent?: { state?: { messages?: Array<{ role?: string }> } };
  settingsManager?: { getRetrySettings?: () => { enabled: boolean } };
};

type PrepareRetrySignature = (this: PrepareRetryHost, message: unknown) => Promise<boolean>;

const originalPrepareRetry = (
  AgentSession.prototype as unknown as Record<"_prepareRetry", PrepareRetrySignature>
)._prepareRetry;

/** 可中止睡眠，等价 pi 自带 dist/utils/sleep.js 的行为。 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("Aborted"));
    });
  });
}

/** 指数退避计算（封顶）。attempt 从 1 开始。 */
export function calculateRetryDelayMs(attempt: number, config: MixinConfig): number {
  const raw = config.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(raw, config.maxDelayMs);
}

/** 模块级配置源：/reload 重执行工厂时更新，避免向原型叠加多层补丁。 */
let configProvider: (() => MixinConfig) | undefined;
let mixinInstalled = false;

export function installPrepareRetryMixin(getConfig: () => MixinConfig): void {
  configProvider = getConfig;
  if (mixinInstalled) return;
  mixinInstalled = true;
  (
    AgentSession.prototype as unknown as Record<"_prepareRetry", PrepareRetrySignature>
  )._prepareRetry = async function (this: PrepareRetryHost, message) {
    const config = configProvider?.() ?? DEFAULT_MIXIN_CONFIG;
    if (!config.enabled) {
      return originalPrepareRetry.call(this, message);
    }

    // sanity check：字段不齐（如 pi 升级改名）时自动降级回原生实现。
    if (
      typeof this._retryAttempt !== "number" ||
      typeof this._emit !== "function" ||
      !Array.isArray(this.agent?.state?.messages) ||
      typeof this.settingsManager?.getRetrySettings !== "function"
    ) {
      return originalPrepareRetry.call(this, message);
    }

    // 尊重 pi 的 retry.enabled 全局开关：用户在 TUI 里关闭 autoRetry 时 mixin 一并停用。
    if (!this.settingsManager!.getRetrySettings!().enabled) {
      return false;
    }

    this._retryAttempt!++;
    if (this._retryAttempt! > config.maxRetries) {
      this._retryAttempt!--;
      return false;
    }

    const delayMs = calculateRetryDelayMs(this._retryAttempt!, config);
    this._emit!({
      type: "auto_retry_start",
      attempt: this._retryAttempt,
      maxAttempts: config.maxRetries,
      delayMs,
      errorMessage:
        (message as { errorMessage?: string } | undefined)?.errorMessage || "Unknown error",
    });

    // 摘除末尾 error 消息（保留在会话日志）：agent.continue() 要求末尾非 assistant。
    const messages = this.agent!.state!.messages!;
    if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      this.agent!.state!.messages = messages.slice(0, -1);
    }

    this._retryAbortController = new AbortController();
    try {
      await abortableSleep(delayMs, this._retryAbortController.signal);
    } catch {
      const attempt = this._retryAttempt!;
      this._retryAttempt = 0;
      this._emit!({
        type: "auto_retry_end",
        success: false,
        attempt,
        finalError: "Retry cancelled",
      });
      return false;
    } finally {
      this._retryAbortController = undefined;
    }
    return true;
  };
}
