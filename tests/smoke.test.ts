/**
 * 冒烟测试：扩展入口在 message_end 上的 hint 行为。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: any, ctx: any) => any;

const STALE_CONTEXT_ERROR =
  "This extension ctx is stale after session replacement or reload.";

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  return { handlers, api };
}

test("message_end 处理器：未知错误追加 hint，返回替换消息", async () => {
  const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
  const { handlers, api } = createFakePi();
  notEnoughRetry(api as unknown as ExtensionAPI);

  const handler = handlers.get("message_end")![0]!;
  const ctx = {
    signal: undefined,
    getContextUsage: () => undefined,
  };
  const event = {
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "上游模型响应错误",
      timestamp: Date.now(),
    },
  };
  const result = await handler(event, ctx);
  assert.ok(result.message.errorMessage.includes("[not-enough-retry]"));
  assert.ok(result.message.errorMessage.includes("provider returned error"));
  // 原消息对象未被原地修改（扩展替换语义：返回新对象）
  assert.equal(event.message.errorMessage, "上游模型响应错误");
});

test("message_end 处理器：active signal 已取消时不追加 hint", async () => {
  const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
  const { handlers, api } = createFakePi();
  notEnoughRetry(api as unknown as ExtensionAPI);

  const handler = handlers.get("message_end")![0]!;
  const controller = new AbortController();
  controller.abort();
  const event = {
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "an unknown local cancellation failure",
      timestamp: Date.now(),
    },
  };

  const result = await handler(event, {
    signal: controller.signal,
    getContextUsage: () => undefined,
  });

  assert.equal(result, undefined);
  assert.equal(event.message.errorMessage, "an unknown local cancellation failure");
});

test("message_end 处理器：stale ctx 下未知错误仍追加 hint", async () => {
  const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
  const { handlers, api } = createFakePi();
  notEnoughRetry(api as unknown as ExtensionAPI);

  const handler = handlers.get("message_end")![0]!;
  const event = {
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "unrecognized provider failure",
      timestamp: Date.now(),
    },
  };
  const staleCtx = {
    getContextUsage: () => undefined,
    get signal(): AbortSignal {
      throw new Error(STALE_CONTEXT_ERROR);
    },
  };

  const result = await handler(event, staleCtx);
  assert.ok(result.message.errorMessage.includes("[not-enough-retry]"));
  assert.equal(event.message.errorMessage, "unrecognized provider failure");
});

test("message_end 处理器：stale ctx 下 aborted 消息仍不追加 hint", async () => {
  const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
  const { handlers, api } = createFakePi();
  notEnoughRetry(api as unknown as ExtensionAPI);

  const handler = handlers.get("message_end")![0]!;
  const event = {
    message: {
      role: "assistant",
      content: [],
      stopReason: "aborted",
      errorMessage: "request stopped",
      timestamp: Date.now(),
    },
  };
  const staleCtx = {
    getContextUsage: () => {
      throw new Error(STALE_CONTEXT_ERROR);
    },
    signal: undefined,
  };

  const result = await handler(event, staleCtx);
  assert.equal(result, undefined);
  assert.equal(event.message.errorMessage, "request stopped");
});
