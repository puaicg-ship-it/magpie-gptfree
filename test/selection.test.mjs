import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  accountsNeedingQuotaRefresh,
  hedgeDelayForHead,
  refreshExpiredQuotas,
  selectPoolOrder,
  textPoolAccounts,
  unexploredAccounts,
} from "../lib/codex-pool.mjs";
import {
  AUTH_FAIL_LIMIT,
  accountDeadReason,
  createInMemoryStatsStore,
  failCooldownMs,
  hangCooldownMs,
  isAccountCoolingDown,
  isAccountDead,
  recordImageCall,
  recordQuotaCheck,
  recordTextCall,
  setAccountPolicy,
  summarizePoolStats,
} from "../lib/pool-stats.mjs";
import { accountSlotTag } from "../lib/pool-connection.mjs";
import { newBatchId } from "../lib/batch-registry.mjs";
import { DEFAULT_POOL_POLICY } from "../lib/pool-policy.mjs";

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

// ---------- 批次新鲜度权重（0.10.1） ----------

const batchOf = (ms) => newBatchId(ms);

function pickCounts(accounts, stats, rounds) {
  // 每次用一份新的轮转账本，避免和别的用例共用模块级 credit。
  const credit = new Map();
  const picks = Object.fromEntries(accounts.map((a) => [a.email, 0]));
  for (let i = 0; i < rounds; i++) {
    const [first] = selectPoolOrder({ accounts, stats, credit });
    picks[first.email] += 1;
  }
  return picks;
}

test("the newest batch gets a modest edge when quotas are otherwise equal", () => {
  const oldBatch = batchOf(Date.UTC(2026, 0, 1));
  const newBatch = batchOf(Date.UTC(2026, 10, 18));
  const a = { ...account("old-batch@example.com"), batchId: oldBatch };
  const b = { ...account("new-batch@example.com"), batchId: newBatch };
  const stats = statsWith({
    [a.email]: { imageQuota: 20, successCalls: 10, failCalls: 0 },
    [b.email]: { imageQuota: 20, successCalls: 10, failCalls: 0 },
  });

  // 两个批次时是 1.25 : 1.10（不是 1.25 : 1.0 —— 第 2 新的批次也有加成）。
  // 合计 47 次里应该 25:22。
  const picks = pickCounts([a, b], stats, 47);
  assert(Math.abs(picks[b.email] - 25) <= 1, `新批次 ${picks[b.email]} 次`);
  assert(Math.abs(picks[a.email] - 22) <= 1, `旧批次 ${picks[a.email]} 次`);
});

// 单号并发闸的「软」那一半：在飞已满的号在排序里被压到 0.2 倍权重。
// 硬的那一半（直接跳过）在 chatgpt-web-image 的 takeNext 里。
test("an account that is already busy sinks in the ordering", () => {
  const busy = account("busy@example.com");
  const idle = account("idle@example.com");
  const stats = statsWith({
    [busy.email]: { imageQuota: 20, successCalls: 10, failCalls: 0 },
    [idle.email]: { imageQuota: 20, successCalls: 10, failCalls: 0 },
  });
  // 额度相同，谁在飞谁靠后：45 次里空闲的那个应该拿到 25 次（1 : 0.2）。
  const credit = new Map();
  const picks = { [busy.email]: 0, [idle.email]: 0 };
  for (let i = 0; i < 36; i++) {
    const [first] = selectPoolOrder({
      accounts: [busy, idle],
      stats,
      credit,
      policy: { ...DEFAULT_POOL_POLICY, perAccountImageInflight: 1 },
      // 这里直接注入计数，不依赖全局 Map 的状态
      inflightOf: (a) => (a.email === busy.email ? 1 : 0),
    });
    picks[first.email] += 1;
  }
  assert(picks[idle.email] > picks[busy.email], `空闲 ${picks[idle.email]} vs 在飞 ${picks[busy.email]}`);
  assert(picks[idle.email] + picks[busy.email] === 36);
});

test("batch recency never overrides a large quota gap", () => {
  const oldBatch = batchOf(Date.UTC(2026, 0, 1));
  const newBatch = batchOf(Date.UTC(2026, 10, 18));
  // 老批次额度 40，新批次只剩 2：1.25 倍不足以把请求送进快空的号。
  const a = { ...account("rich-old@example.com"), batchId: oldBatch };
  const b = { ...account("empty-new@example.com"), batchId: newBatch };
  const stats = statsWith({
    [a.email]: { imageQuota: 40, successCalls: 10, failCalls: 0 },
    [b.email]: { imageQuota: 2, successCalls: 10, failCalls: 0 },
  });
  const picks = pickCounts([a, b], stats, 50);
  assert(picks[a.email] > picks[b.email] * 5, `额度仍然是主导：${picks[a.email]} vs ${picks[b.email]}`);
});

// 等价性：只有一个批次（老池子全是 legacy）时，加成必须完全不生效 ——
// 否则「升级后行为不变」这句话就不成立。
test("a single batch is a strict no-op for the rotation", () => {
  const only = batchOf(Date.UTC(2026, 10, 18));
  const stats = statsWith({
    "x-eq@example.com": { imageQuota: 20, successCalls: 4, failCalls: 0 },
    "y-eq@example.com": { imageQuota: 10, successCalls: 4, failCalls: 0 },
  });
  const withBatch = [
    { ...account("x-eq@example.com"), batchId: only },
    { ...account("y-eq@example.com"), batchId: only },
  ];
  const withoutBatch = [account("x-eq@example.com"), account("y-eq@example.com")];

  const run = (accounts) => {
    const credit = new Map();
    return Array.from({ length: 30 }, () => selectPoolOrder({ accounts, stats, credit })[0].email);
  };
  assert.deepEqual(run(withBatch), run(withoutBatch), "单批次时顺序必须逐位相同");
});

test("MAGPIE_GPTFREE_BATCH_RECENCY=0 turns the bonus off", () => {
  const previous = process.env.MAGPIE_GPTFREE_BATCH_RECENCY;
  process.env.MAGPIE_GPTFREE_BATCH_RECENCY = "0";
  try {
    const oldBatch = batchOf(Date.UTC(2026, 0, 1));
    const newBatch = batchOf(Date.UTC(2026, 10, 18));
    const a = { ...account("off-old@example.com"), batchId: oldBatch };
    const b = { ...account("off-new@example.com"), batchId: newBatch };
    const stats = statsWith({
      [a.email]: { imageQuota: 20, successCalls: 10, failCalls: 0 },
      [b.email]: { imageQuota: 20, successCalls: 10, failCalls: 0 },
    });
    const picks = pickCounts([a, b], stats, 40);
    assert.equal(picks[a.email], 20, "关掉之后必须回到 50:50");
    assert.equal(picks[b.email], 20);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_GPTFREE_BATCH_RECENCY;
    else process.env.MAGPIE_GPTFREE_BATCH_RECENCY = previous;
  }
});

test("bonus stops at the third newest batch instead of decaying forever", () => {
  // 月份递增 = 批次越来越新，所以 accounts[3] 是最新、accounts[0] 是最旧。
  const batches = [0, 1, 2, 3].map((i) => batchOf(Date.UTC(2026, i, 1)));
  const accounts = batches.map((id, i) => ({ ...account(`b${i}-rank@example.com`), batchId: id }));
  const stats = statsWith(Object.fromEntries(
    accounts.map((a) => [a.email, { imageQuota: 20, successCalls: 10, failCalls: 0 }]),
  ));
  // 权重 25:22:21:20（第 4 新的批次没有加成），合计 88 次。
  const picks = pickCounts(accounts, stats, 88);
  const newest = picks[accounts[3].email];
  const oldest = picks[accounts[0].email];
  assert(Math.abs(newest - 25) <= 1, `最新批次 ${newest} 次`);
  assert(Math.abs(oldest - 20) <= 1, `最老批次 ${oldest} 次`);
  assert(newest > oldest);
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

// 0.12.1：卡死改成按「连续卡死次数」升级的独立阶梯，不再「按两次失败计 + 固定 5 分钟」。
// 5 分钟太短：一个真卡死的号一小时能回来捣乱十几次，每次白烧掉整条 lane 的预算。
test("consecutive hangs escalate 0 → 30min → 2h, and a success resets them", async () => {
  const store = createInMemoryStatsStore();
  const email = "hang@example.com";
  const tag = accountSlotTag(email);
  const coolFor = () => {
    const until = Date.parse(store.state.accounts[tag].cooldownUntil || "");
    return Number.isFinite(until) ? Math.round((until - Date.now()) / 60_000) : 0;
  };

  // 第一次卡死：只记 streak，不隔离（可能只是上游抖一下）
  await recordImageCall({ email, success: false, error: "worker_hang" }, { statsStore: store });
  assert.equal(store.state.accounts[tag].hangStreak, 1);
  assert.equal(store.state.accounts[tag].cooldownUntil, null, "一次卡死不该直接隔离");
  assert.equal(isAccountCoolingDown(email, store.state), false);

  // 第二次连续卡死：30 分钟
  await recordImageCall({ email, success: false, error: "worker_hang" }, { statsStore: store });
  assert.equal(store.state.accounts[tag].hangStreak, 2);
  assert(Math.abs(coolFor() - 30) <= 1, `第二次应冷却 30 分钟，实际 ${coolFor()}`);
  assert.equal(isAccountCoolingDown(email, store.state), true);

  // 第三次：2 小时
  await recordImageCall({ email, success: false, error: "worker_hang" }, { statsStore: store });
  assert.equal(store.state.accounts[tag].hangStreak, 3);
  assert(Math.abs(coolFor() - 120) <= 1, `第三次应冷却 2 小时，实际 ${coolFor()}`);

  // 一次成功全部清零，冷却也解掉
  await recordImageCall({ email, success: true, ms: 12000 }, { statsStore: store });
  assert.equal(store.state.accounts[tag].hangStreak, 0);
  assert.equal(store.state.accounts[tag].cooldownUntil, null);
});

// 冷却只能延长不能缩短：否则 2 小时的卡死隔离会被后一次普通失败覆盖成 10 分钟。
test("a later ordinary failure never shortens an existing hang isolation", async () => {
  const store = createInMemoryStatsStore();
  const email = "hangkeep@example.com";
  const tag = accountSlotTag(email);
  for (let i = 0; i < 3; i++) {
    await recordImageCall({ email, success: false, error: "worker_hang" }, { statsStore: store });
  }
  const isolated = Date.parse(store.state.accounts[tag].cooldownUntil);
  assert.ok(isolated - Date.now() > 100 * 60_000, "先被隔离 2 小时");

  await recordImageCall({ email, success: false, error: "upstream_error" }, { statsStore: store });
  const after = Date.parse(store.state.accounts[tag].cooldownUntil);
  assert.ok(after >= isolated, "普通失败不能把隔离时间缩短");
});

test("the hang ladder is a pure function and caps out at two hours", () => {
  assert.equal(hangCooldownMs(0), 0);
  assert.equal(hangCooldownMs(1), 0);
  assert.equal(hangCooldownMs(2), 30 * 60 * 1000);
  assert.equal(hangCooldownMs(3), 2 * 60 * 60 * 1000);
  assert.equal(hangCooldownMs(9), 2 * 60 * 60 * 1000, "再多次也不会无限涨");
});

test("a single ordinary failure still does not cool the account down", async () => {
  const store = createInMemoryStatsStore();
  const email = "plain@example.com";
  await recordImageCall({ email, success: false, error: "upstream_error" }, { statsStore: store });
  assert.equal(isAccountCoolingDown(email, store.state), false);
  assert.equal(store.state.accounts[accountSlotTag(email)].consecutiveFails, 1,
    "普通失败只算一次（卡死不再按两次计）");
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

// 额度检测里也会整条授权链路失败（Token 过期 → 重新登录 → MFA 403）。
// 这类号再试还是这样，就该自己走到「已失效」，不用人工判断。
test("repeated auth failures during a quota check mark the account dead", async () => {
  const store = createInMemoryStatsStore();
  const email = "mfa@example.com";
  const tag = accountSlotTag(email);
  const error = "DSH HTTP 授权未完成（mfa_verify_failed_403）";

  await recordQuotaCheck({ email, error }, { statsStore: store });
  assert.equal(accountDeadReason(email, store.state), "", "一次失败还不能判死");
  assert.equal(store.state.accounts[tag].authFails, 1);

  await recordQuotaCheck({ email, error }, { statsStore: store });
  assert.equal(accountDeadReason(email, store.state), "auth");
  assert.equal(store.state.accounts[tag].quotaError, error);

  // 检测通过就复活，并把连续失败清零。
  await recordQuotaCheck({ email, quota: 3, hasImageLimit: true }, { statsStore: store });
  assert.equal(accountDeadReason(email, store.state), "");
  assert.equal(store.state.accounts[tag].authFails, 0);
  assert.equal(store.state.accounts[tag].deadAt, null);
});

test("network errors during a quota check never count as auth failures", async () => {
  const store = createInMemoryStatsStore();
  const email = "net@example.com";
  const tag = accountSlotTag(email);
  for (const error of ["connect ETIMEDOUT 104.18.32.47:443", "fetch failed", "代理不可用"]) {
    await recordQuotaCheck({ email, error }, { statsStore: store });
  }
  assert.equal(store.state.accounts[tag].authFails, 0);
  assert.equal(accountDeadReason(email, store.state), "");
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

test("a stale quota snapshot is re-probed even when it still shows quota left", () => {
  const live = { email: "stale-snapshot@example.com", accessToken: liveToken() };
  const fresh = new Date(Date.now() - 60_000).toISOString();
  const old = new Date(Date.now() - 7 * 3600_000).toISOString();
  const staleAfterMs = 6 * 3600_000;

  const justChecked = statsWith({ [live.email]: { imageQuota: 12, quotaCheckedAt: fresh } });
  assert.equal(
    accountsNeedingQuotaRefresh([live], justChecked, { probedAt: new Map(), staleAfterMs }).length, 0,
    "a fresh snapshot needs no probe",
  );

  const staleSnap = statsWith({ [live.email]: { imageQuota: 12, quotaCheckedAt: old } });
  assert.equal(
    accountsNeedingQuotaRefresh([live], staleSnap, { probedAt: new Map(), staleAfterMs }).length, 1,
    "an expired snapshot is re-probed even though it claims 12 left",
  );

  // 不传 staleAfterMs 时保持老行为：只要还有额度就不探。
  assert.equal(
    accountsNeedingQuotaRefresh([live], staleSnap, { probedAt: new Map() }).length, 0,
  );
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

// 上游有时候只说「额度用完了」，不给重置时间。以前 limitedUntil 留 null，
// 号靠 imageQuota=0 停住却不知道什么时候回来，只能等巡检重新问额度。
test("a rate limit with no reset time gets a one-hour cool-down", async () => {
  const store = createInMemoryStatsStore();
  const email = "rl-nonull@example.com";
  const tag = accountSlotTag(email);
  const before = Date.now();
  await recordImageCall({
    email, success: false, error: "upstream_quota_exceeded", rateLimited: true, retryAfter: null,
  }, { statsStore: store });
  const until = Date.parse(store.state.accounts[tag].limitedUntil);
  assert.ok(Number.isFinite(until), "limitedUntil must be set even without a reset window");
  const minutes = (until - before) / 60000;
  assert.ok(minutes > 55 && minutes < 65, "fallback cool-down is about an hour, got " + minutes);
  assert.equal(store.state.accounts[tag].imageQuota, 0);
});

test("an absurd reset window is clamped instead of parked for a month", async () => {
  const store = createInMemoryStatsStore();
  const email = "rl-clamp@example.com";
  const tag = accountSlotTag(email);
  const before = Date.now();
  await recordImageCall({
    email, success: false, error: "quota_exhausted", rateLimited: true, retryAfter: 30 * 86400,
  }, { statsStore: store });
  const days = (Date.parse(store.state.accounts[tag].limitedUntil) - before) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, "cool-down is clamped to 7 days, got " + days);
});

// 文本流量以前完全不计账，统计页只看得见生图。现在分开记，但绝不能混进
// successCalls/failCalls —— 那会让 never 判死规则认不出「画不了图的号」。
test("text calls are counted separately and never pollute the image counters", async () => {
  const store = createInMemoryStatsStore();
  const email = "text@example.com";
  const tag = accountSlotTag(email);

  await recordTextCall({ email, success: true }, { statsStore: store });
  await recordTextCall({ email, success: true }, { statsStore: store });
  await recordTextCall({ email, success: false, error: "rate_limited" }, { statsStore: store });

  const rec = store.state.accounts[tag];
  assert.equal(rec.textSuccessCalls, 2);
  assert.equal(rec.textFailCalls, 1);
  assert.equal(rec.textLastErrorCode, "rate_limited");
  assert.equal(rec.successCalls, 0, "生图计数不受文本影响");
  assert.equal(rec.failCalls, 0);
  assert.equal(store.state.totals.successCalls, 0);
  assert.equal(store.state.totals.textSuccessCalls, 2);
  assert.equal(store.state.totals.textFailCalls, 1);

  const snap = summarizePoolStats(
    [{ email, password: "p", totp: "s", accessToken: "t" }],
    store.state,
  );
  assert.equal(snap.today.textSuccess, 2);
  assert.equal(snap.today.textFail, 1);
  assert.equal(snap.today.success, 0, "文本不进生图的今日成功数");
  assert.deepEqual(snap.failBreakdown, {}, "文本失败原因不搅进生图的原因分布");
  assert.equal(snap.accounts[0].textSuccessCalls, 2);
});

// ---------- 0.10.0 观测字段（只记录与展示，不参与排序） ----------

// 上游 limits_progress 里除了 image_gen 还有别的 feature（文本、other_tool…），
// 以前只抠 image_gen 那一项，其余直接扔了。0.10.0 先把全量存下来，等 0.11.0
// 再决定怎么用 —— 所以这里只验证「存得住、存得干净」，不验证任何调度行为。
test("the full upstream limits_progress snapshot is persisted, cleaned and capped", async () => {
  const store = createInMemoryStatsStore();
  const email = "limits@example.com";
  const tag = accountSlotTag(email);

  await recordQuotaCheck({
    email,
    quota: 18,
    limits: [
      { feature: "image_gen", remaining: 18, resetAt: "2026-01-01T00:00:00.000Z" },
      { feature: "Text_Gen", remaining: 40 },
      // 下面这些都应该被丢掉：feature 非法、remaining 不是数字、不是对象。
      { feature: "bad feature!", remaining: 3 },
      { feature: "", remaining: 3 },
      { feature: "other_tool", remaining: "abc" },
      null,
      42,
    ],
  }, { statsStore: store });

  const rec = store.state.accounts[tag];
  assert.deepEqual(rec.limits.map((item) => item.feature), ["image_gen", "text_gen"],
    "feature 统一小写，非法项直接丢");
  assert.equal(rec.limits[0].remaining, 18);
  assert.equal(rec.limits[0].resetAt, "2026-01-01T00:00:00.000Z");
  assert.equal(rec.limits[1].resetAt, undefined);
  assert.equal(rec.quotaAtCheck, 18);

  // 只保留最近 12 项：上游返回多少都不该把账本撑大。
  await recordQuotaCheck({
    email,
    quota: 18,
    limits: Array.from({ length: 30 }, (_, i) => ({ feature: `f${i}`, remaining: i })),
  }, { statsStore: store });
  assert.equal(store.state.accounts[tag].limits.length, 12);

  // 不传 limits（比如上游没给）时保留上一次的快照，不要清空。
  await recordQuotaCheck({ email, quota: 18 }, { statsStore: store });
  assert.equal(store.state.accounts[tag].limits.length, 12);

  const snap = summarizePoolStats([account(email)], store.state);
  assert.equal(snap.accounts[0].limits.length, 12, "行数据里也要带上 limits");
  assert.equal(snap.accounts[0].quotaAtCheck, 18);
});

test("average latency and TTFB are smoothed per account without polluting failure counters", async () => {
  const store = createInMemoryStatsStore();
  const email = "latency@example.com";
  const tag = accountSlotTag(email);

  await recordImageCall({ email, success: true, ms: 20000, ttfbMs: 4000 }, { statsStore: store });
  assert.equal(store.state.accounts[tag].avgImageMs, 20000);
  assert.equal(store.state.accounts[tag].ttfbP50Ms, 4000);
  assert.equal(store.state.accounts[tag].imageSamples, 1);

  // EWMA 0.7/0.3：一次特别慢的样本不该把均值直接拉满。
  await recordImageCall({ email, success: true, ms: 60000, ttfbMs: 8000 }, { statsStore: store });
  assert.equal(store.state.accounts[tag].avgImageMs, 32000);
  assert.equal(store.state.accounts[tag].ttfbP50Ms, 5200);
  assert.equal(store.state.accounts[tag].imageSamples, 2);

  // 失败样本没有可比耗时，不能污染均值。
  await recordImageCall({ email, success: false, error: "worker_hang" }, { statsStore: store });
  assert.equal(store.state.accounts[tag].avgImageMs, 32000);
  assert.equal(store.state.accounts[tag].imageSamples, 2);

  const snap = summarizePoolStats([account(email)], store.state);
  assert.equal(snap.accounts[0].avgImageMs, 32000);
  assert.equal(snap.accounts[0].ttfbP50Ms, 5200);
});

test("a text rate limit records a cooldown that a later success clears", async () => {
  const store = createInMemoryStatsStore();
  const email = "textcool@example.com";
  const tag = accountSlotTag(email);

  await recordTextCall({
    email,
    success: false,
    error: "rate_limit_exceeded",
    rateLimited: true,
    retryAfter: 600,
  }, { statsStore: store });
  const limited = Date.parse(store.state.accounts[tag].textLimitedUntil || "");
  assert.ok(limited > Date.now() + 500_000, "retry_after 600 秒要落成约 10 分钟的冷却");
  assert.equal(store.state.accounts[tag].textConsecutiveFails, 1);

  let snap = summarizePoolStats([account(email)], store.state);
  assert.equal(snap.accounts[0].textStatus, "limited");
  assert.equal(snap.quotaStats.textLimited, 1);

  await recordTextCall({ email, success: true, ms: 1200 }, { statsStore: store });
  assert.equal(store.state.accounts[tag].textLimitedUntil, null, "成功要把冷却清掉");
  assert.equal(store.state.accounts[tag].textConsecutiveFails, 0);
  assert.equal(store.state.accounts[tag].avgTextMs, 1200);

  snap = summarizePoolStats([account(email)], store.state);
  assert.equal(snap.accounts[0].textStatus, "available");
  assert.equal(snap.quotaStats.textLimited, 0);
});

// 没写 retry_after 的 429 也要有冷却，否则下一轮会立刻再打一次。
test("a text rate limit without retry_after still gets the default cooldown", async () => {
  const store = createInMemoryStatsStore();
  const email = "textcool2@example.com";
  const tag = accountSlotTag(email);
  await recordTextCall(
    { email, success: false, error: "rate_limit_exceeded", rateLimited: true },
    { statsStore: store },
  );
  const limited = Date.parse(store.state.accounts[tag].textLimitedUntil || "");
  assert.ok(limited > Date.now(), "缺省也该有冷却");
  assert.ok(limited < Date.now() + 3_600_000, "缺省冷却不该超过一小时");
});

// 0.10.0 只观测：tier / 权重都还不存在，effectiveWeight 必须是 null，
// 否则 0.11.0 接权重时看不出「这个值到底有没有生效」。
test("the snapshot exposes observation fields without inventing a tier or a weight", async () => {
  const store = createInMemoryStatsStore();
  const email = "obs@example.com";
  await recordImageCall({ email, success: true, ms: 30000, ttfbMs: 5000 }, { statsStore: store });
  const snap = summarizePoolStats([account(email)], store.state);
  const row = snap.accounts[0];
  assert.equal(row.effectiveWeight, null, "有效权重由 gui-service 用 pool-weight 现算");
  // 0.11.0：row.tier 只放**手工设置**的分级；没设过就是 null，不在这里推断。
  assert.equal(row.tier, null, "没手工设过分级就不能编一个出来");
  assert.equal(row.tierSource, null);
  assert.equal(row.weightMul, null);
  assert.equal(row.burnRatePerHour, null, "没有额度检测快照就谈不上消耗速率");
  assert.equal(row.etaExhaustMs, null);
  assert.deepEqual(row.limits, []);
  // 文本额度默认不派生（textQuotaFeatures 为空），所以是 null 而不是 0。
  assert.equal(row.textQuota, null);
  assert.equal(snap.quotaStats.textActive, 0);
  assert.equal(snap.quotaStats.totalTextQuota, 0);
  assert.ok("textStatus" in row);
  assert.ok("utilization" in snap.quotaStats);
  assert.ok("tierDist" in snap.quotaStats);
});

// ---------- 0.11.0：分级 / 文本额度 / 快变量画像 ----------

test("manual tier and weight multiplier survive a write-then-read round trip", async () => {
  const store = createInMemoryStatsStore();
  const email = "policy@example.com";
  const tag = accountSlotTag(email);

  await setAccountPolicy(email, { tier: "S", weightMul: 2.5 }, { statsStore: store });
  let rec = store.state.accounts[tag];
  assert.equal(rec.tier, "S");
  assert.equal(rec.tierSource, "manual");
  assert.equal(rec.weightMul, 2.5);

  // 不传 tier 只改倍率：分级保持原样
  await setAccountPolicy(email, { weightMul: 0.5 }, { statsStore: store });
  rec = store.state.accounts[tag];
  assert.equal(rec.tier, "S");
  assert.equal(rec.weightMul, 0.5);

  // 传 null 才清回自动
  await setAccountPolicy(email, { tier: null }, { statsStore: store });
  rec = store.state.accounts[tag];
  assert.equal(rec.tier, null);
  assert.equal(rec.tierSource, null);

  // 非法值不接受
  await setAccountPolicy(email, { tier: "X", weightMul: -1 }, { statsStore: store });
  rec = store.state.accounts[tag];
  assert.equal(rec.tier, null);
  assert.equal(rec.weightMul, null);
});

test("ewma success rate and hang streak are tracked without touching the death rules", async () => {
  const store = createInMemoryStatsStore();
  const email = "ewma@example.com";
  const tag = accountSlotTag(email);

  await recordImageCall({ email, success: true, ms: 1000 }, { statsStore: store });
  assert.equal(store.state.accounts[tag].ewmaSuccess, 1, "首个成功样本直接是 1");

  await recordImageCall({ email, success: false, error: "worker_hang" }, { statsStore: store });
  assert.equal(store.state.accounts[tag].ewmaSuccess, 0.7, "0.3 alpha：1 → 0.7");
  assert.equal(store.state.accounts[tag].hangStreak, 1);

  await recordImageCall({ email, success: false, error: "worker_hang" }, { statsStore: store });
  assert.equal(store.state.accounts[tag].hangStreak, 2);
  assert.ok(store.state.accounts[tag].lastHangAt);

  // 普通失败既不增加也不清零卡死计数
  await recordImageCall({ email, success: false, error: "upstream_error" }, { statsStore: store });
  assert.equal(store.state.accounts[tag].hangStreak, 2);

  // 一次成功清零
  await recordImageCall({ email, success: true, ms: 1000 }, { statsStore: store });
  assert.equal(store.state.accounts[tag].hangStreak, 0);
  // 1 → 0.7 → 0.49 → 0.343（普通失败也算一次失败样本）→ 0.343*0.7+0.3 = 0.5401
  assert.equal(store.state.accounts[tag].ewmaSuccess, 0.54);
});

test("a text quota derived from limits is stored and survives a check without limits", async () => {
  const store = createInMemoryStatsStore();
  const email = "textquota@example.com";
  const tag = accountSlotTag(email);

  await recordQuotaCheck({
    email,
    quota: 9,
    limits: [{ feature: "reason", remaining: 16, resetAt: "2026-11-19T00:00:00.000Z" }],
    textQuota: 16,
    textHasLimit: true,
    textRestoreAt: "2026-11-19T00:00:00.000Z",
  }, { statsStore: store });
  assert.equal(store.state.accounts[tag].textQuota, 16);
  assert.equal(store.state.accounts[tag].textHasLimit, true);
  assert.ok(store.state.accounts[tag].textQuotaCheckedAt);

  // 上游这次没返回 limits（textQuota 传 null）→ 保留旧值，不能抹成 0
  await recordQuotaCheck({ email, quota: 8 }, { statsStore: store });
  assert.equal(store.state.accounts[tag].textQuota, 16, "没给新快照就保留旧的");
  assert.equal(store.state.accounts[tag].imageQuota, 8);

  const snap = summarizePoolStats([account(email)], store.state);
  assert.equal(snap.accounts[0].textQuota, 16);
  assert.equal(snap.quotaStats.textActive, 1);
  assert.equal(snap.quotaStats.totalTextQuota, 16);
});

// 文本链路以前完全不看账本，于是「图片额度 0、但有文本额度」的号在文本链路上
// 被当成权重 0.05 排到最后，等于白白浪费。这条用例钉住新行为。
test("text mode keeps an image-exhausted account usable when it still has text quota", () => {
  const rich = { email: "textrich@example.com", password: "p", totp: "s", accessToken: "t" };
  const imageOnly = { email: "imageonly@example.com", password: "p", totp: "s", accessToken: "t" };
  const stats = statsWith({
    [rich.email]: { imageQuota: 0, textQuota: 20, successCalls: 4, failCalls: 0 },
    [imageOnly.email]: { imageQuota: 30, textQuota: null, successCalls: 4, failCalls: 0 },
  });

  const imageOrder = selectPoolOrder({ accounts: [rich, imageOnly], stats, credit: new Map() });
  assert.equal(imageOrder[0].email, imageOnly.email, "生图链路当然优先有额度的号");

  const textOrder = selectPoolOrder({
    accounts: [rich, imageOnly], stats, mode: "text", credit: new Map(),
  });
  assert.equal(textOrder[0].email, rich.email, "文本链路按文本额度排，图片额度 0 不影响");
});

test("text mode buckets a text-limited account behind usable ones but never kills it", () => {
  const fresh = { email: "textfresh@example.com", password: "p", totp: "s", accessToken: "t" };
  const cooling = { email: "textcool@example.com", password: "p", totp: "s", accessToken: "t" };
  const stats = statsWith({
    [fresh.email]: { imageQuota: 0, textQuota: 5 },
    [cooling.email]: {
      imageQuota: 0,
      textQuota: 50,
      textLimitedUntil: new Date(Date.now() + 600_000).toISOString(),
    },
  });
  const order = selectPoolOrder({ accounts: [cooling, fresh], stats, mode: "text", credit: new Map() });
  assert.equal(order[0].email, fresh.email, "冷却中的号排到后面");
  assert.equal(order.length, 2, "但仍然留在队列里，不是判死");
});

test("text mode does not apply the image death rules", () => {
  const never = { email: "neverimg@example.com", password: "p", totp: "s", accessToken: "t" };
  const stats = statsWith({
    // 20 次失败、一次没成功 → 图片链路判 never 死
    [never.email]: { imageQuota: 5, successCalls: 0, failCalls: 20 },
  });
  const imageOrder = selectPoolOrder({ accounts: [never], stats, credit: new Map() });
  assert.equal(isAccountDead(never.email, stats), true);
  assert.equal(imageOrder.length, 1, "判死的号还在兜底队列里");
  // 文本链路：画不了图不代表答不了话，照样当可用号
  const textOrder = selectPoolOrder({ accounts: [never], stats, mode: "text", credit: new Map() });
  assert.equal(textOrder.length, 1);
});

// 一个只能答话、画不了图的号仍然该被判死：文本成功不能把它从 never 里捞出来。
test("a text-only account is still a dead image account", async () => {
  const store = createInMemoryStatsStore();
  const email = "chatonly@example.com";
  for (let i = 0; i < 20; i++) {
    await recordImageCall({ email, success: false, error: "request_timeout" }, { statsStore: store });
  }
  await recordTextCall({ email, success: true }, { statsStore: store });
  const snap = summarizePoolStats(
    [{ email, password: "p", totp: "s", accessToken: "t" }],
    store.state,
  );
  assert.equal(snap.accounts[0].deadReason, "never");
});

// 倒推出来的限流开始时间必须能被界面识别出来，否则「限流 8 小时」会被当成观测值。
test("an estimated limit start is flagged, and a real observation clears the flag", async () => {
  const store = createInMemoryStatsStore();
  const email = "est@example.com";
  const tag = accountSlotTag(email);
  const estimated = new Date(Date.now() - 6 * 3600_000).toISOString();

  store.state.accounts[tag] = {
    imageQuota: 0, limitedAt: estimated, limitCount: 1, limitedAtEstimated: true,
  };
  const before = summarizePoolStats(
    [{ email, password: "p", totp: "s", accessToken: "t" }],
    store.state,
  );
  assert.equal(before.accounts[0].limitedAtEstimated, true);

  // 额度回来了：这一轮结束，估计值不再挂着。
  await recordQuotaCheck({ email, quota: 25 }, { statsStore: store });
  assert.equal(store.state.accounts[tag].limitedAtEstimated, false);
  assert.equal(store.state.accounts[tag].lastLimitedAt, estimated);

  // 再次打到 0：这次是观测到的，不是估计的。
  await recordQuotaCheck({ email, quota: 0 }, { statsStore: store });
  assert.ok(store.state.accounts[tag].limitedAt);
  assert.equal(store.state.accounts[tag].limitedAtEstimated, false);
});

// 对冲起步延迟：头号有近期成功记录就晚点对冲（省额度），否则早点对冲（救命）。
// 线上 121 个号的池子里一半从没出过图，头号卡满 40 秒时第二路只剩 15 秒，
// 25 秒固定起步的对冲永远赢不了 —— 这条用例锁住这个行为。
test("hedge delay depends on whether the head account has a recent success", () => {
  const fresh = "hedge-fresh@example.com";
  const stale = "hedge-stale@example.com";
  const bare = "hedge-bare@example.com";
  const now = Date.parse("2026-11-17T12:00:00Z");
  const stats = {
    accounts: {
      [accountSlotTag(fresh)]: { lastSuccessAt: "2026-11-17T11:30:00Z" },
      [accountSlotTag(stale)]: { lastSuccessAt: "2026-11-15T11:30:00Z" },
    },
  };

  assert.equal(hedgeDelayForHead([account(fresh)], stats, { nowMs: now }), 30_000);
  assert.equal(hedgeDelayForHead([account(stale)], stats, { nowMs: now }), 12_000);
  assert.equal(hedgeDelayForHead([account(bare)], stats, { nowMs: now }), 12_000);
  // 没有账本、空池子都不能抛错，退回「不信任头号」的保守值。
  assert.equal(hedgeDelayForHead([account(bare)], null, { nowMs: now }), 12_000);
  assert.equal(hedgeDelayForHead([], stats, { nowMs: now }), 12_000);
});

// 未验证号：没成功过、也几乎没失败过、但额度探过。它们额度低（2~5），在额度加权
// 轮转里被额度 25 的号压到队尾，永远轮不到 —— 所以专门挑出来交给第二路去探。
test("unexplored accounts are the ones never dispatched but already quota-checked", () => {
  const worked = "u-worked@example.com";
  const failed = "u-failed@example.com";
  const fresh = "u-fresh@example.com";
  const noRecord = "u-norecord@example.com";
  const onceTimedOut = "u-once@example.com";
  const emptyQuota = "u-empty@example.com";
  const stats = {
    accounts: {
      [accountSlotTag(worked)]: { imageQuota: 20, successCalls: 3, failCalls: 1 },
      [accountSlotTag(failed)]: { imageQuota: 5, successCalls: 0, failCalls: 2 },
      // 巡检探过额度，但从没被派过活。
      [accountSlotTag(fresh)]: { imageQuota: 5, quotaCheckedAt: "2026-11-17T12:00:00Z" },
      // 只超时过一次：给第二次机会，否则「首次调用要预热」的号会被一次性判死。
      [accountSlotTag(onceTimedOut)]: { imageQuota: 4, successCalls: 0, failCalls: 1 },
      // 额度打空：探它纯属白烧一个 lane 的 40 秒。
      [accountSlotTag(emptyQuota)]: { imageQuota: 0, successCalls: 0, failCalls: 0 },
    },
  };
  const ordered = [worked, failed, fresh, noRecord, onceTimedOut, emptyQuota].map(account);
  assert.deepEqual(
    unexploredAccounts(ordered, stats).map((a) => a.email),
    [fresh, onceTimedOut],
  );
  // 没有账本时不能抛错，也不能瞎猜。
  assert.deepEqual(unexploredAccounts(ordered, null), []);
  assert.deepEqual(unexploredAccounts([], stats), []);
});

// 有探索任务时，对冲必须早起步（12 秒），否则第二路拿不到一次完整的单次预算，
// 探索就变成「预算不够」的假失败。头号再可信也一样。
test("a pending exploration forces the early hedge even when the head is proven", () => {
  const head = "u-head@example.com";
  const now = Date.parse("2026-11-17T12:00:00Z");
  const stats = { accounts: { [accountSlotTag(head)]: { lastSuccessAt: "2026-11-17T11:59:00Z" } } };
  assert.equal(hedgeDelayForHead([account(head)], stats, { nowMs: now }), 30_000);
  assert.equal(
    hedgeDelayForHead([account(head)], stats, { nowMs: now, hasExplore: true }),
    12_000,
  );
});

// 「有额度 + 近期没出过错」的号要优先：额度相近时，干净号（出过图、连续失败 0）
// 必须排在刚超时过的号前面。以前权重只看剩余额度，一个额度 25 刚超时两次的号
// 会压过额度 8、连续成功 4 次的号。
test("a clean account outranks an equally funded one that just failed", () => {
  const clean = "w-clean@example.com";
  const shaky = "w-shaky@example.com";
  const stats = {
    accounts: {
      [accountSlotTag(clean)]: { imageQuota: 10, successCalls: 3, failCalls: 2, consecutiveFails: 0 },
      [accountSlotTag(shaky)]: { imageQuota: 10, successCalls: 3, failCalls: 2, consecutiveFails: 1 },
    },
  };
  const order = selectPoolOrder({
    accounts: [account(shaky), account(clean)],
    stats,
    credit: new Map(),
  });
  assert.equal(order[0].email, clean);
  // 没成功过的号不算「干净」：加成本身不能让未验证号插队。
  const fresh = "w-fresh@example.com";
  const freshStats = {
    accounts: {
      [accountSlotTag(clean)]: { imageQuota: 10, successCalls: 3, consecutiveFails: 0 },
      [accountSlotTag(fresh)]: { imageQuota: 10, successCalls: 0, failCalls: 0, consecutiveFails: 0 },
    },
  };
  const order2 = selectPoolOrder({
    accounts: [account(fresh), account(clean)],
    stats: freshStats,
    credit: new Map(),
  });
  assert.equal(order2[0].email, clean);
});
