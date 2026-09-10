/**
 * mixin 配置：从当前 AgentSession 已合并的 settings 快照中读取。
 *
 * pi 的 settings 解析无 schema 校验，未知键原样保留、不告警不丢弃，
 * 因此插件可以安全地占用 "not-enough-retry" 段。读取当前 session 的
 * SettingsManager 可避免额外 manager 与跨 session 的配置单例。
 */

export interface MixinConfig {
  /** mixin 总开关。关闭时完全交还 pi 原生 _prepareRetry。 */
  enabled: boolean;
  /** 连续失败重试上限（mixin 生效时替代 pi 的 retry.maxRetries）。 */
  maxRetries: number;
  /** 首次重试退避（毫秒），之后每次翻倍。 */
  baseDelayMs: number;
  /** 退避封顶（毫秒），弥补原生无封顶的缺陷。 */
  maxDelayMs: number;
}

export const DEFAULT_MIXIN_CONFIG: MixinConfig = {
  enabled: true,
  maxRetries: 16,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
};

/** 应急关闭 flag：启动时加 --ner-no-mixin 即可禁用 mixin，无需改配置文件。 */
export const NO_MIXIN_FLAG = "ner-no-mixin";

type MixinSection = { mixin?: unknown };

type SettingsSnapshot = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asMixinSection(value: unknown): MixinSection {
  return asRecord(value) ?? {};
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function sanitizeMixinConfig(raw: Partial<MixinConfig>): MixinConfig {
  const merged = { ...DEFAULT_MIXIN_CONFIG, ...raw };
  const numeric = (key: "maxRetries" | "baseDelayMs" | "maxDelayMs"): number => {
    const value = merged[key];
    if (isNonNegativeFinite(value)) return Math.trunc(value);
    throw new Error(`not-enough-retry.mixin.${key} should be a non-negative number`);
  };
  const enabled = merged.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error("not-enough-retry.mixin.enabled should be a boolean");
  }
  return {
    enabled,
    maxRetries: numeric("maxRetries"),
    baseDelayMs: numeric("baseDelayMs"),
    maxDelayMs: numeric("maxDelayMs"),
  };
}

/**
 * 从 Pi 已合并的 session settings 中解析插件段。
 *
 * 配置段缺失或字段非法时使用完整默认值。这里不读取文件、不消费
 * SettingsManager 的错误队列，也不依赖 extension 生命周期。
 */
export function resolveMixinConfig(settings: SettingsSnapshot): MixinConfig {
  const section = asMixinSection(settings["not-enough-retry"]);
  const raw = asRecord(section.mixin) ?? {};
  try {
    return sanitizeMixinConfig(raw as Partial<MixinConfig>);
  } catch {
    return { ...DEFAULT_MIXIN_CONFIG };
  }
}
