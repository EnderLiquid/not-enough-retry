import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_MIXIN_CONFIG,
  loadMixinConfig,
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

test("sanitize：enabled 仅在显式 false 时关闭", () => {
  assert.equal(sanitizeMixinConfig({}).enabled, true);
  assert.equal(sanitizeMixinConfig({ enabled: true }).enabled, true);
  assert.equal(sanitizeMixinConfig({ enabled: false }).enabled, false);
});

test("loadMixinConfig：读取项目级 not-enough-retry.mixin 段", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ner-config-"));
  const piDir = join(tmp, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({
      "not-enough-retry": { mixin: { maxRetries: 7, baseDelayMs: 500 } },
    }),
  );
  const config = loadMixinConfig(tmp);
  assert.equal(config.maxRetries, 7);
  assert.equal(config.baseDelayMs, 500);
  assert.equal(config.maxDelayMs, DEFAULT_MIXIN_CONFIG.maxDelayMs);
});

test("loadMixinConfig：settings 损坏时抛出", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ner-config-"));
  const piDir = join(tmp, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, "settings.json"), "{ not json");
  assert.throws(() => loadMixinConfig(tmp), /failed to parse/);
});

test("loadMixinConfig：非法字段值抛出", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ner-config-"));
  const piDir = join(tmp, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({
      "not-enough-retry": { mixin: { maxRetries: "many" } },
    }),
  );
  assert.throws(() => loadMixinConfig(tmp), /non-negative/);
});
