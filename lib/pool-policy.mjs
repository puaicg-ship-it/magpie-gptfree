/**
 * 号池调度策略：把「权重怎么算」从代码常量变成可读写、可回滚的配置。
 *
 * 为什么要有这一层：0.11.0 开始 `accountWeight` 多了好几个乘子（分级、EWMA 成功率、
 * 首字节延迟、卡死、批次）。每加一个乘子，线上出问题时就多一个「是不是它」的疑问，
 * 而改代码重发版本要几分钟。把这些开关放进配置 + 环境变量，就能在**不重启**的情况下
 * 一条 env 关掉某个乘子。
 *
 * 铁律：**默认策略必须让权重和 0.10.x 逐位一致**。所有新乘子默认 false，
 * `textQuotaFeatures` 默认空，`tierWeights` 只对「手工设的 tier」生效。
 * `test/selection.test.mjs` 的等价性用例是这条铁律的门禁。
 *
 * 存储：复用 `settings.json`（和回复形态、保留天数同一个文件），键名 `poolPolicy`。
 * 不另开一个文件 —— 一个设置文件已经够用，多一个只会多一处「改了不生效」。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { poolDir } from "./pool-vault.mjs";

export const TIERS = ["S", "A", "B", "C"];

/** 只对手工 tier 生效的默认权重；自动推断的 tier 默认只展示。 */
export const DEFAULT_TIER_WEIGHTS = Object.freeze({ S: 1.15, A: 1, B: 0.85, C: 0.6 });

export const DEFAULT_POOL_POLICY = Object.freeze({
  tierWeights: DEFAULT_TIER_WEIGHTS,
  // 自动推断的 tier 是否进权重。默认 false：推断规则还没在真实池子上校准过，
  // 先只展示，等面板上看得出「S 确实更稳」再打开。
  tierAutoWeight: false,
  ewmaWeightEnabled: false,
  latencyWeightEnabled: false,
  hangWeightEnabled: false,
  ewmaAlpha: 0.3,
  ewmaMinSamples: 3,
  tierThresholds: Object.freeze({
    sSuccess: 3,
    sEwma: 0.8,
    cEwma: 0.4,
    cHangs24h: 2,
  }),
  // 哪些上游 feature 算「文本额度」。**默认空**：上游实际返回的是
  // reason / deep_research / file_upload / paste_text_to_file / image_gen，
  // 没有 text_gen 也没有 other_tool。「reason 到底是不是普通对话的额度」
  // 需要人确认，代码不替用户猜。
  textQuotaFeatures: [],
  // 单个号同时允许几个生图 worker。1 = 同一时刻只让一个请求打这个号。
  // 号池整体并发是 4（index.mjs 的 maxConcurrency），4 个请求同时进来时如果都挑中
  // 同一个号，上游看到的是突发流量 → 429 或卡死。0 = 不限制。
  perAccountImageInflight: 1,
  // 单次生图尝试的预算。实测 gpt-image-2 成功要 37.7–37.9 秒，55 秒是红线；
  // gpt-image-2.6 的正常耗时 21–37 秒但尾部会超过 55 秒，所以按模型分开给。
  // 单账号 60 秒没出图就换号。**所有模型统一**：号池里有两百多个号，
  // 等一个慢号的机会成本比换一个号试更大。想给某个模型单独放宽就填 imageSlowModels。
  imageAttemptTimeoutMs: 60_000,
  imageSlowModels: Object.freeze({}),
  hedgeProvenMs: 30_000,
  hedgeUnprovenMs: 12_000,
  // 头号已经在推流时，还要不要为了「探没上过场的号」起第二路？
  // 默认 false：那等于明知道头号会成功还去复制一份，白烧一张图的额度。
  // 打开它就换回探索能力，代价是慢请求会多生成一份。
  exploreWhileProgressing: false,
  // 轮转策略：谁领跑、首选号还算不算数。
  // 三档的差别只在「首选号怎么处理」，权重体系（额度/tier/EWMA/延迟/卡死）不变：
  //   quotaFirst  —— 按权重排，首选号权重不低于最高值一半时才排第一（默认，等于 0.12.x 行为）
  //   roundRobin  —— 按权重排，但**不**给首选号特权，起点靠轮转账本自然铺开
  //   preferred   —— 首选号无条件排第一，其余按权重
  // 没暴露 skipRateLimited：我们的 blocked 桶本来就是「排到最后」而不是「丢弃」，
  // 再加一个「连限流号也照样往前排」的开关只会让人误停好号。
  rotation: Object.freeze({
    strategy: "quotaFirst",
    respectPreferredSlot: true,
  }),
  // 额度巡检：定时挑几个快照过期 / 额度归零的号去问一次。
  // 默认 10 分钟 2 个号，和 0.12.x 写死的值一致。
  sweep: Object.freeze({
    enabled: true,
    intervalMinutes: 10,
    limit: 2,
    // 快照超过这个分钟数就算过期。0 = 不按时间判，只复检额度归零的号。
    staleAfterMinutes: 120,
  }),
});

export const ROTATION_STRATEGIES = Object.freeze(["quotaFirst", "roundRobin", "preferred"]);

const MAX_WEIGHT_MUL = 5;
const FEATURE_RE = /^[a-z0-9_.-]{1,40}$/;

function settingsFile() {
  return join(poolDir(), "settings.json");
}

async function readSettings() {
  try {
    const parsed = JSON.parse(await readFile(settingsFile(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}

async function patchSettings(patch) {
  const file = settingsFile();
  const next = { ...(await readSettings()), ...patch };
  await mkdir(poolDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * 三态：true / false / **null（没指定）**。
 *
 * 「没指定」必须和「指定为 false」分开：环境变量没设时如果返回 false，
 * 就会被当成一条覆盖写进策略，`source` 永远是 "env"，面板上所有开关都会显示成
 * 「被环境变量锁定」，而其实一个 env 都没设。
 */
function boolOf(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  const text = String(value).trim().toLowerCase();
  if (text === "") return null;
  if (["true", "yes", "on"].includes(text)) return true;
  if (["false", "no", "off"].includes(text)) return false;
  return null;
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function normalizeTierWeights(value) {
  const src = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const out = { ...DEFAULT_TIER_WEIGHTS };
  for (const tier of TIERS) {
    const n = clampNumber(src[tier], 0.05, MAX_WEIGHT_MUL);
    if (n !== null) out[tier] = n;
  }
  return out;
}

function normalizeThresholds(value) {
  const src = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const base = DEFAULT_POOL_POLICY.tierThresholds;
  const sSuccess = clampNumber(src.sSuccess, 1, 1000);
  const sEwma = clampNumber(src.sEwma, 0, 1);
  const cEwma = clampNumber(src.cEwma, 0, 1);
  const cHangs24h = clampNumber(src.cHangs24h, 1, 100);
  return {
    sSuccess: sSuccess === null ? base.sSuccess : Math.round(sSuccess),
    sEwma: sEwma === null ? base.sEwma : sEwma,
    cEwma: cEwma === null ? base.cEwma : cEwma,
    cHangs24h: cHangs24h === null ? base.cHangs24h : Math.round(cHangs24h),
  };
}

/** feature 名走白名单：它会进日志和面板，不能把上游的内部 id 或文案带进来。 */
/**
 * 「重模型」超时表。key 只认模型 id 的形状（`gpt-image-*`），值夹在 10–180 秒。
 * 不 import 模型目录是为了避免 pool-policy 反过来依赖 chatgpt-web-image。
 */
const MODEL_ID_RE = /^gpt-image-[a-z0-9.-]{1,32}$/;

function normalizeSlowModels(value) {
  const src = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!src) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(src)) {
    const key = String(rawKey || "").trim().toLowerCase();
    if (!MODEL_ID_RE.test(key)) continue;
    const ms = clampNumber(rawValue, 10_000, 180_000);
    if (ms === null) continue;
    out[key] = Math.round(ms);
    if (Object.keys(out).length >= 16) break;
  }
  // 显式给空表 = 「所有模型都用默认预算」，尊重它（以前这里会退回内置默认值，
  // 结果用户清不掉那张表）。
  return out;
}

function normalizeFeatures(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out = [];
  for (const raw of list) {
    const name = String(raw ?? "").trim().toLowerCase();
    if (!FEATURE_RE.test(name)) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeRotation(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const base = DEFAULT_POOL_POLICY.rotation;
  const strategy = ROTATION_STRATEGIES.includes(String(src.strategy || ""))
    ? String(src.strategy)
    : base.strategy;
  const respect = boolOf(src.respectPreferredSlot);
  return {
    strategy,
    respectPreferredSlot: respect === null ? base.respectPreferredSlot : respect,
  };
}

function normalizeSweep(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const base = DEFAULT_POOL_POLICY.sweep;
  const enabled = boolOf(src.enabled);
  // 巡检间隔下限 1 分钟：再密就是拿上游当压力测试，而且每次都是一次真实请求。
  const interval = clampNumber(src.intervalMinutes, 1, 1440);
  const limit = clampNumber(src.limit, 1, 50);
  // 0 是合法值：只复检额度归零的号，不按快照新旧挑。
  const stale = clampNumber(src.staleAfterMinutes, 0, 10080);
  return {
    enabled: enabled === null ? base.enabled : enabled,
    intervalMinutes: interval === null ? base.intervalMinutes : Math.round(interval),
    limit: limit === null ? base.limit : Math.round(limit),
    staleAfterMinutes: stale === null ? base.staleAfterMinutes : Math.round(stale),
  };
}

function normalizePolicy(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const base = DEFAULT_POOL_POLICY;
  const pickBool = (key) => {
    const v = boolOf(src[key]);
    return v === null ? base[key] : v;
  };
  const alpha = clampNumber(src.ewmaAlpha, 0.05, 0.95);
  const minSamples = clampNumber(src.ewmaMinSamples, 1, 50);
  const inflightLimit = clampNumber(src.perAccountImageInflight, 0, 8);
  const imageTimeout = clampNumber(src.imageAttemptTimeoutMs, 10_000, 180_000);
  const proven = clampNumber(src.hedgeProvenMs, 1000, 120_000);
  const unproven = clampNumber(src.hedgeUnprovenMs, 1000, 120_000);
  return {
    tierWeights: normalizeTierWeights(src.tierWeights),
    tierAutoWeight: pickBool("tierAutoWeight"),
    exploreWhileProgressing: pickBool("exploreWhileProgressing"),
    ewmaWeightEnabled: pickBool("ewmaWeightEnabled"),
    latencyWeightEnabled: pickBool("latencyWeightEnabled"),
    hangWeightEnabled: pickBool("hangWeightEnabled"),
    ewmaAlpha: alpha === null ? base.ewmaAlpha : alpha,
    ewmaMinSamples: minSamples === null ? base.ewmaMinSamples : Math.round(minSamples),
    tierThresholds: normalizeThresholds(src.tierThresholds),
    textQuotaFeatures: normalizeFeatures(src.textQuotaFeatures),
    perAccountImageInflight: inflightLimit === null ? base.perAccountImageInflight : Math.round(inflightLimit),
    imageAttemptTimeoutMs: imageTimeout === null ? base.imageAttemptTimeoutMs : Math.round(imageTimeout),
    imageSlowModels: normalizeSlowModels(src.imageSlowModels),
    hedgeProvenMs: proven === null ? base.hedgeProvenMs : Math.round(proven),
    hedgeUnprovenMs: unproven === null ? base.hedgeUnprovenMs : Math.round(unproven),
    rotation: normalizeRotation(src.rotation),
    sweep: normalizeSweep(src.sweep),
  };
}

/** 环境变量覆盖：用于「线上出问题、来不及改文件」时的紧急回滚。 */
function envOverrides() {
  const patch = {};
  const flags = {
    MAGPIE_GPTFREE_POLICY_TIER_AUTO_WEIGHT: "tierAutoWeight",
    MAGPIE_GPTFREE_POLICY_EWMA: "ewmaWeightEnabled",
    MAGPIE_GPTFREE_POLICY_LATENCY: "latencyWeightEnabled",
    MAGPIE_GPTFREE_POLICY_HANG: "hangWeightEnabled",
    MAGPIE_GPTFREE_POLICY_EXPLORE_WHILE_PROGRESSING: "exploreWhileProgressing",
  };
  for (const [env, key] of Object.entries(flags)) {
    const v = boolOf(process.env[env]);
    if (v !== null) patch[key] = v;
  }
  const features = process.env.MAGPIE_GPTFREE_POLICY_TEXT_FEATURES;
  if (features !== undefined) patch.textQuotaFeatures = features;
  // 线上发现某个号被并发打爆时，一条 env 就能退回不限制。
  const inflight = process.env.MAGPIE_GPTFREE_POLICY_PER_ACCOUNT_INFLIGHT;
  if (inflight !== undefined && String(inflight).trim() !== "") patch.perAccountImageInflight = inflight;
  // 线上某个模型忽然变慢时，一条 env 把默认预算提上去，不用发版。
  const imageTimeout = process.env.MAGPIE_GPTFREE_POLICY_IMAGE_TIMEOUT_MS;
  if (imageTimeout !== undefined && String(imageTimeout).trim() !== "") {
    patch.imageAttemptTimeoutMs = imageTimeout;
  }
  return patch;
}

/**
 * 当前生效的策略。`source` 说明是默认值、设置文件还是环境变量定的，
 * 面板据此把被 env 压住的控件置灰。
 */
export async function readPoolPolicy() {
  const saved = (await readSettings()).poolPolicy;
  const merged = { ...(saved || {}), ...envOverrides() };
  const policy = normalizePolicy(merged);
  const fromEnv = Object.keys(envOverrides()).length > 0;
  const source = fromEnv ? "env" : saved ? "settings" : "default";
  return { policy, source };
}

/**
 * 只覆盖传进来的键，其余保持原样。
 *
 * `rotation` / `sweep` 是嵌套对象，必须再深一层合并：面板只改
 * `{ rotation: { strategy } }` 时，不能把 `respectPreferredSlot` 冲成默认值 ——
 * 那等于「改了一个开关，顺手把另一个改回去」，最难查。
 */
export async function writePoolPolicy(patch = {}) {
  const current = (await readSettings()).poolPolicy || {};
  const merged = { ...current, ...patch };
  if (patch.rotation && typeof patch.rotation === "object") {
    merged.rotation = { ...(current.rotation || {}), ...patch.rotation };
  }
  if (patch.sweep && typeof patch.sweep === "object") {
    merged.sweep = { ...(current.sweep || {}), ...patch.sweep };
  }
  const next = normalizePolicy(merged);
  await patchSettings({ poolPolicy: next });
  return next;
}

/**
 * 这个模型该给多少单次预算。重模型查表，其余走默认。
 * 抽成函数是为了能单测 —— 它是「慢模型被误判成卡死」那条链的入口。
 */
export function resolveImageAttemptTimeout(policy, model) {
  const id = String(model || "").trim().toLowerCase();
  const table = policy?.imageSlowModels;
  if (id && table && typeof table === "object") {
    const hit = Number(table[id]);
    if (Number.isFinite(hit) && hit > 0) return Math.round(hit);
  }
  const fallback = Number(policy?.imageAttemptTimeoutMs);
  return Number.isFinite(fallback) && fallback > 0 ? Math.round(fallback) : DEFAULT_POOL_POLICY.imageAttemptTimeoutMs;
}

/** 供 GUI 做「观察到的 feature 名」下拉用：只校验，不做推断。 */
export function isValidFeatureName(name) {
  return FEATURE_RE.test(String(name || "").trim().toLowerCase());
}

export { normalizePolicy as normalizePoolPolicy };
