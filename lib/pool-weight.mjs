/**
 * 号池权重：把「下一个请求该用哪个号」这件事收成一个纯函数。
 *
 * 为什么单独一个文件：0.11.0 起权重有六个乘子（额度 / 分级 / 手工倍率 / EWMA 成功率 /
 * 首字节延迟 / 卡死 / 批次）。放在 `codex-pool.mjs` 里会和调度、熔断、HTTP 逻辑搅在
 * 一起，改一个乘子要看三百行上下文。这里只依赖 `accountSlotTag` 和 `batchIdOf`，
 * **不 import pool-stats**，避免 `pool-stats → codex-pool → pool-stats` 的循环。
 *
 * 铁律：默认策略下返回值必须和 0.10.x **逐位相等**。所有新乘子默认关闭，
 * `test/selection.test.mjs` 的等价性用例是这条铁律的门禁。
 *
 * ```
 * W = Q_eff/(1+2*streak) * G * M * R * L * H * B
 *   G = tier 生效 ? T(tier) : (干净号 ? 1.5 : 1)   // 二选一，不叠加
 *   M = 手工 weightMul（0.05–5）
 *   R = EWMA 成功率（0.6–1.4，样本 ≥ ewmaMinSamples）
 *   L = 首字节相对号池中位（0.6–1.4）
 *   H = 连续卡死（0.5）
 *   B = 批次新鲜度（1.25 / 1.10 / 1.05 / 1）
 *   I = 单号并发已满时 ×0.2（软降权；硬跳过在 chatgpt-web-image 的 takeNext）
 * ```
 */
import { accountSlotTag } from "./pool-connection.mjs";
import { batchIdOf } from "./batch-registry.mjs";
import { DEFAULT_POOL_POLICY, TIERS } from "./pool-policy.mjs";

/** 出过图、且当前连续失败为 0 的号，额度相近时排前面。tier 生效时不再乘这一项。 */
export const CLEAN_ACCOUNT_BONUS = 1.5;

/** 第 0 新（最近一次导入）的批次 ×1.25，第 1 新 ×1.10，第 2 新 ×1.05。 */
export const BATCH_RECENCY_BONUS = [1.25, 1.1, 1.05];

const MIN_WEIGHT = 0.05;
const MAX_WEIGHT_MUL = 5;
const RATE_FACTOR_RANGE = [0.6, 1.4];
const HANG_FACTOR = 0.5;
const HANG_WINDOW_MS = 24 * 3600_000;
/** 单号并发已满时的降权系数。不硬剔除 —— 池子小的时候剔除等于不出图。 */
const INFLIGHT_FACTOR = 0.2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 数字或 null。**必须挡掉 null / "" / undefined**：`Number(null)` 和 `Number("")`
 * 都是 0，不挡的话「额度未知」会被当成「额度 0」，权重从 1 掉到 0.05 —— 一个刚导入、
 * 还没检测过的号会被直接压到队尾。0.10.0 的 `cleanMs` 就踩过同一个坑。
 */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTier(value) {
  const tier = typeof value === "string" ? value.trim().toUpperCase() : "";
  return TIERS.includes(tier) ? tier : "";
}

/** 手工倍率：0.05–5，别的值当没设。 */
export function clampWeightMul(value) {
  const n = finiteOrNull(value);
  if (n === null || n <= 0) return 1;
  return clamp(n, MIN_WEIGHT, MAX_WEIGHT_MUL);
}

/**
 * 分级：手工设置的优先，否则按慢变量画像推断。
 *
 * 判据刻意**不含 streak**（连续失败已经在 `Q/(1+2*streak)` 里罚过一次了，再进 tier
 * 就是同一件事罚两遍），也**不含额度**（额度是 base 的主导项）。
 * 延迟用 TTFB 不用总耗时：实测成功的出图要 27–32 秒，几乎人人都「≤45 秒」，
 * 拿总耗时分级区分不出好坏；首字节是 1.2–4.5 秒，差异是数量级的。
 */
export function tierOf(account, rec, {
  policy = DEFAULT_POOL_POLICY,
  poolMedianTtfbMs = null,
  nowMs = Date.now(),
} = {}) {
  const manual = normalizeTier(rec?.tier);
  if (manual && rec?.tierSource === "manual") return { tier: manual, source: "manual" };

  const thresholds = policy.tierThresholds || DEFAULT_POOL_POLICY.tierThresholds;
  const samples = Number(rec?.imageSamples) || 0;
  const ewma = finiteOrNull(rec?.ewmaSuccess);
  const success = Number(rec?.successCalls) || 0;
  const hangs = Number(rec?.hangStreak) || 0;
  const lastHangMs = Date.parse(rec?.lastHangAt || "");
  const hangRecent = Number.isFinite(lastHangMs) && nowMs - lastHangMs < HANG_WINDOW_MS;

  if (ewma !== null && samples >= policy.ewmaMinSamples && ewma < thresholds.cEwma) {
    return { tier: "C", source: "auto" };
  }
  if (hangRecent && hangs >= thresholds.cHangs24h) return { tier: "C", source: "auto" };

  const ttfb = finiteOrNull(rec?.ttfbP50Ms);
  const fastEnough = poolMedianTtfbMs === null || (ttfb !== null && ttfb <= poolMedianTtfbMs);
  if (success >= thresholds.sSuccess && ewma !== null && ewma >= thresholds.sEwma && fastEnough) {
    return { tier: "S", source: "auto" };
  }
  if (success > 0) return { tier: "A", source: "auto" };
  return { tier: "B", source: "auto" };
}

/** 自动推断的 tier 只有显式打开 tierAutoWeight 才进权重；手工设置的永远生效。 */
export function tierAffectsWeight(tier, source, policy = DEFAULT_POOL_POLICY) {
  if (!normalizeTier(tier)) return false;
  if (source === "manual") return true;
  return source === "auto" && policy.tierAutoWeight === true;
}

function ewmaFactor(rec, policy, mode) {
  if (mode !== "image" || policy.ewmaWeightEnabled !== true) return 1;
  const samples = Number(rec?.imageSamples) || 0;
  const ewma = finiteOrNull(rec?.ewmaSuccess);
  if (ewma === null || samples < policy.ewmaMinSamples) return 1;
  return clamp(0.6 + 0.8 * ewma, ...RATE_FACTOR_RANGE);
}

function latencyFactor(rec, policy, mode, poolMedianTtfbMs) {
  if (mode !== "image" || policy.latencyWeightEnabled !== true) return 1;
  const samples = Number(rec?.imageSamples) || 0;
  const ttfb = finiteOrNull(rec?.ttfbP50Ms);
  const median = finiteOrNull(poolMedianTtfbMs);
  if (ttfb === null || ttfb <= 0 || median === null || median <= 0) return 1;
  if (samples < policy.ewmaMinSamples) return 1;
  return clamp(median / ttfb, ...RATE_FACTOR_RANGE);
}

function hangFactor(rec, policy, mode) {
  if (mode !== "image" || policy.hangWeightEnabled !== true) return 1;
  return (Number(rec?.hangStreak) || 0) >= 2 ? HANG_FACTOR : 1;
}

/**
 * 单号并发闸的「软」那一半：这个号已经有 `limit` 个 worker 在用了，降权到 0.2。
 *
 * 硬的那一半在 `chatgpt-web-image.mjs` 的 `takeNext()` 里（直接跳过满号）。
 * 两层都要有：只有软降权挡不住四条 lane 各自排序、第一名都挑同一个号；
 * 只有硬跳过则池子小时会直接没号可用。
 */
function inflightFactor(account, inflightOf, limit) {
  if (typeof inflightOf !== "function") return 1;
  const cap = Number(limit);
  if (!Number.isFinite(cap) || cap <= 0) return 1;
  const busy = Number(inflightOf(account)) || 0;
  return busy >= cap ? INFLIGHT_FACTOR : 1;
}

function batchBonus(account, batchRanks) {
  if (!batchRanks) return 1;
  const rank = batchRanks.get(batchIdOf(account));
  if (!Number.isInteger(rank) || rank >= BATCH_RECENCY_BONUS.length) return 1;
  return BATCH_RECENCY_BONUS[rank];
}

/**
 * 单个号的权重。`stats` 是账本原文（`{accounts:{tag:rec}}`），`rec` 由 `accountSlotTag` 查。
 *
 * `mode:"text"` 时：额度只看 `textQuota`（为 null 就是等权 1，和今天一样），
 * streak 只看 `textConsecutiveFails`，**不读图片额度和图片熔断** —— 这是
 * `codex-pool.mjs` 里「文本不要套图片状态」那条设计的延续。
 */
export function accountWeight(account, stats, {
  mode = "image",
  policy = DEFAULT_POOL_POLICY,
  batchRanks = null,
  poolMedianTtfbMs = null,
  nowMs = Date.now(),
  // 单号在飞计数（跨请求共享的 Map 查询函数）。不传就不限制。
  inflightOf = null,
  perAccountInflight = 0,
} = {}) {
  const tag = typeof account?.email === "string" ? accountSlotTag(account.email) : "";
  const rec = tag ? stats?.accounts?.[tag] : null;

  const quota = mode === "text" ? finiteOrNull(rec?.textQuota) : finiteOrNull(rec?.imageQuota);
  const base = quota === null ? 1 : quota > 0 ? quota : 0.05;

  // 「一次都没成功过、却失败过很多次」：额度快照还挂着旧值时，不必等它再失败三次才降权。
  // 这条只对图片有意义 —— 文本的成功/失败是另一组计数，混用会把「画不了图」的号
  // 在文本链路上也降权。
  const neverWorked = mode === "image"
    && (Number(rec?.successCalls) || 0) === 0
    && (Number(rec?.failCalls) || 0) >= 5;
  const streak = mode === "text"
    ? (Number(rec?.textConsecutiveFails) || 0)
    : (Number(rec?.consecutiveFails) || 0) + (neverWorked ? 2 : 0);
  const weight = Math.max(MIN_WEIGHT, base / (1 + 2 * streak));

  const { tier, source } = tierOf(account, rec, { policy, poolMedianTtfbMs, nowMs });
  const applied = tierAffectsWeight(tier, source, policy);
  const clean = mode === "image"
    && (Number(rec?.successCalls) || 0) > 0
    && (Number(rec?.consecutiveFails) || 0) === 0;
  const grade = applied
    ? (finiteOrNull(policy.tierWeights?.[tier]) ?? 1)
    : (clean ? CLEAN_ACCOUNT_BONUS : 1);

  return weight
    * grade
    * clampWeightMul(rec?.weightMul)
    * ewmaFactor(rec, policy, mode)
    * latencyFactor(rec, policy, mode, poolMedianTtfbMs)
    * hangFactor(rec, policy, mode)
    * batchBonus(account, batchRanks)
    * inflightFactor(account, inflightOf, perAccountInflight);
}

/**
 * 从上游 `limits` 里按 policy 指定的 feature 派生文本额度。
 *
 * 为什么必须由 policy 指定：上游返回的是 `reason / deep_research / file_upload /
 * paste_text_to_file / image_gen`，**没有 text_gen 也没有 other_tool**。
 * 「哪个算普通对话的额度」是业务判断，代码不替用户猜 —— 猜错的后果是把请求
 * 往「reason 还剩 50 次但普通对话早就打不动」的号上送。
 *
 * 配了但上游这次没返回对应 feature → 返回 null（保留旧值），不当成 0。
 */
export function deriveTextQuota(limits, features) {
  const list = Array.isArray(limits) ? limits : [];
  const wanted = (Array.isArray(features) ? features : [])
    .map((name) => String(name || "").trim().toLowerCase())
    .filter(Boolean);
  if (!list.length || !wanted.length) return null;
  let total = 0;
  let matched = 0;
  let restoreAt = null;
  for (const item of list) {
    const feature = String(item?.feature || "").trim().toLowerCase();
    if (!wanted.includes(feature)) continue;
    const remaining = Number(item?.remaining);
    if (!Number.isFinite(remaining)) continue;
    matched += 1;
    total += Math.max(0, Math.round(remaining));
    if (!restoreAt && item?.resetAt) restoreAt = String(item.resetAt);
  }
  if (!matched) return null;
  return { textQuota: total, textHasLimit: true, textRestoreAt: restoreAt };
}

/** 号池 TTFB 中位数：延迟乘子的基准。没有样本时返回 null（乘子自动失效）。 */
export function poolMedianTtfb(accounts, stats) {
  const values = [];
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const tag = typeof account?.email === "string" ? accountSlotTag(account.email) : "";
    const rec = tag ? stats?.accounts?.[tag] : null;
    const ttfb = finiteOrNull(rec?.ttfbP50Ms);
    if (ttfb !== null && ttfb > 0) values.push(ttfb);
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}
