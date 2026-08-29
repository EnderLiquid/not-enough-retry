import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  appendHint,
  decideHint,
  DEFAULT_ABORT_MESSAGE,
  EXTENSION_TAG,
  isDefaultAbortMessage,
  NON_RETRYABLE_PATTERNS,
} from "../extensions/shared/error-patterns.ts";

function assistantError(
  errorMessage: string | undefined,
  stopReason: "error" | "aborted" = "error",
): AgentMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai",
    provider: "openai",
    model: "gpt-test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  } as AgentMessage;
}

test("黑名单：鉴权类错误不追加 hint", () => {
  for (const text of [
    "401 Invalid API key",
    "invalid authentication credentials",
    "API key not found in headers",
    "api key revoked by administrator",
  ]) {
    const decision = decideHint(assistantError(text));
    assert.deepEqual(decision, { append: false, reason: "blacklist" });
  }
});

test("黑名单：模型不存在类错误不追加 hint", () => {
  for (const text of [
    "model not found",
    "unknown model gpt-9",
    "no such model: xyz",
    "model does not exist",
    "unsupported model",
    "cannot continue from message role",
  ]) {
    const decision = decideHint(assistantError(text));
    assert.deepEqual(decision, { append: false, reason: "blacklist" });
  }
});

test("AbortSignal 默认 message 不追加 hint", () => {
  for (const text of [
    DEFAULT_ABORT_MESSAGE,
    `AbortError: ${DEFAULT_ABORT_MESSAGE}`,
    `MCP error -32001: AbortError: ${DEFAULT_ABORT_MESSAGE}`,
  ]) {
    assert.deepEqual(decideHint(assistantError(text)), {
      append: false,
      reason: "aborted",
    });
  }
});

test("结构化 aborted stop reason 不追加 hint", () => {
  assert.deepEqual(decideHint(assistantError("ignored", "aborted")), {
    append: false,
    reason: "aborted",
  });
});

test("active AbortSignal 已取消时不追加 hint", () => {
  const controller = new AbortController();
  controller.abort();

  assert.deepEqual(decideHint(assistantError("unknown error"), undefined, controller.signal), {
    append: false,
    reason: "aborted",
  });
});

test("自定义取消文案不命中默认 message fallback", () => {
  for (const text of ["The operation was aborted", "Request aborted", "Request cancelled by user"]) {
    assert.equal(isDefaultAbortMessage(text), false, text);
    assert.deepEqual(decideHint(assistantError(text)), { append: true });
  }
});

test("黑名单覆盖 pi 内置判定器认不出的新措辞", () => {
  const decision = decideHint(assistantError("上游模型响应错误: channel unavailable"));
  assert.deepEqual(decision, { append: true });
});

test("黑名单关键词不是整体匹配，措辞变化仍会命中", () => {
  // 多空格与大小写变化均命中 /invalid\s*api\s*key/i
  const decision = decideHint(assistantError("401 Invalid  API  Key provided"));
  assert.equal(decision.append, false);
});

test("已知取舍：语序/连字符变体不命中黑名单，代价仅是无效重试几次", () => {
  // 照抄榜二黑名单的盲区：invalid 在 api key 之后（如 "x-api-key is invalid"）、
  // incorrect 替换 invalid（如 OpenAI 的 "Incorrect API key provided"）、
  // 连字符（"invalid api-key"）都不会命中，会重试几次后放弃。可接受。
  for (const text of [
    "the provided x-api-key is invalid",
    "Incorrect API key provided: sk-...",
    "invalid api-key",
  ]) {
    assert.deepEqual(decideHint(assistantError(text)), { append: true });
  }
});

test("已含本扩展标记的错误不重复追加", () => {
  const text = `${EXTENSION_TAG} provider returned error: some error`;
  assert.deepEqual(decideHint(assistantError(text)), {
    append: false,
    reason: "already-hinted",
  });
});

test("已命中内置白名单的错误不再追加（避免污染文本）", () => {
  assert.deepEqual(decideHint(assistantError("rate limit exceeded")), {
    append: false,
    reason: "already-retryable",
  });
  assert.deepEqual(decideHint(assistantError("connection error")), {
    append: false,
    reason: "already-retryable",
  });
});

test("上下文溢出错误不追加（让位压缩，避免污染文本）", () => {
  const decision = decideHint(assistantError("exceeds the context window"), 131072);
  assert.deepEqual(decision, { append: false, reason: "overflow" });
});

test("无 contextWindow 时跳过溢出检查", () => {
  const decision = decideHint(assistantError("exceeds the context window"));
  assert.deepEqual(decision, { append: true });
});

test("空串与 undefined 错误文本同样追加（catch-all）", () => {
  assert.deepEqual(decideHint(assistantError("")), { append: true });
  assert.deepEqual(decideHint(assistantError(undefined)), { append: true });
});

test("非 assistant / 非 error 消息不追加", () => {
  const user: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "hi" }],
    timestamp: Date.now(),
  };
  assert.deepEqual(decideHint(user), { append: false, reason: "non-assistant" });

  const stopped = assistantError("whatever") as AgentMessage & { stopReason: string };
  stopped.stopReason = "stop";
  assert.deepEqual(decideHint(stopped), { append: false, reason: "non-error" });

  assert.deepEqual(decideHint(assistantError("whatever", "aborted")), {
    append: false,
    reason: "aborted",
  });
});

test("appendHint 输出包含标记与内置关键词", () => {
  const result = appendHint("channel error");
  assert.ok(result.includes(EXTENSION_TAG));
  assert.ok(result.includes("provider returned error"));
  assert.ok(result.endsWith("channel error"));
});

test("appendHint 空文本可用（无详情错误）", () => {
  const result = appendHint("");
  assert.ok(result.includes("provider returned error"));
});

test("黑名单模式数量与语义稳定（防止意外漂移）", () => {
  assert.equal(NON_RETRYABLE_PATTERNS.length, 9);
});
