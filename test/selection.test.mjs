import { strict as assert } from "node:assert";
import { test } from "node:test";
import { selectPoolOrder } from "../lib/codex-pool.mjs";
import {
  AUTH_FAIL_LIMIT,
  accountDeadReason,
  createInMemoryStatsStore,
  failCooldownMs,
  isAccountCoolingDown,
  isAccountDead,
  recordImageCall,
  recordQuotaCheck,
  summarizePoolStats,
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

test("a request-level failure (content policy) does not damage account health", async () => {
  const store = createInMemoryStatsStore();
  const email = "policy@example.com";
  for (let i = 0; i < 5; i++) {
    await recordImageCall(
      { email, success: false, error: "content_policy_violation", accountFault: false },
      { statsStore: store },
    );
  }
  const entry = store.state.accounts[accountSlotTag(email)];
  assert.equal(entry.consecutiveFails, 0);
  assert.equal(entry.failSince, null);
  assert.equal(entry.failCalls, 5, "total failures are still counted");
  assert.equal(isAccountCoolingDown(email, store.state), false);
});

test("two failed re-auths mark the account dead until a success revives it", async () => {
  const store = createInMemoryStatsStore();
  const email = "mfa@example.com";
  await recordImageCall({ email, success: false, error: "unauthorized", authFault: true }, { statsStore: store });
  assert.equal(isAccountDead(email, store.state), false, "one auth failure is not enough");
  await recordImageCall({ email, success: false, error: "unauthorized", authFault: true }, { statsStore: store });
  assert.equal(isAccountDead(email, store.state), true);
  assert.equal(accountDeadReason(email, store.state), "auth");

  await recordImageCall({ email, success: true, count: 1 }, { statsStore: store });
  assert.equal(isAccountDead(email, store.state), false);
  assert.equal(store.state.accounts[accountSlotTag(email)].authFails, 0);
});

test("an account that has not succeeded for three days is dead, and dead accounts sort last", () => {
  const stale = account("stale@example.com");
  const fresh = account("fresh@example.com");
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
  const stats = statsWith({
    [stale.email]: { imageQuota: 50, successCalls: 3, failCalls: 9, failSince: fourDaysAgo },
    [fresh.email]: { imageQuota: 1, successCalls: 1, failCalls: 0 },
  });

  assert.equal(accountDeadReason(stale.email, stats), "stale");
  assert.equal(isAccountDead(fresh.email, stats), false);

  const order = selectPoolOrder({ accounts: [stale, fresh], stats });
  assert.equal(order[0].email, fresh.email);
  assert.equal(order[order.length - 1].email, stale.email, "dead accounts are only a last resort");
});

test("summarizePoolStats reports dead accounts with a reason", () => {
  const stale = account("stale2@example.com");
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
  const stats = statsWith({
    [stale.email]: { imageQuota: 50, successCalls: 3, failCalls: 9, failSince: fourDaysAgo },
  });
  const snap = summarizePoolStats([stale], stats);
  assert.equal(snap.accounts[0].quotaStatus, "dead");
  assert.equal(snap.accounts[0].deadReason, "stale");
  assert.equal(snap.quotaStats.dead, 1);
  assert.equal(snap.quotaStats.active, 0);
});

// 线上真实现象：额度快照上还挂着 25，但成功次数是 0、失败几十次。这种号只靠冷却
// 会一小时一次地回到队列里，每次拖到超时，必须直接判死。
test("an account that never succeeded but failed many times is dead even with quota left", () => {
  const broken = account("broken@example.com");
  const working = account("working@example.com");
  const stats = statsWith({
    [broken.email]: { imageQuota: 25, successCalls: 0, failCalls: 52 },
    [working.email]: { imageQuota: 1, successCalls: 2, failCalls: 0 },
  });

  assert.equal(accountDeadReason(broken.email, stats), "never");
  assert.equal(isAccountDead(working.email, stats), false);

  const order = selectPoolOrder({ accounts: [broken, working], stats });
  assert.equal(order[0].email, working.email);
  assert.equal(order[order.length - 1].email, broken.email);
});

test("a single success is enough to keep an account out of the never-worked rule", () => {
  const once = account("once@example.com");
  const stats = statsWith({ [once.email]: { imageQuota: 5, successCalls: 1, failCalls: 40 } });
  assert.equal(accountDeadReason(once.email, stats), "");
});

test("a healthy quota check revives an account killed by failed re-auth", async () => {
  const store = createInMemoryStatsStore();
  const email = "revive@example.com";
  for (let i = 0; i < AUTH_FAIL_LIMIT; i++) {
    await recordImageCall({ email, success: false, error: "unauthorized", authFault: true }, { statsStore: store });
  }
  assert.equal(accountDeadReason(email, store.state), "auth");

  await recordQuotaCheck({ email, quota: 25, hasImageLimit: true }, { statsStore: store });
  assert.equal(isAccountDead(email, store.state), false);
  assert.equal(store.state.accounts[accountSlotTag(email)].authFails, 0);
  assert.equal(store.state.accounts[accountSlotTag(email)].consecutiveFails, 0);
});
