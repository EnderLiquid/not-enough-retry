/**
 * 冒烟测试：验证扩展入口对真实 AgentSession.prototype 的补丁行为。
 *
 * 补丁打在项目 node_modules 里的 AgentSession 上；测试 host 只实现 mixin
 * 实际依赖的运行时字段，并用 baseDelayMs=0 避免真实等待。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MIXIN_CONFIG, NO_MIXIN_FLAG } from "../extensions/shared/config.ts";

type Handler = (event: any, ctx: any) => any;

const STALE_CONTEXT_ERROR =
  "This extension ctx is stale after session replacement or reload.";

function createFakePi(options: { staleGetFlag?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const flags = new Map<string, unknown>();
  let getFlagCalls = 0;
  const api: {
    on: (event: string, handler: Handler) => void;
    registerFlag: (name: string, options: unknown) => void;
    getFlag: (name: string) => unknown;
  } = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerFlag() {
      // 只注册；运行时 flag 由当前 AgentSession.extensionRunner 提供。
    },
    getFlag(name) {
      getFlagCalls++;
      if (options.staleGetFlag) {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      }
      return flags.get(name);
    },
  };
  return { handlers, flags, api, getFlagCalls: () => getFlagCalls };
}

function mixinSettings(mixin: Record<string, unknown> = {}) {
  return {
    "not-enough-retry": {
      mixin: {
        maxRetries: 2,
        baseDelayMs: 0,
        maxDelayMs: 30000,
        ...mixin,
      },
    },
  };
}

type HostOptions = {
  settings?: unknown;
  flags?: Map<string, unknown>;
  retryEnabled?: boolean;
  nativeMaxRetries?: number;
  retryAttempt?: number;
};

function createHost(options: HostOptions = {}) {
  const events: Array<Record<string, unknown>> = [];
  let flagReads = 0;
  const flags = options.flags ?? new Map<string, unknown>();
  const host = {
    _retryAttempt: options.retryAttempt ?? 0,
    _emit: (event: Record<string, unknown>) => {
      events.push(event);
    },
    agent: {
      state: {
        messages: [
          { role: "user" },
          { role: "assistant", stopReason: "error", errorMessage: "weird upstream error" },
        ],
      },
    },
    settingsManager: {
      settings: options.settings ?? mixinSettings(),
      // 额外字段供真实原生 _prepareRetry 在降级测试中使用。
      getRetrySettings: () => ({
        enabled: options.retryEnabled ?? true,
        maxRetries: options.nativeMaxRetries ?? 0,
        baseDelayMs: 0,
      }),
    },
    extensionRunner: {
      getFlagValues: () => {
        flagReads++;
        return new Map(flags);
      },
    },
  };
  return { events, host, flagReads: () => flagReads };
}

function getPrepareRetry(): (message: unknown) => Promise<boolean> {
  return (
    AgentSession.prototype as unknown as Record<
      "_prepareRetry",
      (message: unknown) => Promise<boolean>
    >
  )._prepareRetry;
}

test("mixin 补丁：退避封顶、摘除 error、次数上限、事件形状", async () => {
  const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
  const { api } = createFakePi();
  notEnoughRetry(api as unknown as ExtensionAPI);

  const prepareRetry = getPrepareRetry();
  const { events, host } = createHost();

  assert.equal(await prepareRetry.call(host, { errorMessage: "weird" }), true);
  assert.equal(host._retryAttempt, 1);
  assert.equal(host.agent.state.messages.length, 1);
  assert.deepEqual(events[0], {
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 2,
    delayMs: 0,
    errorMessage: "weird",
  });

  assert.equal(await prepareRetry.call(host, { errorMessage: "weird" }), true);
  assert.equal(host._retryAttempt, 2);

  assert.equal(await prepareRetry.call(host, { errorMessage: "weird" }), false);
  assert.equal(host._retryAttempt, 2);
});

test("mixin 补丁：配置与 flag 按 AgentSession 隔离", async () => {
  const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
  const { api } = createFakePi();
  notEnoughRetry(api as unknown as ExtensionAPI);
  const prepareRetry = getPrepareRetry();

  const disabledFlags = new Map<string, unknown>([[NO_MIXIN_FLAG, true]]);
  const first = createHost({
    settings: mixinSettings({ maxRetries: 1 }),
    flags: disabledFlags,
  });
  const second = createHost({ settings: mixinSettings({ maxRetries: 2 }) });

  // 第一个 session 由自己的 flag 关闭 mixin，原生 maxRetries=0 直接返回 false。
  assert.equal(await prepareRetry.call(first.host, { errorMessage: "weird" }), false);
  assert.equal(first.events.length, 0);

  // 第二个 session 不受第一个 session 的 flag/config 影响。
  assert.equal(await prepareRetry.call(second.host, { errorMessage: "weird" }), true);
  assert.equal(await prepareRetry.call(second.host, { errorMessage: "weird" }), true);
  assert.equal(await prepareRetry.call(second.host, { errorMessage: "weird" }), false);
  assert.equal(second.events.length, 2);
  assert.equal(second.events[0]?.maxAttempts, 2);
});

test("mixin 补丁：run path 不调用 extension factory 捕获的 pi API", async () => {
  const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
  const fake = createFakePi({ staleGetFlag: true });
  assert.doesNotThrow(() => notEnoughRetry(fake.api as unknown as ExtensionAPI));

  const { host } = createHost({ settings: mixinSettings({ maxRetries: 1 }) });
  assert.equal(await getPrepareRetry().call(host, { errorMessage: "weird" }), true);
  assert.equal(fake.getFlagCalls(), 0);
});

test("mixin 补丁：非法插件配置无状态回退完整默认值", async () => {
  const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
  const { api } = createFakePi();
  notEnoughRetry(api as unknown as ExtensionAPI);

  const { host } = createHost({
    settings: mixinSettings({ maxRetries: "many", baseDelayMs: 0 }),
    retryAttempt: DEFAULT_MIXIN_CONFIG.maxRetries,
    nativeMaxRetries: 99,
  });
  // 默认 maxRetries=16 已到上限；若错误地走原生路径，这里会继续重试。
  assert.equal(await getPrepareRetry().call(host, { errorMessage: "weird" }), false);
  assert.equal(host._retryAttempt, DEFAULT_MIXIN_CONFIG.maxRetries);
});

test("mixin 补丁：宿主私有结构不兼容时交还原生实现", async () => {
  const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
  const { api } = createFakePi();
  notEnoughRetry(api as unknown as ExtensionAPI);

  const current = createHost();
  (current.host.settingsManager as { settings?: unknown }).settings = undefined;
  assert.equal(await getPrepareRetry().call(current.host, { errorMessage: "weird" }), false);
  assert.equal(current.events.length, 0);
  assert.equal(current.flagReads(), 0);
});

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

test("重复执行工厂不叠加同 revision 补丁层", async () => {
  const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
  const { api: firstApi } = createFakePi();
  notEnoughRetry(firstApi as unknown as ExtensionAPI);
  const afterFirst = getPrepareRetry();

  const { api: secondApi } = createFakePi();
  notEnoughRetry(secondApi as unknown as ExtensionAPI);
  assert.equal(getPrepareRetry(), afterFirst);
});

test("mixin 补丁：CLI flag 应急关闭时交还原生实现", async () => {
  const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
  const { api } = createFakePi();
  notEnoughRetry(api as unknown as ExtensionAPI);

  const flags = new Map<string, unknown>([[NO_MIXIN_FLAG, true]]);
  const { events, host } = createHost({ flags });
  assert.equal(await getPrepareRetry().call(host, { errorMessage: "weird" }), false);
  assert.equal(events.length, 0);
  assert.equal(host._retryAttempt, 0);
});
