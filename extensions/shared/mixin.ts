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
 * 生命周期与抗升级设计：
 * - prototype 只保存算法与版本注册表，配置和 flag 始终从当前 AgentSession 读取；
 * - 每次调用先做版本与内部字段检查，不兼容时原样交给下一层实现；
 * - 多版本补丁可同时留在调用链中，只有最高 revision 执行业务逻辑；
 * - 配置 enabled=false 或启动 flag --ner-no-mixin 时完全不介入。
 *
 * 依赖事实：pi 扩展加载器（core/extensions/loader.js）通过 jiti alias /
 * virtualModules 把 @earendil-works/pi-coding-agent 强制解析到宿主自身模块，
 * 因此这里的 prototype 补丁作用的就是宿主正在使用的类。
 */
import { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  NO_MIXIN_FLAG,
  resolveMixinConfig,
  type MixinConfig,
} from "./config.ts";

/** 与原方法交互所需的内部成员（无真私有，运行时按需检查存在性）。 */
type PrepareRetryHost = {
  _retryAttempt?: number;
  _emit?: (event: Record<string, unknown>) => void;
  _retryAbortController?: AbortController | undefined;
  agent?: { state?: { messages?: Array<{ role?: string }> } };
  settingsManager?: {
    /** Pi 的最终 merged settings；声明为 private，但运行时是普通实例字段。 */
    settings?: unknown;
    getRetrySettings?: () => { enabled: boolean };
  };
  extensionRunner?: {
    getFlagValues?: () => { get?: (name: string) => unknown };
  };
};

type PrepareRetrySignature = (
  this: PrepareRetryHost,
  ...args: unknown[]
) => Promise<boolean>;

type InstalledMixinVersions = Set<number>;

/** mixin 实现发生协议或行为变化时单调递增，与 npm 包版本解耦。 */
export const MIXIN_REVISION = 1;

/**
 * 进程级 canonical registry 放在 prototype 上，避免第三方 wrapper 插入后
 * 截断各版本函数之间的 Symbol 元数据。
 */
const MIXIN_REGISTRY_KEY = Symbol.for("not-enough-retry.mixin-registry");
/** v0.2.0 使用的 boolean marker；仅用于阻止不受支持的旧补丁热迁移。 */
const LEGACY_MIXIN_MARKER = Symbol.for("not-enough-retry.mixin-installed");

type PatchedPrepareRetry = PrepareRetrySignature & {
  [LEGACY_MIXIN_MARKER]?: unknown;
};

type PrepareRetryPrototype = {
  _prepareRetry?: PatchedPrepareRetry;
  [MIXIN_REGISTRY_KEY]?: InstalledMixinVersions;
};

function highestMixinRevision(versions: InstalledMixinVersions): number {
  let highest = 0;
  for (const version of versions) {
    if (Number.isSafeInteger(version) && version > highest) highest = version;
  }
  return highest;
}

/** 取得跨模块 reload 共享的版本集合。 */
function getOrCreateVersionRegistry(
  proto: PrepareRetryPrototype,
  current: PatchedPrepareRetry,
): InstalledMixinVersions | undefined {
  /**
   * boolean marker 属于 v0.2.0 provider 补丁，不支持热迁移。
   * 保留旧层并等待进程重启，避免把 boolean 误作 revision registry。
   */
  if (current[LEGACY_MIXIN_MARKER] === true) return undefined;

  const registered = proto[MIXIN_REGISTRY_KEY];
  if (registered !== undefined) {
    return registered instanceof Set ? registered : undefined;
  }

  const versions = new Set<number>();
  proto[MIXIN_REGISTRY_KEY] = versions;
  return versions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type SessionMixinState = {
  config: MixinConfig;
  disabledByFlag: boolean;
};

/**
 * 同步读取当前 AgentSession 的最终 settings 与 flag 快照。
 * 任一宿主结构不兼容或读取异常都返回 undefined，由调用方交还下一层实现。
 */
function readSessionMixinState(host: PrepareRetryHost): SessionMixinState | undefined {
  try {
    const settings = host.settingsManager?.settings;
    const getFlagValues = host.extensionRunner?.getFlagValues;
    if (!isRecord(settings) || typeof getFlagValues !== "function") return undefined;

    const flagValues = getFlagValues.call(host.extensionRunner);
    if (!flagValues || typeof flagValues.get !== "function") return undefined;

    return {
      config: resolveMixinConfig(settings),
      disabledByFlag: flagValues.get(NO_MIXIN_FLAG) === true,
    };
  } catch {
    return undefined;
  }
}

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

/** 安装当前 revision；重复加载同版本时保持幂等。 */
export function installPrepareRetryMixin(): void {
  const proto = AgentSession.prototype as unknown as PrepareRetryPrototype;
  const current = proto._prepareRetry;
  if (typeof current !== "function") return;

  const versions = getOrCreateVersionRegistry(proto, current);
  if (!versions) return;

  const highest = highestMixinRevision(versions);
  if (versions.has(MIXIN_REVISION) || highest > MIXIN_REVISION) return;

  const next = current;
  const patched = async function (
    this: PrepareRetryHost,
    ...args: unknown[]
  ): Promise<boolean> {
    // 失活层必须在读取 session 状态或产生任何副作用前透明转发。
    if (highestMixinRevision(versions) !== MIXIN_REVISION) {
      return Reflect.apply(next, this, args);
    }

    // 当前已知的 Pi 签名只有 message 一个参数；签名变化时安全降级。
    if (args.length !== 1) return Reflect.apply(next, this, args);

    // sanity check：字段不齐（如 pi 升级改名）时自动降级回下一层实现。
    if (
      typeof this._retryAttempt !== "number" ||
      typeof this._emit !== "function" ||
      !Array.isArray(this.agent?.state?.messages) ||
      typeof this.settingsManager?.getRetrySettings !== "function"
    ) {
      return Reflect.apply(next, this, args);
    }

    const state = readSessionMixinState(this);
    if (!state || state.disabledByFlag || !state.config.enabled) {
      return Reflect.apply(next, this, args);
    }
    const config = state.config;

    // 尊重 pi 的 retry.enabled 全局开关：用户在 TUI 里关闭 autoRetry 时 mixin 一并停用。
    if (!this.settingsManager.getRetrySettings().enabled) return false;

    this._retryAttempt++;
    if (this._retryAttempt > config.maxRetries) {
      this._retryAttempt--;
      return false;
    }

    const delayMs = calculateRetryDelayMs(this._retryAttempt, config);
    this._emit({
      type: "auto_retry_start",
      attempt: this._retryAttempt,
      maxAttempts: config.maxRetries,
      delayMs,
      errorMessage:
        (args[0] as { errorMessage?: string } | undefined)?.errorMessage || "Unknown error",
    });

    // 摘除末尾 error 消息（保留在会话日志）：agent.continue() 要求末尾非 assistant。
    const messages = this.agent.state.messages;
    if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      this.agent.state.messages = messages.slice(0, -1);
    }

    this._retryAbortController = new AbortController();
    try {
      await abortableSleep(delayMs, this._retryAbortController.signal);
    } catch {
      const attempt = this._retryAttempt;
      this._retryAttempt = 0;
      this._emit({
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
  } as PatchedPrepareRetry;

  // prototype 赋值若抛错，不应留下尚未安装的 revision 记录。
  proto._prepareRetry = patched;
  versions.add(MIXIN_REVISION);
}
