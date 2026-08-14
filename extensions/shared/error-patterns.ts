/**
 * 错误判定与 hint 追加逻辑。
 *
 * 核心思路：pi 内置 retry 是白名单文本匹配，匹配不上就一次都不重试。
 * 本模块在 message_end 阶段给"非永久性"错误追加内置白名单关键词（provider returned error），
 * 让 pi 原生 retry 完整接管：次数上限、退避、TUI 状态、abort 全部不变。
 *
 * 黑名单使用 @monotykamary/pi-retry 的 NON_RETRYABLE_PATTERNS（9 条），
 * 只排除重试无法修复的永久性失败。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";

/** 追加到错误文本的标记，防止重复追加，也便于排查时定位来源。 */
export const EXTENSION_TAG = "[not-enough-retry]";

/** 命中 pi 内置白名单（pi-ai/utils/retry.js）的关键词。 */
export const RETRYABLE_HINT = "provider returned error";

/**
 * 永久性错误黑名单。命中后不追加 hint，pi 不会重试。
 * 照抄 @monotykamary/pi-retry 的 NON_RETRYABLE_PATTERNS。
 */
export const NON_RETRYABLE_PATTERNS: RegExp[] = [
  /invalid\s*api\s*key/i,
  /invalid\s*authentication/i,
  /api\s*key\s*(not\s*found|missing|revoked)/i,
  /model\s*not\s*found/i,
  /unknown\s*model/i,
  /no\s*such\s*model/i,
  /model\s*does\s*not\s*exist/i,
  /unsupported\s*model/i,
  /cannot continue from message role/i,
];

export type HintDecision =
  | { append: true }
  | { append: false; reason: "non-assistant" | "non-error" | "blacklist" | "already-hinted" | "already-retryable" | "overflow" };

/**
 * 判断是否应给该错误消息追加可重试 hint。
 *
 * @param message assistant 错误消息
 * @param contextWindow 当前模型上下文窗口；拿不到时跳过溢出检查
 *   （pi 判定重试前会自行检查溢出，这里只为了避免污染错误文本）
 */
export function decideHint(message: AgentMessage, contextWindow?: number): HintDecision {
  if (message.role !== "assistant") return { append: false, reason: "non-assistant" };
  if (message.stopReason !== "error") return { append: false, reason: "non-error" };

  const text = message.errorMessage;
  if (typeof text === "string") {
    if (text.includes(EXTENSION_TAG)) return { append: false, reason: "already-hinted" };
    if (NON_RETRYABLE_PATTERNS.some((pattern) => pattern.test(text))) {
      return { append: false, reason: "blacklist" };
    }
    if (isRetryableAssistantError(message)) return { append: false, reason: "already-retryable" };
    if (contextWindow !== undefined && isContextOverflow(message, contextWindow)) {
      return { append: false, reason: "overflow" };
    }
  }

  // 无错误文本或未知措辞：一律追加，让内置判定器接盘。
  return { append: true };
}

/** 生成追加 hint 后的错误文本。text 可为空串（无详情错误）。 */
export function appendHint(text: string): string {
  return `${EXTENSION_TAG} ${RETRYABLE_HINT}: ${text}`;
}
