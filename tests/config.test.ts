import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MIXIN_CONFIG,
  resolveMixinConfig,
  sanitizeMixinConfig,
} from "../extensions/shared/config.ts";

test("sanitize：合法值原样保留，小数截断", () => {
  const config = sanitizeMixinConfig({ maxRetries: 5.9, baseDelayMs: 1000, maxDelayMs: 60000 });
  assert.equal(config.maxRetries, 5);
  assert.equal(config.baseDelayMs, 1000);
  assert.equal(config.maxDelayMs, 60000);
});

test("sanitize：非法值直接抛出", () => {
  assert.throws(() => sanitizeMixinConfig({ maxRetries: Number.NaN }), /non-negative/);
  assert.throws(() => sanitizeMixinConfig({ baseDelayMs: -1 }), /non-negative/);
  assert.throws(
    () => sanitizeMixinConfig({ maxDelayMs: "fast" as unknown as number }),
    /non-negative/,
  );
});

test("sanitize：部分缺失时按字段回退", () => {
  const config = sanitizeMixinConfig({ maxRetries: 3 });
  assert.equal(config.maxRetries, 3);
  assert.equal(config.baseDelayMs, DEFAULT_MIXIN_CONFIG.baseDelayMs);
  assert.equal(config.maxDelayMs, DEFAULT_MIXIN_CONFIG.maxDelayMs);
});

test("sanitize：enabled 必须是布尔值", () => {
  assert.equal(sanitizeMixinConfig({}).enabled, true);
  assert.equal(sanitizeMixinConfig({ enabled: true }).enabled, true);
  assert.equal(sanitizeMixinConfig({ enabled: false }).enabled, false);
  assert.throws(
    () => sanitizeMixinConfig({ enabled: "false" as unknown as boolean, maxRetries: 3 }),
    /boolean/,
  );
});

test("resolveMixinConfig：读取 Pi SettingsManager 的当前合并快照", () => {
  const manager = SettingsManager.inMemory(
    {
      "not-enough-retry": {
        mixin: { maxRetries: 9, baseDelayMs: 250 },
      },
    } as unknown as Parameters<typeof SettingsManager.inMemory>[0],
  );
  const snapshot = (manager as unknown as { settings: unknown }).settings as Parameters<
    typeof resolveMixinConfig
  >[0];
  const config = resolveMixinConfig(snapshot);
  assert.equal(config.maxRetries, 9);
  assert.equal(config.baseDelayMs, 250);
});

test("resolveMixinConfig：读取普通 merged settings 快照", () => {
  const config = resolveMixinConfig({
    "not-enough-retry": {
      mixin: { maxRetries: 7, baseDelayMs: 500 },
    },
  });
  assert.equal(config.maxRetries, 7);
  assert.equal(config.baseDelayMs, 500);
  assert.equal(config.maxDelayMs, DEFAULT_MIXIN_CONFIG.maxDelayMs);
});

test("resolveMixinConfig：配置段缺失或形状错误时使用默认值", () => {
  assert.deepEqual(resolveMixinConfig({}), DEFAULT_MIXIN_CONFIG);
  assert.deepEqual(
    resolveMixinConfig({ "not-enough-retry": { mixin: "invalid" } }),
    DEFAULT_MIXIN_CONFIG,
  );
});

test("resolveMixinConfig：任一字段非法时回退完整默认配置", () => {
  const config = resolveMixinConfig({
    "not-enough-retry": {
      mixin: { enabled: "yes", maxRetries: 3, baseDelayMs: 0 },
    },
  });
  assert.deepEqual(config, DEFAULT_MIXIN_CONFIG);
  assert.notEqual(config, DEFAULT_MIXIN_CONFIG);
});
