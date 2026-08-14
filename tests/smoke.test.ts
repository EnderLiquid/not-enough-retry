/**
 * 冒烟测试：验证扩展入口对真实 AgentSession.prototype 的补丁行为。
 *
 * 说明：
 * - 补丁打在项目 node_modules 里的 AgentSession 上（pi 运行时经 alias 指向宿主，
 *   同一类对象），进程内无副作用。
 * - 通过临时项目 settings 把 baseDelayMs 置 0，避免真实等待。
 * - 临时目录不清理，留在系统 temp（由系统定期回收）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NO_MIXIN_FLAG } from "../extensions/shared/config.ts";

type Handler = (event: any, ctx: any) => any;

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const flags = new Map<string, unknown>();
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
    registerFlag(_name) {
      // 只注册；getFlag 默认 undefined，由测试显式设置 flag 值。
    },
    getFlag(name) {
      return flags.get(name);
    },
  };
  return { handlers, flags, api };
}

function createHost() {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    host: {
      _retryAttempt: 0,
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
      settingsManager: { getRetrySettings: () => ({ enabled: true }) },
    },
  };
}

test("mixin 补丁：退避封顶、摘除 error、次数上限、事件形状", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ner-smoke-"));
  const piDir = join(tmp, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({
      "not-enough-retry": { mixin: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 30000 } },
    }),
  );

  const originalCwd = process.cwd();
  try {
    process.chdir(tmp);
    const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
    const { api } = createFakePi();
    notEnoughRetry(api as unknown as ExtensionAPI);

    const prepareRetry = (
      AgentSession.prototype as unknown as Record<"_prepareRetry", (message: unknown) => Promise<boolean>>
    )._prepareRetry;
    const { events, host } = createHost();

    // 第 1 次：delayMs=0（baseDelayMs 0），摘除 error 消息
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

    // 第 2 次：上限内
    assert.equal(await prepareRetry.call(host, { errorMessage: "weird" }), true);
    assert.equal(host._retryAttempt, 2);

    // 第 3 次：超过 maxRetries，回退计数并返回 false（原生语义）
    assert.equal(await prepareRetry.call(host, { errorMessage: "weird" }), false);
    assert.equal(host._retryAttempt, 2);
  } finally {
    process.chdir(originalCwd);
  }
});

test("message_end 处理器：未知错误追加 hint，返回替换消息", async () => {
  const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
  const { handlers, api } = createFakePi();
  notEnoughRetry(api as unknown as ExtensionAPI);

  const handler = handlers.get("message_end")![0]!;
  const ctx = {
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

test("mixin 补丁：CLI flag 应急关闭时交还原生实现", async () => {
  const { default: notEnoughRetry } = await import("../extensions/not-enough-retry.ts");
  const { flags, api } = createFakePi();
  flags.set(NO_MIXIN_FLAG, true);
  notEnoughRetry(api as unknown as ExtensionAPI);

  const prepareRetry = (
    AgentSession.prototype as unknown as Record<"_prepareRetry", (message: unknown) => Promise<boolean>>
  )._prepareRetry;
  const { events, host } = createHost();
  // 原生实现在 retry.enabled=false 时立即返回 false 且不发事件
  host.settingsManager = { getRetrySettings: () => ({ enabled: false }) };
  assert.equal(await prepareRetry.call(host, { errorMessage: "weird" }), false);
  assert.equal(events.length, 0);
  assert.equal(host._retryAttempt, 0);
});
