import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BATCH_RECENCY_BONUS,
  CLEAN_ACCOUNT_BONUS,
  accountWeight,
  deriveTextQuota,
  poolMedianTtfb,
  tierAffectsWeight,
  tierOf,
} from "../lib/pool-weight.mjs";
import {
  DEFAULT_POOL_POLICY,
  readPoolPolicy,
  writePoolPolicy,
} from "../lib/pool-policy.mjs";
import { accountSlotTag } from "../lib/pool-connection.mjs";
import { newBatchId } from "../lib/batch-registry.mjs";

const email = "w@example.com";
const tag = accountSlotTag(email);
const account = (extra = {}) => ({ email, password: "p", totp: "s", accessToken: "t", ...extra });
const statsOf = (rec) => ({ totals: {}, accounts: { [tag]: rec } });
const weigh = (rec, options = {}) => accountWeight(account(), statsOf(rec), {
  policy: DEFAULT_POOL_POLICY,
  ...options,
});

/**
 * 0.10.x 的权重公式，逐行抄自当时的 codex-pool.mjs。
 * 它是 0.11.0 等价性测试的「参考答案」—— 不引用新代码，才能真的当门禁用。
 */
function legacyWeight(rec) {
  const quota = rec ? rec.imageQuota : null;
  const base = typeof quota === "number" && quota > 0 ? quota : quota === 0 ? 0.05 : 1;
  const neverWorked = (rec?.successCalls || 0) === 0 && (rec?.failCalls || 0) >= 5;
  const streak = (rec?.consecutiveFails || 0) + (neverWorked ? 2 : 0);
  const weight = Math.max(0.05, base / (1 + 2 * streak));
  const clean = (rec?.successCalls || 0) > 0 && (rec?.consecutiveFails || 0) === 0;
  return clean ? weight * CLEAN_ACCOUNT_BONUS : weight;
}

// ---------- 铁律：默认策略必须和 0.10.x 逐位一致 ----------

test("default policy reproduces the 0.10.x weight bit for bit", () => {
  const cases = [
    // 干净号：出过图、连续失败 0
    { imageQuota: 20, successCalls: 10, failCalls: 2, consecutiveFails: 0 },
    // 正在失败：连续失败 2
    { imageQuota: 25, successCalls: 3, failCalls: 9, consecutiveFails: 2 },
    // 从未成功但失败很多：neverWorked 额外 +2
    { imageQuota: 12, successCalls: 0, failCalls: 7, consecutiveFails: 1 },
    // 额度打空
    { imageQuota: 0, successCalls: 4, failCalls: 1, consecutiveFails: 0 },
    // 额度未知（从没检测过）
    { imageQuota: null, successCalls: 0, failCalls: 0, consecutiveFails: 0 },
    // 没有账本记录
    null,
    // 连续失败很多，权重已经压到下限
    { imageQuota: 3, successCalls: 1, failCalls: 30, consecutiveFails: 12 },
  ];
  for (const rec of cases) {
    const expected = legacyWeight(rec);
    const actual = weigh(rec);
    assert.equal(actual, expected, `record ${JSON.stringify(rec)}`);
  }
});

test("observation fields alone never change the weight while their switches are off", () => {
  const rec = {
    imageQuota: 20,
    successCalls: 10,
    failCalls: 2,
    consecutiveFails: 0,
    // 这些字段只有对应开关打开时才该起作用
    ewmaSuccess: 0.1,
    ttfbP50Ms: 9000,
    imageSamples: 40,
    hangStreak: 5,
    weightMul: 3,
    tier: "C",
    tierSource: "manual",
  };
  // weightMul 和手工 tier 是**显式设置**，不是开关，所以它们会生效。
  const withManual = weigh(rec);
  const withoutManual = weigh({ ...rec, weightMul: null, tier: null, tierSource: null });
  // 手工 C 级 ×0.6 顶掉了 CLEAN 的 ×1.5，所以比值是 (3×0.6)/1.5，不是 3×0.6。
  assert.equal(withManual / withoutManual, (3 * 0.6) / CLEAN_ACCOUNT_BONUS, "手工倍率 ×3 与手工 C 级 ×0.6 都要生效");

  // 去掉手工设置后，剩下的全是「开关关着就不该起作用」的观测字段。
  const plain = weigh({
    imageQuota: 20, successCalls: 10, failCalls: 2, consecutiveFails: 0,
    ewmaSuccess: 0.1, ttfbP50Ms: 9000, imageSamples: 40, hangStreak: 5,
  });
  assert.equal(plain, legacyWeight({ imageQuota: 20, successCalls: 10, failCalls: 2, consecutiveFails: 0 }));
});

// ---------- 分级 ----------

test("tier is inferred from slow-moving signals, never from the failure streak", () => {
  const base = { imageQuota: 20, successCalls: 10, consecutiveFails: 0 };
  // 成功够多、成功率够高、首字节不快于中位 → 不够 S，是 A
  assert.equal(tierOf(account(), { ...base, ewmaSuccess: 0.9, imageSamples: 5, ttfbP50Ms: 4000 }, {
    poolMedianTtfbMs: 3000,
  }).tier, "A");
  // 首字节 ≤ 中位 → S
  assert.equal(tierOf(account(), { ...base, ewmaSuccess: 0.9, imageSamples: 5, ttfbP50Ms: 2500 }, {
    poolMedianTtfbMs: 3000,
  }).tier, "S");
  // 成功率掉到 0.4 以下 → C
  assert.equal(tierOf(account(), { ...base, ewmaSuccess: 0.2, imageSamples: 5 }, {}).tier, "C");
  // 从未成功 → B
  assert.equal(tierOf(account(), { imageQuota: 5, successCalls: 0 }, {}).tier, "B");
  // 连续失败不影响分级（已经在 base 里罚过）
  assert.equal(tierOf(account(), { ...base, consecutiveFails: 9, ewmaSuccess: 0.9, imageSamples: 5 }, {
    poolMedianTtfbMs: 3000,
  }).tier, "A");
});

test("a manual tier always wins, and an auto tier only counts when the switch is on", () => {
  const manual = { imageQuota: 20, successCalls: 10, tier: "S", tierSource: "manual" };
  const auto = { imageQuota: 20, successCalls: 10, consecutiveFails: 0, ewmaSuccess: 0.9, imageSamples: 5 };

  // 手工 S：生效，且 CLEAN 加成不再叠加（否则等于加成两次）
  const manualWeight = weigh(manual);
  assert.equal(manualWeight, (20 / 1) * DEFAULT_POOL_POLICY.tierWeights.S);

  // 自动 S：默认只展示，权重和 A 一样（干净号加成还在）
  assert.equal(tierOf(account(), auto, { policy: DEFAULT_POOL_POLICY }).source, "auto");
  assert.equal(tierAffectsWeight("S", "auto", DEFAULT_POOL_POLICY), false);
  assert.equal(weigh(auto), 20 * CLEAN_ACCOUNT_BONUS);

  // 打开开关后自动 S 生效，CLEAN 退位
  const on = { ...DEFAULT_POOL_POLICY, tierAutoWeight: true };
  assert.equal(tierAffectsWeight("S", "auto", on), true);
  assert.equal(weigh(auto, { policy: on }), 20 * DEFAULT_POOL_POLICY.tierWeights.S);
});

test("tier and the clean bonus are mutually exclusive, never multiplicative", () => {
  const clean = { imageQuota: 20, successCalls: 10, consecutiveFails: 0, tier: "A", tierSource: "manual" };
  // A 的权重是 1，所以「tier 生效 + 不叠 CLEAN」= 20；如果叠加会是 30。
  assert.equal(weigh(clean), 20);
});

// ---------- 文本模式 ----------

test("text mode reads only text quota, and null text quota means equal weight", () => {
  const plain = { imageQuota: 0, textQuota: null, textConsecutiveFails: 0 };
  // 图片额度 0、文本额度未知 → 等权 1（和 0.10.x 的文本链路一样）
  assert.equal(weigh(plain, { mode: "text" }), 1);

  // 文本额度 30 vs 10 → 3:1
  const rich = weigh({ imageQuota: 0, textQuota: 30 }, { mode: "text" });
  const poor = weigh({ imageQuota: 40, textQuota: 10 }, { mode: "text" });
  assert.equal(rich, 30);
  assert.equal(poor, 10, "图片额度再高也不影响文本权重");

  // 文本自己的连续失败才降权
  assert.equal(weigh({ textQuota: 10, textConsecutiveFails: 2 }, { mode: "text" }), 10 / 5);
  // 图片的连续失败不该影响文本
  assert.equal(weigh({ textQuota: 10, consecutiveFails: 9 }, { mode: "text" }), 10);
});

test("image mode ignores text quota entirely", () => {
  const rec = { imageQuota: 12, textQuota: 99 };
  assert.equal(weigh(rec), legacyWeight(rec));
});

// ---------- 其他乘子 ----------

test("ewma, latency and hang factors only act when their switch is on and samples suffice", () => {
  const rec = { imageQuota: 20, successCalls: 5, consecutiveFails: 0, ewmaSuccess: 0.5, imageSamples: 10, ttfbP50Ms: 4000, hangStreak: 2 };
  const base = weigh(rec);

  const ewmaOn = { ...DEFAULT_POOL_POLICY, ewmaWeightEnabled: true };
  assert.equal(weigh(rec, { policy: ewmaOn }), base * (0.6 + 0.8 * 0.5));

  const latencyOn = { ...DEFAULT_POOL_POLICY, latencyWeightEnabled: true };
  assert.equal(weigh(rec, { policy: latencyOn, poolMedianTtfbMs: 2000 }), base * 0.6,
    "比中位慢一倍 → 压到下限 0.6");

  const hangOn = { ...DEFAULT_POOL_POLICY, hangWeightEnabled: true };
  assert.equal(weigh(rec, { policy: hangOn }), base * 0.5);

  // 样本不足时 EWMA / 延迟都不生效
  const few = { ...rec, imageSamples: 1 };
  assert.equal(weigh(few, { policy: ewmaOn }), weigh({ ...few, ewmaSuccess: 0.5 }));
  assert.equal(weigh(few, { policy: latencyOn, poolMedianTtfbMs: 2000 }), base);
});

test("poolMedianTtfb takes the median of the accounts that have samples", () => {
  const a = { email: "a@x.com" };
  const b = { email: "b@x.com" };
  const c = { email: "c@x.com" };
  const stats = {
    accounts: {
      [accountSlotTag(a.email)]: { ttfbP50Ms: 1000 },
      [accountSlotTag(b.email)]: { ttfbP50Ms: 3000 },
      [accountSlotTag(c.email)]: { ttfbP50Ms: 2000 },
    },
  };
  assert.equal(poolMedianTtfb([a, b, c], stats), 2000);
  assert.equal(poolMedianTtfb([a], { accounts: {} }), null);
  assert.equal(poolMedianTtfb(null, null), null);
});

test("a saturated account is down-weighted but never zeroed out", () => {
  const rec = { imageQuota: 20, successCalls: 10, consecutiveFails: 0 };
  const base = weigh(rec);
  assert.equal(weigh(rec, { inflightOf: () => 1, perAccountInflight: 1 }), base * 0.2);
  assert.equal(weigh(rec, { inflightOf: () => 0, perAccountInflight: 1 }), base);
  // 上限 0 / 不传 = 不限制，权重必须逐位回到原值
  assert.equal(weigh(rec, { inflightOf: () => 9, perAccountInflight: 0 }), base);
  assert.equal(weigh(rec, { inflightOf: () => 9 }), base);
});

test("batch recency still stacks on top of everything else", () => {
  const older = newBatchId(Date.UTC(2026, 0, 1));
  const newer = newBatchId(Date.UTC(2026, 10, 1));
  const rec = { imageQuota: 20, successCalls: 10, consecutiveFails: 0 };
  const ranks = new Map([[newer, 0], [older, 1]]);
  const newerWeight = accountWeight(account({ batchId: newer }), statsOf(rec), {
    policy: DEFAULT_POOL_POLICY, batchRanks: ranks,
  });
  assert.equal(newerWeight, legacyWeight(rec) * BATCH_RECENCY_BONUS[0]);
});

// ---------- 文本额度派生 ----------

test("text quota is derived only from the features the policy names", () => {
  const limits = [
    { feature: "image_gen", remaining: 7 },
    { feature: "reason", remaining: 16, resetAt: "2026-11-19T00:00:00.000Z" },
    { feature: "deep_research", remaining: 5 },
  ];
  // 没配 feature：不派生，返回 null（不是 0）
  assert.equal(deriveTextQuota(limits, []), null);
  assert.equal(deriveTextQuota(limits, null), null);

  assert.deepEqual(deriveTextQuota(limits, ["reason"]), {
    textQuota: 16,
    textHasLimit: true,
    textRestoreAt: "2026-11-19T00:00:00.000Z",
  });
  // 配了多个就求和
  assert.equal(deriveTextQuota(limits, ["reason", "deep_research"]).textQuota, 21);
  // 配了但上游没返回这个 feature → null，保留旧值
  assert.equal(deriveTextQuota(limits, ["text_gen"]), null);
  assert.equal(deriveTextQuota([], ["reason"]), null);
  // 大小写和脏数据不影响
  assert.equal(deriveTextQuota([{ feature: "REASON", remaining: "4" }], ["reason"]).textQuota, 4);
  assert.equal(deriveTextQuota([{ feature: "reason", remaining: "abc" }], ["reason"]), null);
});

// ---------- 策略读写 ----------

test("policy defaults are inert, and unknown fields are dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-policy-"));
  const previous = process.env.MAGPIE_GPTFREE_HOME;
  process.env.MAGPIE_GPTFREE_HOME = dir;
  try {
    const { policy, source } = await readPoolPolicy();
    assert.equal(source, "default");
    assert.equal(policy.tierAutoWeight, false);
    assert.equal(policy.ewmaWeightEnabled, false);
    assert.equal(policy.latencyWeightEnabled, false);
    assert.equal(policy.hangWeightEnabled, false);
    assert.equal(policy.exploreWhileProgressing, false, "默认不为探索复制一个会成功的请求");
    assert.equal(policy.imageAttemptTimeoutMs, 55_000);
    assert.equal(policy.imageSlowModels["gpt-image-2.6"], 75_000);
    assert.deepEqual(policy.textQuotaFeatures, []);
    assert.deepEqual(policy.tierWeights, { S: 1.15, A: 1, B: 0.85, C: 0.6 });

    const saved = await writePoolPolicy({
      tierAutoWeight: true,
      textQuotaFeatures: ["reason", "reason", "BAD FEATURE!"],
      tierWeights: { S: 2, C: 99 },
      nonsense: "should be dropped",
    });
    assert.equal(saved.tierAutoWeight, true);
    assert.deepEqual(saved.textQuotaFeatures, ["reason"], "去重 + 非法名丢掉");
    assert.equal(saved.tierWeights.S, 2);
    assert.equal(saved.tierWeights.C, 5, "权重倍率夹到上限");
    assert.equal(saved.nonsense, undefined);

    const again = await readPoolPolicy();
    assert.equal(again.source, "settings");
    assert.equal(again.policy.tierAutoWeight, true);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_GPTFREE_HOME;
    else process.env.MAGPIE_GPTFREE_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

// 按模型给预算：gpt-image-2.6 实测正常 21–37 秒、尾部超 55 秒，
// 用默认的 55 秒会把「慢」误判成「卡死」。
test("heavy models get their own attempt budget", async () => {
  const { resolveImageAttemptTimeout } = await import("../lib/pool-policy.mjs");
  const policy = DEFAULT_POOL_POLICY;
  assert.equal(resolveImageAttemptTimeout(policy, "gpt-image-2"), 55_000);
  assert.equal(resolveImageAttemptTimeout(policy, "gpt-image-2.6"), 75_000);
  assert.equal(resolveImageAttemptTimeout(policy, "gpt-image-2.6-flare"), 75_000);
  // 没见过的模型退回默认，不会因为查不到表就拿到 0
  assert.equal(resolveImageAttemptTimeout(policy, "gpt-image-9"), 55_000);
  assert.equal(resolveImageAttemptTimeout(policy, ""), 55_000);
  assert.equal(resolveImageAttemptTimeout(null, "gpt-image-2.6"), 55_000);

  // 表里塞垃圾：非法模型名 / 越界值都要被丢掉，而不是让所有模型都变慢
  const saved = await writePoolPolicy({
    imageSlowModels: { "gpt-image-2.6": 999_999, "BAD MODEL": 75_000, "gpt-image-2": 20_000 },
  });
  assert.equal(saved.imageSlowModels["gpt-image-2.6"], 180_000, "夹到上限");
  assert.equal(saved.imageSlowModels["BAD MODEL"], undefined);
  assert.equal(saved.imageSlowModels["gpt-image-2"], 20_000, "也可以把某个模型调快");
  assert.equal(resolveImageAttemptTimeout(saved, "gpt-image-2"), 20_000);
});

// 按模型给预算：gpt-image-2.6 实测正常 21–37 秒、尾部超 55 秒，
// 用默认的 55 秒会把「慢」误判成「卡死」。
test("heavy models get their own attempt budget", async () => {
  const { resolveImageAttemptTimeout } = await import("../lib/pool-policy.mjs");
  const policy = DEFAULT_POOL_POLICY;
  assert.equal(resolveImageAttemptTimeout(policy, "gpt-image-2"), 55_000);
  assert.equal(resolveImageAttemptTimeout(policy, "gpt-image-2.6"), 75_000);
  assert.equal(resolveImageAttemptTimeout(policy, "gpt-image-2.6-flare"), 75_000);
  // 没见过的模型退回默认，不会因为查不到表就拿到 0
  assert.equal(resolveImageAttemptTimeout(policy, "gpt-image-9"), 55_000);
  assert.equal(resolveImageAttemptTimeout(policy, ""), 55_000);
  assert.equal(resolveImageAttemptTimeout(null, "gpt-image-2.6"), 55_000);

  // 表里塞垃圾：非法模型名 / 越界值都要被丢掉，而不是让所有模型都变慢
  const saved = await writePoolPolicy({
    imageSlowModels: { "gpt-image-2.6": 999_999, "BAD MODEL": 75_000, "gpt-image-2": 20_000 },
  });
  assert.equal(saved.imageSlowModels["gpt-image-2.6"], 180_000, "夹到上限");
  assert.equal(saved.imageSlowModels["BAD MODEL"], undefined);
  assert.equal(saved.imageSlowModels["gpt-image-2"], 20_000, "也可以把某个模型调快");
  assert.equal(resolveImageAttemptTimeout(saved, "gpt-image-2"), 20_000);
});

test("env overrides win over the file, for emergency rollback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-policy-env-"));
  const previousHome = process.env.MAGPIE_GPTFREE_HOME;
  const previousEnv = process.env.MAGPIE_GPTFREE_POLICY_EWMA;
  const previousFeatures = process.env.MAGPIE_GPTFREE_POLICY_TEXT_FEATURES;
  process.env.MAGPIE_GPTFREE_HOME = dir;
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      poolPolicy: { ewmaWeightEnabled: true, textQuotaFeatures: ["reason"] },
    }), "utf8");

    let { policy, source } = await readPoolPolicy();
    assert.equal(policy.ewmaWeightEnabled, true);
    assert.equal(source, "settings");

    process.env.MAGPIE_GPTFREE_POLICY_EWMA = "0";
    process.env.MAGPIE_GPTFREE_POLICY_TEXT_FEATURES = "deep_research";
    ({ policy, source } = await readPoolPolicy());
    assert.equal(source, "env");
    assert.equal(policy.ewmaWeightEnabled, false, "env 一条命令就能关掉乘子");
    assert.deepEqual(policy.textQuotaFeatures, ["deep_research"]);
  } finally {
    if (previousHome === undefined) delete process.env.MAGPIE_GPTFREE_HOME;
    else process.env.MAGPIE_GPTFREE_HOME = previousHome;
    if (previousEnv === undefined) delete process.env.MAGPIE_GPTFREE_POLICY_EWMA;
    else process.env.MAGPIE_GPTFREE_POLICY_EWMA = previousEnv;
    if (previousFeatures === undefined) delete process.env.MAGPIE_GPTFREE_POLICY_TEXT_FEATURES;
    else process.env.MAGPIE_GPTFREE_POLICY_TEXT_FEATURES = previousFeatures;
    await rm(dir, { recursive: true, force: true });
  }
});
