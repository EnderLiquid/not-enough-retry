import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  installPrepareRetryMixin,
  MIXIN_REVISION,
} from "../extensions/shared/mixin.ts";

type PrepareRetry = ((...args: unknown[]) => Promise<boolean>) & {
  [key: symbol]: unknown;
};

type RetryPrototype = {
  _prepareRetry: PrepareRetry;
  [key: symbol]: unknown;
};

const REGISTRY_KEY = Symbol.for("not-enough-retry.mixin-registry");
const LEGACY_MARKER_KEY = Symbol.for("not-enough-retry.mixin-installed");

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

function highest(versions: Set<number>): number {
  let result = 0;
  for (const version of versions) result = Math.max(result, version);
  return result;
}

test("legacy boolean marker 不做热迁移，等待完整重启", () => {
  const proto = AgentSession.prototype as unknown as RetryPrototype;
  const originalMethod = proto._prepareRetry;
  const registryDescriptor = Object.getOwnPropertyDescriptor(proto, REGISTRY_KEY);

  try {
    Reflect.deleteProperty(proto, REGISTRY_KEY);
    const legacy = (async () => true) as PrepareRetry;
    legacy[LEGACY_MARKER_KEY] = true;
    proto._prepareRetry = legacy;

    installPrepareRetryMixin();

    assert.equal(proto._prepareRetry, legacy);
    assert.equal(proto[REGISTRY_KEY], undefined);
  } finally {
    proto._prepareRetry = originalMethod;
    restoreProperty(proto, REGISTRY_KEY, registryDescriptor);
  }
});

test("revision registry：同版本幂等，低版本失活并穿过第三方 wrapper", async () => {
  const proto = AgentSession.prototype as unknown as RetryPrototype;
  const originalMethod = proto._prepareRetry;
  const registryDescriptor = Object.getOwnPropertyDescriptor(proto, REGISTRY_KEY);

  try {
    Reflect.deleteProperty(proto, REGISTRY_KEY);
    installPrepareRetryMixin();

    const versionOne = proto._prepareRetry;
    const registry = proto[REGISTRY_KEY];
    assert.ok(registry instanceof Set);
    assert.deepEqual([...registry], [MIXIN_REVISION]);
    assert.equal(versionOne[LEGACY_MARKER_KEY], undefined);

    installPrepareRetryMixin();
    assert.equal(proto._prepareRetry, versionOne, "同 revision 不应重复包裹");

    let thirdPartyCalls = 0;
    const thirdParty = (async function (this: unknown, ...args: unknown[]) {
      thirdPartyCalls++;
      return Reflect.apply(versionOne, this, args);
    }) as PrepareRetry;
    proto._prepareRetry = thirdParty;

    let versionTwoCalls = 0;
    const versionTwo = (async function (this: unknown, ...args: unknown[]) {
      if (highest(registry) !== 2) return Reflect.apply(thirdParty, this, args);
      versionTwoCalls++;
      return Reflect.apply(thirdParty, this, args);
    }) as PrepareRetry;
    proto._prepareRetry = versionTwo;
    registry.add(2);

    let flagReads = 0;
    const host = {
      settingsManager: {
        getRetrySettings: () => ({ enabled: false }),
      },
      extensionRunner: {
        getFlagValues: () => {
          flagReads++;
          return new Map<string, unknown>();
        },
      },
    };

    assert.equal(await proto._prepareRetry.call(host, { errorMessage: "weird" }), false);
    assert.equal(versionTwoCalls, 1);
    assert.equal(thirdPartyCalls, 1);
    assert.equal(flagReads, 0, "失活 V1 必须在读取 session 状态前透明转发");

    installPrepareRetryMixin();
    assert.equal(proto._prepareRetry, versionTwo, "高版本存在时重新加载 V1 不应增加新层");

    registry.add(3);
    assert.equal(await proto._prepareRetry.call(host, { errorMessage: "weird" }), false);
    assert.equal(versionTwoCalls, 1, "V3 出现后 V2 也应失活");
    assert.equal(thirdPartyCalls, 2);
    assert.equal(flagReads, 0);
  } finally {
    proto._prepareRetry = originalMethod;
    restoreProperty(proto, REGISTRY_KEY, registryDescriptor);
  }
});
