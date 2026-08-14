/**
 * mixin 配置：从 pi settings.json 的自定义段读取。
 *
 * pi 的 settings 解析无 schema 校验，未知键原样保留、不告警不丢弃，
 * 因此插件可以安全地占用 "not-enough-retry" 段。
 */
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

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

type MixinSection = { mixin?: Partial<MixinConfig> };

function asMixinSection(value: unknown): MixinSection {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as MixinSection;
  }
  return {};
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function sanitizeMixinConfig(raw: Partial<MixinConfig>): MixinConfig {
  const merged = { ...DEFAULT_MIXIN_CONFIG, ...raw };
  return {
    enabled: merged.enabled !== false,
    maxRetries: isNonNegativeFinite(merged.maxRetries)
      ? Math.trunc(merged.maxRetries)
      : DEFAULT_MIXIN_CONFIG.maxRetries,
    baseDelayMs: isNonNegativeFinite(merged.baseDelayMs)
      ? Math.trunc(merged.baseDelayMs)
      : DEFAULT_MIXIN_CONFIG.baseDelayMs,
    maxDelayMs: isNonNegativeFinite(merged.maxDelayMs)
      ? Math.trunc(merged.maxDelayMs)
      : DEFAULT_MIXIN_CONFIG.maxDelayMs,
  };
}

/**
 * 读取 pi settings 中 "not-enough-retry.mixin" 段（全局与项目级浅合并）。
 * 解析失败时返回默认值，保证 mixin 可用性优先。
 */
export function loadMixinConfig(cwd: string): MixinConfig {
  try {
    const manager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true });
    const globalSection = asMixinSection(
      (manager.getGlobalSettings() as Record<string, unknown>)["not-enough-retry"],
    );
    const projectSection = asMixinSection(
      (manager.getProjectSettings() as Record<string, unknown>)["not-enough-retry"],
    );
    return sanitizeMixinConfig({ ...globalSection.mixin, ...projectSection.mixin });
  } catch {
    return DEFAULT_MIXIN_CONFIG;
  }
}
