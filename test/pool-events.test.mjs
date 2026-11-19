import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  POOL_EVENT_MAX_LIMIT,
  clearPoolEvents,
  poolEventStats,
  recentPoolEvents,
  recordPoolEvent,
} from "../lib/pool-events.mjs";
import { accountSlotTag } from "../lib/pool-connection.mjs";
import { DEFAULT_POOL_POLICY, normalizePoolPolicy } from "../lib/pool-policy.mjs";
import { applySweepPolicy, selectPoolOrder, stopQuotaSweep } from "../lib/codex-pool.mjs";

test("pool events keep order and never store emails", () => {
  clearPoolEvents();
  const email = "leak@example.com";
  recordPoolEvent("account.parked", { email, until: "2026-01-01T00:00:00.000Z", reason: "429" });
  recordPoolEvent("sweep.run", { count: 2, limit: 2, ok: true });

  const events = recentPoolEvents({ limit: 10 });
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "account.parked");
  assert.equal(events[1].kind, "sweep.run");
  // 邮箱只能以 slot tag 出现，明文一个字符都不许留。
  assert(!JSON.stringify(events).includes("leak@example.com"), "no plaintext email in the log");
  assert.equal(events[0].tag, accountSlotTag(email));
  assert.equal(events[1].count, 2);
});

test("pool events filter by kind and by since", () => {
  clearPoolEvents();
  recordPoolEvent("sweep.run", { count: 1 }, { nowMs: 1000 });
  recordPoolEvent("policy.change", { strategy: "preferred" }, { nowMs: 2000 });
  recordPoolEvent("sweep.run", { count: 3 }, { nowMs: 3000 });

  assert.deepEqual(recentPoolEvents({ kind: "sweep." }).map((e) => e.count), [1, 3]);
  assert.deepEqual(recentPoolEvents({ since: 2000 }).map((e) => e.kind), ["sweep.run"]);
  assert.equal(recentPoolEvents({ limit: POOL_EVENT_MAX_LIMIT + 50 }).length, 3);
});

test("a bogus event kind is dropped instead of throwing", () => {
  clearPoolEvents();
  assert.equal(recordPoolEvent("", {}), null);
  assert.equal(recordPoolEvent("Sweep Run", {}), null);
  const bare = recordPoolEvent("sweep.run", null);
  assert(bare, "a null detail still records the bare event");
  assert.equal(bare.kind, "sweep.run");
  assert.equal(recentPoolEvents().length, 1);
});

test("stats report this process only", () => {
  clearPoolEvents();
  recordPoolEvent("sweep.run", { count: 1 });
  const stats = poolEventStats();
  assert.equal(stats.pid, process.pid);
  assert.equal(stats.stored, 1);
  assert.equal(stats.dropped, 0);
});

test("rotation policy normalizes to a known strategy and clamps sweep", () => {
  const base = normalizePoolPolicy({});
  assert.equal(base.rotation.strategy, "quotaFirst");
  assert.equal(base.rotation.respectPreferredSlot, true);
  assert.equal(base.sweep.enabled, true);
  assert.equal(base.sweep.intervalMinutes, DEFAULT_POOL_POLICY.sweep.intervalMinutes);

  const bogus = normalizePoolPolicy({
    rotation: { strategy: "random", respectPreferredSlot: false },
    sweep: { enabled: false, intervalMinutes: 0, limit: 999, staleAfterMinutes: -5 },
  });
  assert.equal(bogus.rotation.strategy, "quotaFirst", "unknown strategy falls back, not crashes");
  assert.equal(bogus.rotation.respectPreferredSlot, false);
  assert.equal(bogus.sweep.enabled, false);
  assert.equal(bogus.sweep.intervalMinutes, 1, "interval is clamped to 1 minute");
  assert.equal(bogus.sweep.limit, 50);
  assert.equal(bogus.sweep.staleAfterMinutes, 0);
});

const accounts = ["a@example.com", "b@example.com"].map((email) => ({
  email, password: "p", totp: "s", accessToken: "t",
}));
const preferred = "b@example.com";
// preferredSlot 传的是 slot tag（`s<sha10>`），不是邮箱 —— movePreferredFirst 按 tag 匹配。
const preferredTag = accountSlotTag(preferred);

function statsWith(quotaByEmail) {
  const state = { accounts: {} };
  for (const [email, imageQuota] of Object.entries(quotaByEmail)) {
    state.accounts[accountSlotTag(email)] = { imageQuota };
  }
  return state;
}

test("quotaFirst pins a healthy preferred slot, roundRobin never pins", () => {
  const stats = statsWith({ "a@example.com": 10, [preferred]: 10 });
  const leadersOf = (strategy, times) => {
    const out = [];
    for (let i = 0; i < times; i++) {
      out.push(selectPoolOrder({
        accounts, preferredSlot: preferredTag, stats, rotate: true,
        policy: normalizePoolPolicy({ rotation: { strategy } }),
      })[0].email);
    }
    return out;
  };

  // 额度相同 → 首选号每次都领跑（quotaFirst 过门槛，pin 住）。
  assert.deepEqual(leadersOf("quotaFirst", 4), Array(4).fill(preferred));
  // 同一份数据下 roundRobin 不 pin：轮转账本会让两个号轮流领跑。
  assert.equal(new Set(leadersOf("roundRobin", 4)).size, 2, "roundRobin spreads the lead");
});

test("preferred is unconditional, quotaFirst gives the lead away to a richer slot", () => {
  // 首选号只剩 1 点额度，另一个 50 点：quotaFirst 的 50% 门槛会让位。
  const stats = statsWith({ "a@example.com": 50, [preferred]: 1 });
  const order = (strategy) => selectPoolOrder({
    accounts, preferredSlot: preferredTag, stats, rotate: true,
    policy: normalizePoolPolicy({ rotation: { strategy } }),
  }).map((a) => a.email);

  assert.equal(order("quotaFirst")[0], "a@example.com", "a spent preferred slot loses the lead");
  assert.equal(order("preferred")[0], preferred, "preferred is unconditional");
});

test("respectPreferredSlot=false turns the pin off for quotaFirst too", () => {
  const stats = statsWith({ "a@example.com": 10, [preferred]: 10 });
  const leaders = [];
  for (let i = 0; i < 4; i++) {
    leaders.push(selectPoolOrder({
      accounts, preferredSlot: preferredTag, stats, rotate: true,
      policy: normalizePoolPolicy({ rotation: { strategy: "quotaFirst", respectPreferredSlot: false } }),
    })[0].email);
  }
  assert.equal(new Set(leaders).size, 2, "without the pin the lead rotates");
});

test("applySweepPolicy stops and restarts the timer from policy", () => {
  // 关掉时不留下定时器；打开时按策略重建（setInterval 的周期定死在创建那刻）。
  assert.equal(applySweepPolicy(normalizePoolPolicy({ sweep: { enabled: false } })), null);
  const timer = applySweepPolicy(normalizePoolPolicy({ sweep: { enabled: true, intervalMinutes: 5 } }));
  assert(timer, "enabled starts a timer");
  stopQuotaSweep();
  assert.equal(stopQuotaSweep(), undefined, "stopping twice is harmless");
});
