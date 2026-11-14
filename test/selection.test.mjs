import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  accountsNeedingQuotaRefresh,
  refreshExpiredQuotas,
  selectPoolOrder,
  textPoolAccounts,
} from "../lib/codex-pool.mjs";
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

// 一个"还没过期"的 JWT，用来区分"能直接问额度"和"得先重新登录"。
const liveToken = () => [
  Buffer.from('{"alg":"RS256"}').toString("base64url"),
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
  "sig",
].join(".");

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

// "失败了 84 次" 这种记录没法排查，得知道是 MFA 被拦还是超时。原因码要落盘。
test("the last failure reason is recorded per account and cleared on success", async () => {
  const store = createInMemoryStatsStore();
  const email = "why@example.com";
  const tag = accountSlotTag(email);

  await recordImageCall({ email, success: false, error: "mfa_verify_failed_403" }, { statsStore: store });
  assert.equal(store.state.accounts[tag].lastErrorCode, "mfa_verify_failed_403");
  assert.ok(store.state.accounts[tag].lastErrorAt, "failure timestamp is kept");

  // 请求本身的错也记原因码，但不影响账号健康。
  await recordImageCall({ email, success: false, error: "content_policy_violation", accountFault: false }, { statsStore: store });
  assert.equal(store.state.accounts[tag].lastErrorCode, "content_policy_violation");
  assert.equal(store.state.accounts[tag].consecutiveFails, 1, "request faults do not add to the streak");

  await recordImageCall({ email, success: true, count: 1 }, { statsStore: store });
  assert.equal(store.state.accounts[tag].lastErrorCode, null);
  assert.equal(store.state.accounts[tag].lastErrorAt, null);
});

test("an error code that is not a plain identifier is dropped instead of stored", async () => {
  const store = createInMemoryStatsStore();
  const email = "dirty@example.com";
  await recordImageCall({
    email, success: false, error: "upstream said: <html>Bearer sk-abc</html>",
  }, { statsStore: store });
  assert.equal(store.state.accounts[accountSlotTag(email)].lastErrorCode, null);
});

// 额度只会在"成功 -1"时减少，打到 0 之后就永远挂着 0。上游 24 小时重置了也没人
// 知道，得人工点「检测额度」——号池会越用越少。所以要在重置时间过后自动复检。
test("only a zero-quota account whose reset time has passed is picked for a quiet re-check", () => {
  const live = { email: "reset@example.com", accessToken: liveToken() };
  const past = new Date(Date.now() - 3600_000).toISOString();
  const future = new Date(Date.now() + 3600_000).toISOString();

  const expired = statsWith({ [live.email]: { imageQuota: 0, restoreAt: past } });
  assert.equal(accountsNeedingQuotaRefresh([live], expired, { probedAt: new Map() }).length, 1);

  const notYet = statsWith({ [live.email]: { imageQuota: 0, restoreAt: future } });
  assert.equal(
    accountsNeedingQuotaRefresh([live], notYet, { probedAt: new Map() }).length, 0,
    "the reset time has not arrived yet",
  );

  const hasQuota = statsWith({ [live.email]: { imageQuota: 5, restoreAt: past } });
  assert.equal(
    accountsNeedingQuotaRefresh([live], hasQuota, { probedAt: new Map() }).length, 0,
    "an account with quota left needs no probe",
  );

  // token 已经过期：问额度就得重新登录，那不叫"顺手"，交给人工。
  const stale = { email: "needslogin@example.com", accessToken: "not-a-jwt" };
  const staleStats = statsWith({ [stale.email]: { imageQuota: 0, restoreAt: past } });
  assert.equal(accountsNeedingQuotaRefresh([stale], staleStats, { probedAt: new Map() }).length, 0);
});

test("a dead account is never re-checked automatically, and the probe gap is honoured", () => {
  const live = { email: "dead@example.com", accessToken: liveToken() };
  const past = new Date(Date.now() - 3600_000).toISOString();
  const stats = statsWith({ [live.email]: { imageQuota: 0, restoreAt: past, successCalls: 0, failCalls: 90 } });
  assert.equal(accountDeadReason(live.email, stats), "never");
  assert.equal(accountsNeedingQuotaRefresh([live], stats, { probedAt: new Map() }).length, 0);

  const alive = { email: "gap@example.com", accessToken: liveToken() };
  const gapStats = statsWith({ [alive.email]: { imageQuota: 0, restoreAt: past } });
  const recent = new Map([[alive.email, Date.now() - 60_000]]);
  assert.equal(accountsNeedingQuotaRefresh([alive], gapStats, { probedAt: recent }).length, 0);
  const old = new Map([[alive.email, Date.now() - 11 * 60_000]]);
  assert.equal(accountsNeedingQuotaRefresh([alive], gapStats, { probedAt: old }).length, 1);
});

test("the background re-check never re-authenticates, and a recovered quota puts the account back", async () => {
  const store = createInMemoryStatsStore();
  const email = "recovered@example.com";
  const live = { email, accessToken: liveToken() };
  const past = new Date(Date.now() - 3600_000).toISOString();
  await recordQuotaCheck({ email, quota: 0, restoreAt: past }, { statsStore: store });
  assert.equal(store.state.accounts[accountSlotTag(email)].imageQuota, 0);

  let seen = null;
  const results = await refreshExpiredQuotas([live], store.state, {
    statsStore: store,
    probedAt: new Map(),
    probe: async (acct, opts) => {
      seen = opts;
      await recordQuotaCheck({ email: acct.email, quota: 25 }, { statsStore: store });
      return { ok: true, imageQuota: 25 };
    },
  });

  assert.equal(seen.reauthenticate, null, "背景复检绝不触发重新登录（MFA 风险）");
  assert.equal(seen.silent, true, "失败不写 quotaError");
  assert.equal(results.length, 1);
  assert.equal(store.state.accounts[accountSlotTag(email)].imageQuota, 25);
  assert.equal(store.state.accounts[accountSlotTag(email)].limitedUntil, null);

  const order = selectPoolOrder({ accounts: [live], stats: store.state });
  assert.equal(order[0].email, email, "额度恢复后重新回到可用队列");
});

// 重置时间过后查了一次还是 401（token 被上游废掉），就不能每十分钟再问一遍 ——
// 那种号要人工重新导入，反复探测只是白起 Python 进程。
test("an account already checked after its reset time and still failing is left alone", () => {
  const live = { email: "stuck@example.com", accessToken: liveToken() };
  const resetAt = new Date(Date.now() - 6 * 3600_000).toISOString();
  const checkedAfter = new Date(Date.now() - 5 * 3600_000).toISOString();

  const failedAfterReset = statsWith({
    [live.email]: {
      imageQuota: 0, restoreAt: resetAt, quotaCheckedAt: checkedAfter,
      quotaError: "网页鉴权 401（Token 无 chatgpt.com 网页权限或已失效）",
    },
  });
  assert.equal(
    accountsNeedingQuotaRefresh([live], failedAfterReset, { probedAt: new Map() }).length, 0,
    "already asked once since the reset; a human has to re-import the credentials",
  );

  // 还没查过（quotaError 为空）→ 正常去问
  const neverChecked = statsWith({
    [live.email]: { imageQuota: 0, restoreAt: resetAt, quotaCheckedAt: null },
  });
  assert.equal(accountsNeedingQuotaRefresh([live], neverChecked, { probedAt: new Map() }).length, 1);

  // 查是查过，但在重置时间之前 → 说明那是上一轮的旧结果，现在该重新问了
  const checkedBeforeReset = statsWith({
    [live.email]: {
      imageQuota: 0, restoreAt: resetAt,
      quotaCheckedAt: new Date(Date.now() - 30 * 3600_000).toISOString(),
      quotaError: "查询生图额度超时",
    },
  });
  assert.equal(accountsNeedingQuotaRefresh([live], checkedBeforeReset, { probedAt: new Map() }).length, 1);
});

// 文本和生图是两条独立的上游能力：一个号出不了图，不代表它答不了话。
// 但「重新登录都过不去」的号，文本也一样废，得排掉。
test("text selection drops only login-dead accounts, not image-broken ones", () => {
  const authDead = account("authdead@example.com");
  const neverWorked = account("neverworked@example.com");
  const healthy = account("healthy@example.com");
  const stats = statsWith({
    [authDead.email]: {
      imageQuota: 25, successCalls: 1, failCalls: 3,
      authFails: AUTH_FAIL_LIMIT, deadAt: new Date().toISOString(),
    },
    [neverWorked.email]: { imageQuota: 25, successCalls: 0, failCalls: 60 },
    [healthy.email]: { imageQuota: 25, successCalls: 4, failCalls: 0 },
  });

  const kept = textPoolAccounts([authDead, neverWorked, healthy], stats).map((a) => a.email);
  assert.deepEqual(kept, [neverWorked.email, healthy.email],
    "一个从没出过图的号，文本照样要试");

  assert.equal(textPoolAccounts([authDead], null).length, 1, "没有统计时原样返回");
  assert.equal(textPoolAccounts([authDead], stats).length, 1, "全被判死时退回原列表，别直接报空池");
});

test("a caller can keep its own rotation ledger so text traffic does not skew image weights", () => {
  const a = account("ledger-a@example.com");
  const b = account("ledger-b@example.com");
  const stats = statsWith({
    [a.email]: { imageQuota: 25 },
    [b.email]: { imageQuota: 25 },
  });

  // 每次给一份新账本 → 起点相同
  const first = selectPoolOrder({ accounts: [a, b], stats, credit: new Map() }).map((x) => x.email);
  const again = selectPoolOrder({ accounts: [a, b], stats, credit: new Map() }).map((x) => x.email);
  assert.deepEqual(first, again);

  // 共用一份账本 → 两轮之间轮转
  const shared = new Map();
  const r1 = selectPoolOrder({ accounts: [a, b], stats, credit: shared }).map((x) => x.email);
  const r2 = selectPoolOrder({ accounts: [a, b], stats, credit: shared }).map((x) => x.email);
  assert.notDeepEqual(r1, r2, "同一份账本会轮转");
});

// 统计页需要「今天成功多少、失败多少、失败都是因为什么」。
test("daily history and failure reasons are aggregated for the stats view", async () => {
  const store = createInMemoryStatsStore();
  const email = "hist@example.com";
  await recordImageCall({ email, success: true, count: 1 }, { statsStore: store });
  await recordImageCall({ email, success: false, error: "request_timeout" }, { statsStore: store });
  await recordImageCall({ email, success: false, error: "request_timeout" }, { statsStore: store });
  await recordImageCall({ email, success: false, error: "mfa_verify_failed_403" }, { statsStore: store });

  const snap = summarizePoolStats(
    [{ email, password: "p", totp: "s", accessToken: "t" }],
    store.state,
  );
  assert.equal(snap.today.success, 1);
  assert.equal(snap.today.fail, 3);
  assert.equal(snap.last7.success, 1);
  assert.equal(snap.last7.fail, 3);
  assert.deepEqual(snap.failBreakdown, { request_timeout: 2, mfa_verify_failed_403: 1 });
  assert.equal(snap.history.length, 1, "只记了今天这一天");
  assert.equal(snap.history[0].fail, 3);
  assert.equal(snap.history[0].success, 1);
});

test("dead accounts are grouped by reason so the GUI can offer per-group actions", () => {
  const authDead = account("group-auth@example.com");
  const neverDead = account("group-never@example.com");
  const stats = statsWith({
    [authDead.email]: {
      imageQuota: 25, successCalls: 1, failCalls: 1,
      authFails: AUTH_FAIL_LIMIT, deadAt: new Date().toISOString(),
    },
    [neverDead.email]: { imageQuota: 25, successCalls: 0, failCalls: 40 },
  });
  const snap = summarizePoolStats([authDead, neverDead], stats);
  assert.equal(snap.quotaStats.dead, 2);
  assert.deepEqual(snap.deadBreakdown, { auth: 1, never: 1, stale: 0, marked: 0 });
});

// 「什么时候限流、什么时候恢复、限了多久、一共几次」—— 界面要能直接说清楚。
test("a limit round records when it started, how long it lasted and when it recovered", async () => {
  const store = createInMemoryStatsStore();
  const email = "limit@example.com";
  const tag = accountSlotTag(email);
  const resetAt = new Date(Date.now() + 3600_000).toISOString();

  await recordQuotaCheck({ email, quota: 0, restoreAt: resetAt }, { statsStore: store });
  assert.ok(store.state.accounts[tag].limitedAt, "限流开始时间被记下");
  assert.equal(store.state.accounts[tag].limitCount, 1);

  // 还是 0：同一轮，不重复计数
  await recordQuotaCheck({ email, quota: 0 }, { statsStore: store });
  assert.equal(store.state.accounts[tag].limitCount, 1);

  // 额度回来了 = 恢复
  await recordQuotaCheck({ email, quota: 25 }, { statsStore: store });
  const recovered = store.state.accounts[tag];
  assert.equal(recovered.limitedAt, null);
  assert.ok(recovered.lastLimitedAt, "上一轮开始时间保留");
  assert.ok(recovered.recoveredAt, "恢复时间被记下");

  // 用光额度 = 又一轮限流
  await recordQuotaCheck({ email, quota: 1 }, { statsStore: store });
  await recordImageCall({ email, success: true, count: 1 }, { statsStore: store });
  assert.ok(store.state.accounts[tag].limitedAt);
  assert.equal(store.state.accounts[tag].limitCount, 2);

  const snap = summarizePoolStats(
    [{ email, password: "p", totp: "s", accessToken: "t" }],
    store.state,
  );
  assert.equal(snap.accounts[0].limitCount, 2);
  assert.ok(snap.accounts[0].limitedForMs >= 0);
});

test("an upstream rate limit starts a round even when the quota snapshot said otherwise", async () => {
  const store = createInMemoryStatsStore();
  const email = "rl@example.com";
  const tag = accountSlotTag(email);
  await recordImageCall({
    email, success: false, error: "quota_exhausted", rateLimited: true, retryAfter: 3600,
  }, { statsStore: store });
  assert.ok(store.state.accounts[tag].limitedAt);
  assert.equal(store.state.accounts[tag].limitCount, 1);
  assert.equal(store.state.accounts[tag].imageQuota, 0);
});
