import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MIXIN_CONFIG } from "../extensions/shared/config.ts";
import { calculateRetryDelayMs } from "../extensions/shared/mixin.ts";

test("退避按指数增长且封顶", () => {
  const config = { ...DEFAULT_MIXIN_CONFIG, baseDelayMs: 2000, maxDelayMs: 30000 };
  assert.equal(calculateRetryDelayMs(1, config), 2000);
  assert.equal(calculateRetryDelayMs(2, config), 4000);
  assert.equal(calculateRetryDelayMs(3, config), 8000);
  assert.equal(calculateRetryDelayMs(4, config), 16000);
  // 第 5 次原始 32000 超过封顶 30000
  assert.equal(calculateRetryDelayMs(5, config), 30000);
  assert.equal(calculateRetryDelayMs(20, config), 30000);
});

test("baseDelayMs 为 0 时退避恒为 0", () => {
  const config = { ...DEFAULT_MIXIN_CONFIG, baseDelayMs: 0, maxDelayMs: 30000 };
  assert.equal(calculateRetryDelayMs(1, config), 0);
  assert.equal(calculateRetryDelayMs(10, config), 0);
});
