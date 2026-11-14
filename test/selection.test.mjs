import { strict as assert } from "node:assert";
import { test } from "node:test";
import { selectPoolOrder } from "../lib/codex-pool.mjs";
import {
  createInMemoryStatsStore,
  failCooldownMs,
  isAccountCoolingDown,
  recordImageCall,
} from "../lib/pool-stats.mjs";
import { accountSlotTag } from "../lib/pool-connection.mjs";

const account = (email) => ({ email, password: "p", totp: "seed", accessToken: "t" });

function statsWith(entries) {
  const accounts = {};
  for (const [email, entry] of Object.entries(entries)) {
    accounts[accountSlotTag(email)] = { imageQuota: null, successCalls: 0, failCalls: 0, ...entry };
  }
  return { totals: { successCalls: 0, failCalls: 0 }, accounts };
}

test("weighted rotation hands out requests in proportion to remaining quota", () => {
  const a = account("a-ratio@example.com");
  const b = account("b-ratio@example.com");
  const stats = statsWith({
    [a.email]: { imageQuota: 30, successCalls: 10, failCalls: 0 },
    [b.email]: { imageQuota: 10, successCalls: 10, failCalls: 0 },
  });

  const picks = { [a.email]: 0, [b.email]: 0 };
  for (let i = 0; i < 40; i++) {
    const [first] = selectPoolOrder({ accounts: [a, b], stats });
    picks[first.email] += 1;
  }

  assert.equal(picks[a.email] + picks[b.email], 40);
  // 权重 3:1 → 30:10，允许一格误差
  assert(Math.abs(picks[a.email] - 30) <= 1, `A picked ${picks[a.email]}`);
  assert(Math.abs(picks[b.email] - 10) <= 1, `B picked ${picks[b.email]}`);
});

test("exhausted and cooling accounts are pushed behind every usable account", () => {
  const good = account("good@example.com");
  const cooling = account("cooling@example.com");
  const limited = account("limited@example.com");
  const stats = statsWith({
    [good.email]: { imageQuota: 5, successCalls: 3, failCalls: 0 },
    [cooling.email]: {
      imageQuota: 25,
      successCalls: 0,
      failCalls: 9,
      consecutiveFails: 9,
      cooldownUntil: new Date(Date.now() + 600_000).toISOString(),
    },
    [limited.email]: { imageQuota: 0, successCalls: 4, failCalls: 2 },
  });

  for (let i = 0; i < 5; i++) {
    const order = selectPoolOrder({ accounts: [cooling, limited, good], stats });
    assert.equal(order[0].email, good.email, "usable account must come first");
    assert.equal(order.length, 3);
  }
});

test("preferred slot is honoured only while its quota stays comparable", () => {
  const rich = account("rich@example.com");
  const poor = account("poor@example.com");
  const stats = statsWith({
    [rich.email]: { imageQuota: 20, successCalls: 5, failCalls: 0 },
    [poor.email]: { imageQuota: 2, successCalls: 5, failCalls: 0 },
  });

  const honoured = selectPoolOrder({
    accounts: [poor, rich], stats, preferredSlot: accountSlotTag(rich.email),
  });
  assert.equal(honoured[0].email, rich.email);

  const demoted = selectPoolOrder({
    accounts: [poor, rich], stats, preferredSlot: accountSlotTag(poor.email),
  });
  assert.notEqual(demoted[0].email, poor.email, "a nearly empty preferred slot must give way");
});

test("three consecutive failures open a cooldown that a success clears", async () => {
  const store = createInMemoryStatsStore();
  const email = "breaker@example.com";

  for (let i = 0; i < 2; i++) {
    await recordImageCall({ email, success: false, error: "upstream_error" }, { statsStore: store });
  }
  assert.equal(isAccountCoolingDown(email, store.state), false, "two failures are not enough");

  await recordImageCall({ email, success: false, error: "upstream_error" }, { statsStore: store });
  assert.equal(isAccountCoolingDown(email, store.state), true, "third failure opens the cooldown");

  const entry = store.state.accounts[accountSlotTag(email)];
  assert.equal(entry.consecutiveFails, 3);
  assert(entry.cooldownUntil);

  await recordImageCall({ email, success: true, count: 1 }, { statsStore: store });
  const after = store.state.accounts[accountSlotTag(email)];
  assert.equal(after.consecutiveFails, 0);
  assert.equal(after.cooldownUntil, null);
  assert.equal(isAccountCoolingDown(email, store.state), false);
});

test("cooldown backs off with the failure streak and is capped at an hour", () => {
  assert.equal(failCooldownMs(1), 0);
  assert.equal(failCooldownMs(2), 0);
  assert.equal(failCooldownMs(3), 10 * 60 * 1000);
  assert.equal(failCooldownMs(4), 20 * 60 * 1000);
  assert.equal(failCooldownMs(5), 40 * 60 * 1000);
  assert.equal(failCooldownMs(9), 60 * 60 * 1000);
});
