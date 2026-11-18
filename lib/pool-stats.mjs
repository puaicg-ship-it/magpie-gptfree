/**
 * Local non-secret quota and image call statistics store.
 *
 * Keyed strictly by `accountSlotTag(email)` (`s<sha256-prefix>`). Never writes raw
 * emails, passwords, TOTP secrets, JWTs, or URLs to disk. Uses serialized atomic
 * writes inside `poolDir()/pool-stats.json` (or an isolated in-memory store).
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { accessTokenState, safeAccountName } from "./credentials.mjs";
import { accountSlotTag, formatAccountSlotLabel } from "./pool-connection.mjs";
import { poolDir } from "./pool-vault.mjs";

const STATS_FILE = "pool-stats.json";
const FORMAT_VERSION = 1;
const SLOT_TAG_RE = /^s[0-9a-f]{10}$/;
// 按天统计保留多少天。够看趋势就行，别让文件无限长。
const HISTORY_DAYS = 400;   // 约 13 个月：够「按年」看，也不至于把账本撑大
const HISTORY_MAX_CODES = 24;

/**
 * 「今天」按哪个时区算。
 *
 * 容器里是 UTC，直接用 toISOString 切日期，对北京时间来说每天要到早上 8 点才翻页，
 * 看着很别扭。默认按 UTC+8（和 `getTimezoneOffset()` 一致：UTC+8 返回 -480）。
 */
function tzOffsetMin() {
  const n = Number(process.env.MAGPIE_GPTFREE_TZ_OFFSET_MIN);
  return Number.isFinite(n) ? n : -480;
}

export function dayKey(nowMs = Date.now(), offsetMin = tzOffsetMin()) {
  return new Date(nowMs - offsetMin * 60_000).toISOString().slice(0, 10);
}

let pending = Promise.resolve();
function exclusive(work) {
  const run = pending.then(work, work);
  pending = run.catch(() => {});
  return run;
}

export function defaultStatsFile() {
  return join(poolDir(), STATS_FILE);
}

export function createEmptyStats() {
  return {
    version: FORMAT_VERSION,
    // successCalls/failCalls 只数生图。文本单独一组，因为「能不能画图」和
    // 「能不能答话」是两条独立的上游能力，混在一起会让 never 判死规则失灵。
    totals: { successCalls: 0, failCalls: 0, textSuccessCalls: 0, textFailCalls: 0 },
    accounts: {},
    // { "2026-11-14": { success: 12, fail: 30, byCode: { request_timeout: 4 },
    //                  textSuccess: 8, textFail: 1 } }
    history: {},
  };
}

export function sanitizeStatsMessage(message, limit = 180) {
  const cleaned = String(message || "")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, "[redacted-token]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/[\r\n\0\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, limit);
}

function cleanIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function cleanCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/** HTTP 状态码：只留 100–599，别的当没有（宁可不写，也不编）。 */
function cleanStatus(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 100 && n <= 599 ? n : null;
}

function cleanQuota(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function cleanPlanType(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 32);
  return /^[a-zA-Z0-9._ -]+$/.test(trimmed) ? trimmed : null;
}

/**
 * 失败原因码只允许 `[a-z0-9_.-]`，长度 48。
 *
 * 之前只记"失败了 84 次"，不知道是 MFA 被拦、超时还是上游 500 —— 排查只能去翻
 * docker logs。原因码本身是我们自己造的标识（`mfa_verify_failed_403`、
 * `quota_exhausted`、`request_timeout`…），不含邮箱和 URL，但仍然走白名单，
 * 免得哪天有人把整条上游报错塞进来。
 */
function cleanErrorCode(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 48).toLowerCase();
  return /^[a-z0-9_.-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * 耗时（毫秒）：0–1 小时，别的当没有。
 *
 * 必须先挡掉 null / "" / undefined：`Number(null)` 和 `Number("")` 都是 0，
 * 否则「没有历史值」会被当成「历史值是 0」，EWMA 从 0 起算会把均值一路压低
 * （20000ms 的首个样本会算成 6000ms）。
 */
function cleanMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= 3_600_000 ? n : null;
}

/**
 * 上游 `limits_progress` 的全量快照（0.10.0 只观测，不派生文本额度）。
 *
 * 以前只解析 `image_gen` 一个 feature，其余（`other_tool` 等）直接丢弃 ——
 * 那部分额度在账本里根本不存在。这里原样保留，最多 12 条；feature 名走白名单，
 * 免得哪天把上游内部 id 或文案写进账本。
 */
function normalizeLimits(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const feature = typeof item.feature === "string" ? item.feature.trim().toLowerCase() : "";
    if (!/^[a-z0-9_.-]{1,40}$/.test(feature)) continue;
    const remaining = cleanQuota(item.remaining);
    if (remaining === null) continue;
    const entry = { feature, remaining };
    const resetAt = cleanIso(item.resetAt);
    if (resetAt) entry.resetAt = resetAt;
    out.push(entry);
    if (out.length >= 12) break;
  }
  return out;
}

/** 指数滑动平均（alpha 0.3）：单条样本不影响整体，但能跟上最近的漂移。 */
function ewmaMs(prev, sample) {
  const p = cleanMs(prev);
  const s = cleanMs(sample);
  if (s === null) return p;
  if (p === null) return s;
  return Math.round(p * 0.7 + s * 0.3);
}

function normalizeAccountEntry(entry) {
  const src = entry && typeof entry === "object" ? entry : {};
  return {
    imageQuota: cleanQuota(src.imageQuota),
    hasImageLimit: typeof src.hasImageLimit === "boolean" ? src.hasImageLimit : null,
    planType: cleanPlanType(src.planType),
    restoreAt: cleanIso(src.restoreAt),
    limitedUntil: cleanIso(src.limitedUntil),
    quotaCheckedAt: cleanIso(src.quotaCheckedAt),
    quotaError: typeof src.quotaError === "string" && src.quotaError.trim()
      ? sanitizeStatsMessage(src.quotaError)
      : null,
    // 上一次失败的原因码和发生时间：判死规则和人工排查都靠它。
    lastErrorCode: cleanErrorCode(src.lastErrorCode),
    lastErrorAt: cleanIso(src.lastErrorAt),
    // 上一次失败时上游返回的原文（脱敏、截断）。只给人看，不参与判死。
    lastErrorMessage: typeof src.lastErrorMessage === "string" && src.lastErrorMessage.trim()
      ? sanitizeStatsMessage(src.lastErrorMessage)
      : null,
    lastUpstreamStatus: cleanStatus(src.lastUpstreamStatus),
    successCalls: cleanCount(src.successCalls),
    failCalls: cleanCount(src.failCalls),
    lastUsedAt: cleanIso(src.lastUsedAt),
    // 文本链路的独立计数。不并进 successCalls/failCalls：一个只能答话、画不了图
    // 的号仍然是「生图废号」，never 判死规则必须继续按生图算。
    textSuccessCalls: cleanCount(src.textSuccessCalls),
    textFailCalls: cleanCount(src.textFailCalls),
    textLastUsedAt: cleanIso(src.textLastUsedAt),
    textLastErrorCode: cleanErrorCode(src.textLastErrorCode),
    // 本地熔断：连续失败到阈值就冷却一段时间，避免坏号把每次请求都拖到超时。
    consecutiveFails: cleanCount(src.consecutiveFails),
    cooldownUntil: cleanIso(src.cooldownUntil),
    // 长周期健康：最后一次成功、当前失败连串从什么时候开始、连续授权失败次数。
    lastSuccessAt: cleanIso(src.lastSuccessAt),
    failSince: cleanIso(src.failSince),
    // 限流这一轮什么时候开始的、上一轮什么时候开始/结束、一共被限流过几次。
    // 「什么时候限流、什么时候恢复」就是这四个字段。
    limitedAt: cleanIso(src.limitedAt),
    lastLimitedAt: cleanIso(src.lastLimitedAt),
    recoveredAt: cleanIso(src.recoveredAt),
    limitCount: cleanCount(src.limitCount),
    // limitedAt 是从上游重置时间倒推出来的（不是观测到的），界面要标「约」。
    limitedAtEstimated: src.limitedAtEstimated === true,
    authFails: cleanCount(src.authFails),
    deadAt: cleanIso(src.deadAt),
    // ---- 0.10.0 观测字段（只记录，不参与排序）----
    // 上游 limits_progress 全量快照；以前只认 image_gen，其余 feature 被丢弃。
    limits: normalizeLimits(src.limits),
    // 上次额度检测时的额度快照，用来算「消耗速率 / 预计耗尽时间」。
    quotaAtCheck: cleanQuota(src.quotaAtCheck),
    // 文本链路自己的限流状态：429 后到什么时候、连续失败几次。
    // 和图片的 limitedUntil / consecutiveFails 完全独立。
    textLimitedUntil: cleanIso(src.textLimitedUntil),
    textConsecutiveFails: cleanCount(src.textConsecutiveFails),
    // 性能画像：耗时和首字节的 EWMA，样本数决定它可不可信。
    avgImageMs: cleanMs(src.avgImageMs),
    avgTextMs: cleanMs(src.avgTextMs),
    ttfbP50Ms: cleanMs(src.ttfbP50Ms),
    imageSamples: cleanCount(src.imageSamples),
    textSamples: cleanCount(src.textSamples),
  };
}

function normalizeStats(parsed) {
  const base = createEmptyStats();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return base;
  base.totals = {
    successCalls: cleanCount(parsed.totals?.successCalls),
    failCalls: cleanCount(parsed.totals?.failCalls),
    textSuccessCalls: cleanCount(parsed.totals?.textSuccessCalls),
    textFailCalls: cleanCount(parsed.totals?.textFailCalls),
  };
  if (parsed.accounts && typeof parsed.accounts === "object" && !Array.isArray(parsed.accounts)) {
    for (const [slotTag, entry] of Object.entries(parsed.accounts)) {
      if (!SLOT_TAG_RE.test(slotTag)) continue;
      base.accounts[slotTag] = normalizeAccountEntry(entry);
    }
  }
  base.history = normalizeHistory(parsed.history);
  return base;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeHistory(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [day, bucket] of Object.entries(raw)) {
    if (!DAY_RE.test(day) || !bucket || typeof bucket !== "object") continue;
    const byCode = {};
    const codes = bucket.byCode && typeof bucket.byCode === "object" ? bucket.byCode : {};
    let kept = 0;
    for (const [code, n] of Object.entries(codes)) {
      if (kept >= HISTORY_MAX_CODES) break;
      const clean = cleanErrorCode(code);
      if (!clean) continue;
      const count = cleanCount(n);
      if (count > 0) { byCode[clean] = count; kept++; }
    }
    out[day] = {
      success: cleanCount(bucket.success),
      fail: cleanCount(bucket.fail),
      // 文本单独两个格子。老数据没有这两个字段，按 0 处理即可。
      textSuccess: cleanCount(bucket.textSuccess),
      textFail: cleanCount(bucket.textFail),
      byCode,
    };
  }
  return trimHistory(out);
}

function trimHistory(history) {
  const days = Object.keys(history).sort();
  const over = days.length - HISTORY_DAYS;
  if (over <= 0) return history;
  for (const day of days.slice(0, over)) delete history[day];
  return history;
}

/**
 * 记一笔调用。
 *
 * `kind` 决定进哪两个格子：`image`（默认）进 success/fail，`text` 进
 * textSuccess/textFail。失败原因码只收生图的 —— 界面上的「失败原因」是
 * 按生图排的，混进文本会把占比搅乱。
 */
function bumpHistory(stats, { success, code = "", nowMs = Date.now(), kind = "image" }) {
  if (!stats.history || typeof stats.history !== "object") stats.history = {};
  const day = dayKey(nowMs);
  const bucket = stats.history[day] || { success: 0, fail: 0, textSuccess: 0, textFail: 0, byCode: {} };
  if (!bucket.byCode || typeof bucket.byCode !== "object") bucket.byCode = {};
  if (bucket.textSuccess === undefined) bucket.textSuccess = 0;
  if (bucket.textFail === undefined) bucket.textFail = 0;
  if (kind === "text") {
    if (success) bucket.textSuccess += 1;
    else bucket.textFail += 1;
  } else if (success) {
    bucket.success += 1;
  } else {
    bucket.fail += 1;
    const clean = cleanErrorCode(code);
    if (clean) bucket.byCode[clean] = (bucket.byCode[clean] || 0) + 1;
  }
  stats.history[day] = bucket;
  stats.history = trimHistory(stats.history);
}

function resolveTargetSlot(emailOrTag, explicitTag = "") {
  if (typeof explicitTag === "string" && SLOT_TAG_RE.test(explicitTag)) return explicitTag;
  if (typeof emailOrTag === "string") {
    const trimmed = emailOrTag.trim();
    if (SLOT_TAG_RE.test(trimmed)) return trimmed;
    if (trimmed.includes("@")) return accountSlotTag(trimmed);
  }
  return "";
}

async function readFromDisk(file) {
  try {
    const raw = await readFile(file, "utf8");
    return normalizeStats(JSON.parse(raw));
  } catch {
    return createEmptyStats();
  }
}

async function writeToDisk(file, stats) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const payload = JSON.stringify(normalizeStats(stats), null, 2);
  try {
    await writeFile(tmp, payload, { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
    try { await chmod(file, 0o600); } catch {}
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

function resolveStoreTarget({ statsFile, statsStore } = {}) {
  if (statsStore && typeof statsStore === "object") return { memory: statsStore, file: null };
  if (statsFile === false || statsFile === null) return { memory: null, file: null };
  if (typeof statsFile === "string" && statsFile) return { memory: null, file: statsFile };
  return { memory: null, file: defaultStatsFile() };
}

export async function readPoolStats(opts = {}) {
  const { memory, file } = resolveStoreTarget(opts);
  if (memory) {
    if (!memory.state) memory.state = createEmptyStats();
    return normalizeStats(memory.state);
  }
  if (!file) return createEmptyStats();
  return exclusive(() => readFromDisk(file));
}

async function updatePoolStats(mutator, opts = {}) {
  const { memory, file } = resolveStoreTarget(opts);
  if (memory) {
    if (!memory.state) memory.state = createEmptyStats();
    const current = normalizeStats(memory.state);
    const next = (await mutator(current)) || current;
    memory.state = normalizeStats(next);
    return memory.state;
  }
  if (!file) {
    const current = createEmptyStats();
    return normalizeStats((await mutator(current)) || current);
  }
  return exclusive(async () => {
    const current = await readFromDisk(file);
    const next = (await mutator(current)) || current;
    const normalized = normalizeStats(next);
    await writeToDisk(file, normalized);
    return normalized;
  });
}

export function createInMemoryStatsStore() {
  return { state: createEmptyStats() };
}

export async function recordQuotaCheck({
  email = "",
  slotTag = "",
  quota = null,
  restoreAt = null,
  hasImageLimit = null,
  planType = null,
  error = null,
  rateLimited = false,
  retryAfter = null,
  // 上游 limits_progress 全量快照（0.10.0 只观测）。不是数组时保留上一次的值。
  limits = null,
} = {}, opts = {}) {
  const tag = resolveTargetSlot(email, slotTag);
  if (!tag) return null;
  const checkedAt = new Date().toISOString();
  return updatePoolStats((stats) => {
    const prev = normalizeAccountEntry(stats.accounts[tag]);
    if (error && !rateLimited) {
      // 额度检测里也可能整条授权链路都过不去（Token 过期 → 重新登录 → MFA 被拦）。
      // 这类错和「网络超时」不是一回事：再试一次还是这样，就说明这个号进不去了。
      // 攒到 AUTH_FAIL_LIMIT 次判死，界面上会从「额度查询失败」挪到「已失效」。
      const authLike = AUTH_ERROR.test(String(error));
      const authFails = authLike ? prev.authFails + 1 : prev.authFails;
      stats.accounts[tag] = normalizeAccountEntry({
        ...prev,
        quotaCheckedAt: checkedAt,
        quotaError: sanitizeStatsMessage(error) || "额度查询失败",
        ...(authLike
          ? {
              authFails,
              deadAt: prev.deadAt || (authFails >= AUTH_FAIL_LIMIT ? checkedAt : null),
            }
          : {}),
      });
      return stats;
    }

    if (rateLimited) {
      const retrySec = Number(retryAfter);
      const limitedUntil = Number.isFinite(retrySec) && retrySec > 0
        ? new Date(Date.now() + retrySec * 1000).toISOString()
        : cleanIso(restoreAt) || prev.limitedUntil;
      stats.accounts[tag] = normalizeAccountEntry({
        ...prev,
        imageQuota: 0,
        limitedUntil,
        restoreAt: cleanIso(restoreAt) || prev.restoreAt,
        planType: planType || prev.planType,
        quotaCheckedAt: checkedAt,
        quotaError: null,
        // 被限流说明授权是通的：连续授权失败清零，之前因此判的死也一并解掉。
        ...(prev.deadAt && prev.authFails >= AUTH_FAIL_LIMIT ? { deadAt: null } : {}),
        authFails: 0,
      });
      return stats;
    }

    const numericQuota = cleanQuota(quota);
    const cleanRestore = cleanIso(restoreAt);
    stats.accounts[tag] = normalizeAccountEntry({
      ...prev,
      imageQuota: numericQuota ?? 0,
      hasImageLimit: typeof hasImageLimit === "boolean" ? hasImageLimit : prev.hasImageLimit,
      planType: planType || prev.planType,
      restoreAt: cleanRestore,
      limitedUntil: (numericQuota ?? 0) === 0 ? cleanRestore : null,
      quotaCheckedAt: checkedAt,
      quotaError: null,
      // 观测：额度快照 + 上游 limits 全量。没有 limits 时保留上一次的，不清空。
      quotaAtCheck: numericQuota ?? prev.quotaAtCheck,
      ...(Array.isArray(limits) ? { limits: normalizeLimits(limits) } : {}),
      // 额度能读出来，说明登录链路（含 MFA）是通的：把「重新登录失败」判的死解掉，
      // 让它重新回到队列里试。这是人工点「检测额度」的复活路径。
      ...(prev.deadAt && prev.authFails >= AUTH_FAIL_LIMIT
        ? { deadAt: null, consecutiveFails: 0, cooldownUntil: null, failSince: null }
        : {}),
      authFails: 0,
      // 读到的额度 > 0 就是从限流里恢复了；读到 0 说明还在限流（或刚开始）。
      ...nextLimitFields(prev, { limited: (numericQuota ?? 0) === 0, nowIso: checkedAt }),
    });
    return stats;
  }, opts);
}

/**
 * 限流状态机：进入限流时记开始时间，恢复时把开始时间挪到 `lastLimitedAt` 并记
 * `recoveredAt`。只在真正的状态切换时改动，重复调用不会重复计数。
 *
 * 「什么时候被限流、什么时候恢复、这一轮持续了多久、一共几轮」全靠它。
 */
export function nextLimitFields(prev, { limited, nowIso }) {
  const wasLimited = typeof prev?.limitedAt === "string" && prev.limitedAt ? prev.limitedAt : "";
  const limitCount = cleanCount(prev?.limitCount);
  if (limited) {
    return {
      limitedAt: wasLimited || nowIso,
      limitCount: wasLimited ? limitCount : limitCount + 1,
      // 一旦是真实观测到的进入限流，之前那个倒推出来的估计值就不再成立。
      limitedAtEstimated: wasLimited ? prev?.limitedAtEstimated === true : false,
    };
  }
  if (!wasLimited) return {};
  return {
    limitedAt: null,
    lastLimitedAt: wasLimited,
    recoveredAt: nowIso,
    limitedAtEstimated: false,
  };
}

export async function recordImageCall({
  email = "",
  slotTag = "",
  success = false,
  count = 1,
  rateLimited = false,
  retryAfter = null,
  error = "",
  errorMessage = "",
  // 上游真实返回的状态码。和 error 对应的 httpStatus 常常不是一个数：
  // 上游 200 + 一段文字，我们对外是 502。分开记才看得清是谁编的。
  upstreamStatus = null,
  // 这次失败是不是账号自己的问题。提示词被拒（content policy）、图片格式不对这类
  // 是请求的错，算到账号头上会把好号一个个冷却掉。
  accountFault = true,
  // 授权失败（token 过期且重新登录也没成）：比"打不通"更硬，攒够次数直接判死。
  authFault = false,
  // 观测：这次尝试的总耗时与首字节时间（0.10.0 只记录画像，不参与排序）。
  ms = null,
  ttfbMs = null,
} = {}, opts = {}) {
  const tag = resolveTargetSlot(email, slotTag);
  const usedCount = Math.max(1, cleanCount(count) || 1);
  const nowIso = new Date().toISOString();

  return updatePoolStats((stats) => {
    if (success) {
      stats.totals.successCalls += usedCount;
    } else {
      stats.totals.failCalls += 1;
    }
    // 按天记一份，用来画趋势和失败原因分布；拿不到账号也不影响这一层。
    bumpHistory(stats, { success, code: error });
    if (!tag) return stats;

    const prev = normalizeAccountEntry(stats.accounts[tag]);
    if (success) {
      let nextQuota = prev.imageQuota;
      if (typeof nextQuota === "number") {
        nextQuota = Math.max(0, nextQuota - usedCount);
      }
      stats.accounts[tag] = normalizeAccountEntry({
        ...prev,
        imageQuota: nextQuota,
        quotaError: null,
        successCalls: prev.successCalls + usedCount,
        lastUsedAt: nowIso,
        consecutiveFails: 0,
        cooldownUntil: null,
        lastSuccessAt: nowIso,
        failSince: null,
        authFails: 0,
        deadAt: null,
        // 成功了就把上次的失败原因清掉，免得界面上挂着一条早就过期的错误。
        lastErrorCode: null,
        lastErrorAt: null,
        lastErrorMessage: null,
        lastUpstreamStatus: null,
        // 这一次成功之后额度见底 = 进入新一轮限流；还有额度 = 从限流里恢复了。
        ...nextLimitFields(prev, { limited: nextQuota === 0, nowIso }),
        // 性能画像只在成功时更新：失败（尤其卡死）的耗时不能代表这个号「正常多快」。
        avgImageMs: ewmaMs(prev.avgImageMs, ms),
        ttfbP50Ms: ewmaMs(prev.ttfbP50Ms, ttfbMs),
        imageSamples: prev.imageSamples + (cleanMs(ms) !== null ? 1 : 0),
      });
      return stats;
    }

    // 请求本身的错：只记总失败数，不动账号健康。但原因码照样记下来 ——
    // "提示词被拒"和"账号打不通"在界面上应该分得清。
    if (!accountFault) {
      stats.accounts[tag] = normalizeAccountEntry({
        ...prev,
        failCalls: prev.failCalls + 1,
        lastUsedAt: nowIso,
        lastErrorCode: error,
        lastErrorAt: nowIso,
        lastErrorMessage: sanitizeStatsMessage(errorMessage) || null,
        lastUpstreamStatus: cleanStatus(upstreamStatus),
      });
      return stats;
    }

    let nextQuota = prev.imageQuota;
    let nextLimitedUntil = prev.limitedUntil;
    let nextCheckedAt = prev.quotaCheckedAt;
    const hangFault = HANG_ERROR_CODES.has(error);
    const consecutiveFails = prev.consecutiveFails + (hangFault ? 2 : 1);
    let cooldownUntil = prev.cooldownUntil;
    if (rateLimited) {
      nextQuota = 0;
      const retrySec = Number(retryAfter);
      if (Number.isFinite(retrySec) && retrySec > 0) {
        nextLimitedUntil = new Date(Date.now() + retrySec * 1000).toISOString();
      }
      nextCheckedAt = nowIso;
    } else {
      const cooldownMs = Math.max(
        failCooldownMs(consecutiveFails),
        hangFault ? HANG_COOLDOWN_MS : 0,
      );
      if (cooldownMs > 0) {
        cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
      }
    }
    const authFails = authFault ? prev.authFails + 1 : prev.authFails;
    stats.accounts[tag] = normalizeAccountEntry({
      ...prev,
      imageQuota: nextQuota,
      limitedUntil: nextLimitedUntil,
      quotaCheckedAt: nextCheckedAt,
      quotaError: rateLimited ? null : (error ? prev.quotaError : prev.quotaError),
      failCalls: prev.failCalls + 1,
      lastUsedAt: nowIso,
      lastErrorCode: error,
      lastErrorAt: nowIso,
      lastErrorMessage: sanitizeStatsMessage(errorMessage) || null,
      lastUpstreamStatus: cleanStatus(upstreamStatus),
      failSince: prev.failSince || nowIso,
      // 上游明确说"到上限了/被限流"就是一轮限流的开始；普通失败不算。
      ...(rateLimited ? nextLimitFields(prev, { limited: true, nowIso }) : {}),
      authFails,
      deadAt: prev.deadAt || (authFails >= AUTH_FAIL_LIMIT ? nowIso : null),
      consecutiveFails,
      cooldownUntil,
    });
    return stats;
  }, opts);
}

export async function removeAccountStats(emailOrTag, opts = {}) {
  const tag = resolveTargetSlot(emailOrTag);
  if (!tag) return null;
  return updatePoolStats((stats) => {
    delete stats.accounts[tag];
    return stats;
  }, opts);
}

/**
 * 记一笔文本调用。
 *
 * 和生图分开记，理由见 createEmptyStats 的注释。这里**不动**额度、熔断和判死
 * 字段：文本打不通不代表画不了图，反过来也一样，两套状态各自独立。
 */
export async function recordTextCall({
  email = "",
  slotTag = "",
  success = false,
  error = "",
  // 文本自己的限流信号：429 后冷却到什么时候。和图片的 limitedUntil 互不影响。
  rateLimited = false,
  retryAfter = null,
  // 观测：这次文本尝试的耗时。
  ms = null,
} = {}, opts = {}) {
  const tag = resolveTargetSlot(email, slotTag);
  const nowIso = new Date().toISOString();

  return updatePoolStats((stats) => {
    if (success) stats.totals.textSuccessCalls = cleanCount(stats.totals.textSuccessCalls) + 1;
    else stats.totals.textFailCalls = cleanCount(stats.totals.textFailCalls) + 1;
    bumpHistory(stats, { success, code: error, nowMs: Date.parse(nowIso), kind: "text" });
    if (!tag) return stats;

    const prev = normalizeAccountEntry(stats.accounts[tag]);
    // 429 默认冷却 60 秒、上限 1 小时；普通失败只累计连续失败数，不动到期时间。
    const retrySec = Number(retryAfter);
    const cooldownSec = Number.isFinite(retrySec) && retrySec > 0
      ? Math.min(retrySec, 3600)
      : 60;
    const textLimitedUntil = rateLimited
      ? new Date(Date.parse(nowIso) + cooldownSec * 1000).toISOString()
      : (success ? null : prev.textLimitedUntil);

    stats.accounts[tag] = normalizeAccountEntry({
      ...prev,
      textSuccessCalls: success ? prev.textSuccessCalls + 1 : prev.textSuccessCalls,
      textFailCalls: success ? prev.textFailCalls : prev.textFailCalls + 1,
      textLastUsedAt: nowIso,
      textLastErrorCode: success ? null : (cleanErrorCode(error) || prev.textLastErrorCode),
      // 文本自己的状态：连续失败用于后续熔断，限流到期时间用于文本选号分桶。
      textConsecutiveFails: success ? 0 : prev.textConsecutiveFails + 1,
      textLimitedUntil,
      avgTextMs: success ? ewmaMs(prev.avgTextMs, ms) : prev.avgTextMs,
      textSamples: prev.textSamples + (success && cleanMs(ms) !== null ? 1 : 0),
    });
    return stats;
  }, opts);
}

/**
 * 连续失败几次开始冷却，以及冷却多久。
 *
 * 背景：额度只在「成功」时本地 -1，「失败」不改额度。于是一个实际已经打不通、
 * 但快照上还挂着 25 的号，会被判成「可用」并一直留在队列里，每次请求都挨个
 * 打过去、每个耗 5-10 秒才失败，最后把客户端拖到 59 秒超时（日志里的 499）。
 * 这里按连续失败次数做指数退避，把它踢出队列一段时间。
 */
export const FAIL_COOLDOWN_THRESHOLD = 3;
const FAIL_COOLDOWN_BASE_MS = 10 * 60 * 1000;
const FAIL_COOLDOWN_MAX_MS = 60 * 60 * 1000;
/**
 * 卡死（worker 跑满整个单次上限都没返回）比普通失败贵得多：它吃掉的是整条 lane
 * 的预算，一个这样的号就能把一次请求拖死。所以一次卡死按两次失败计，并且立刻
 * 给它 5 分钟冷却 —— 不用等攒满三次。连续两次卡死就走正常的指数阶梯（20 分钟起）。
 */
const HANG_ERROR_CODES = new Set(["worker_timeout"]);
const HANG_COOLDOWN_MS = 5 * 60 * 1000;

export function failCooldownMs(consecutiveFails) {
  const over = cleanCount(consecutiveFails) - FAIL_COOLDOWN_THRESHOLD;
  if (over < 0) return 0;
  return Math.min(FAIL_COOLDOWN_BASE_MS * 2 ** Math.min(over, 6), FAIL_COOLDOWN_MAX_MS);
}

/**
 * 短冷却治不了「这个号已经废了」，判死有四条路：
 *
 * - `auth`：连续两次连重新登录都过不去（典型是 MFA 403）。
 * - `never`：导进来之后一次都没成功过，失败却攒到阈值。这类号额度快照上还挂着
 *   25，但每次都是打到超时才失败——只靠冷却它会一小时一次地回来捣乱，直接判死。
 * - `stale`：连续三天没成功过一次。
 * - `marked`：别处显式标记的。
 *
 * 判死只是不给它派活（排在兜底队列最后），账号本身还在池子里。重新导入凭据、
 * 或者哪次兜底碰巧成功了，都会自动复活。
 */
export const AUTH_FAIL_LIMIT = 2;
export const DEAD_AFTER_MS = 72 * 60 * 60 * 1000;
export const NEVER_WORKED_FAILS = 15;
/**
 * 哪些错误算「这个号进不去了」，而不是「这次网络不行」。
 * 只认上游明确拒绝授权的码：MFA 被拦、401、重新登录失败。
 * 超时、连不上、代理报错都不算 —— 那些换个网络就能好，算到账号头上会把好号杀光。
 */
const AUTH_ERROR = /mfa_verify_failed|unauthorized|reauth_failed|\b401\b/i;

export function accountDeadReason(
  email,
  stats,
  { nowMs = Date.now(), deadAfterMs = DEAD_AFTER_MS, neverWorkedFails = NEVER_WORKED_FAILS } = {},
) {
  const tag = resolveTargetSlot(email);
  if (!tag) return "";
  const entry = stats?.accounts?.[tag];
  if (!entry) return "";
  if (entry.deadAt) return entry.authFails >= AUTH_FAIL_LIMIT ? "auth" : "marked";
  // 一次没成过还失败了十几次：不是运气差，是这号根本打不通。
  if (entry.successCalls === 0 && entry.failCalls >= neverWorkedFails) return "never";
  const sinceMs = Date.parse(cleanIso(entry.failSince) || "");
  if (!Number.isFinite(sinceMs)) return "";
  return nowMs - sinceMs >= deadAfterMs ? "stale" : "";
}

export function isAccountDead(email, stats, opts = {}) {
  return accountDeadReason(email, stats, opts) !== "";
}

export function isAccountCoolingDown(email, stats, { nowMs = Date.now() } = {}) {
  const tag = resolveTargetSlot(email);
  if (!tag) return false;
  const entry = stats?.accounts?.[tag];
  const until = cleanIso(entry?.cooldownUntil);
  if (!until) return false;
  const untilMs = Date.parse(until);
  return !Number.isFinite(untilMs) || untilMs > nowMs;
}

export function isAccountRateLimited(email, stats, { nowMs = Date.now() } = {}) {
  const tag = resolveTargetSlot(email);
  if (!tag) return false;
  const entry = stats?.accounts?.[tag];
  if (!entry || cleanQuota(entry.imageQuota) !== 0) return false;
  const resetIso = cleanIso(entry.limitedUntil) || cleanIso(entry.restoreAt);
  if (!resetIso) return true;
  const resetMs = Date.parse(resetIso);
  return !Number.isFinite(resetMs) || resetMs > nowMs;
}

export function summarizePoolStats(rows, stats, { nowMs = Date.now(), resolveId = null } = {}) {
  const safeStats = normalizeStats(stats);
  const accounts = [];
  let active = 0;
  let limited = 0;
  let unchecked = 0;
  let errored = 0;
  let needsRenew = 0;
  let checked = 0;
  let totalQuota = 0;
  let dead = 0;
  let textLimitedCount = 0;
  let utilRemaining = 0;
  let utilAtCheck = 0;
  const deadBreakdown = { auth: 0, never: 0, stale: 0, marked: 0 };

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.email !== "string" || !row.email.includes("@")) continue;
    const slotTag = accountSlotTag(row.email);
    const slotLabel = formatAccountSlotLabel(row.email);
    const tokenState = row.accessToken ? accessTokenState(row.accessToken).state : "missing";
    const hasAccess = !!row.accessToken;
    const rec = safeStats.accounts[slotTag] || null;

    const imageQuota = rec ? rec.imageQuota : cleanQuota(row.imageQuota);
    const quotaError = rec?.quotaError || (typeof row.quotaError === "string" ? sanitizeStatsMessage(row.quotaError) : null);
    const quotaResetAt = rec?.limitedUntil || rec?.restoreAt || cleanIso(row.quotaResetAt);
    const quotaCheckedAt = rec?.quotaCheckedAt || cleanIso(row.quotaCheckedAt);
    const hasImageLimit = rec?.hasImageLimit ?? (typeof row.hasImageLimit === "boolean" ? row.hasImageLimit : null);
    const planType = rec?.planType || cleanPlanType(row.planType);
    const successCalls = rec ? rec.successCalls : cleanCount(row.successCalls);
    const failCalls = rec ? rec.failCalls : cleanCount(row.failCalls);
    const lastUsedAt = rec?.lastUsedAt || cleanIso(row.lastUsedAt);
    const deadReason = accountDeadReason(row.email, safeStats, { nowMs });

    const resetMs = quotaResetAt ? Date.parse(quotaResetAt) : NaN;
    const cooldownExpired = imageQuota === 0 && Number.isFinite(resetMs) && resetMs <= nowMs;
    const tokenUsable = hasAccess && tokenState === "unexpired_unverified";
    const tokenBroken = !hasAccess || tokenState === "missing" || tokenState === "invalid";

    let quotaStatus;
    if (deadReason) {
      quotaStatus = "dead";
      dead++;
      deadBreakdown[deadReason] = (deadBreakdown[deadReason] || 0) + 1;
    } else if (tokenBroken) {
      quotaStatus = "unavailable";
      needsRenew++;
    } else if (imageQuota === 0) {
      quotaStatus = "limited";
      limited++;
    } else if (typeof imageQuota === "number" && imageQuota > 0) {
      if (tokenUsable) {
        quotaStatus = "available";
        active++;
        totalQuota += imageQuota;
      } else {
        quotaStatus = "needs_renew";
        needsRenew++;
      }
    } else if (quotaError) {
      quotaStatus = "error";
      errored++;
    } else {
      quotaStatus = "unchecked";
      unchecked++;
    }

    if (imageQuota !== null) checked++;

    // 「这一轮限流持续了多久」：还在限流就是 now - limitedAt，已经恢复就是
    // recoveredAt - lastLimitedAt。两个都给界面用。
    const limitedAtMs = Date.parse(rec?.limitedAt || "");
    const recoveredMs = Date.parse(rec?.recoveredAt || "");
    const lastLimitedMs = Date.parse(rec?.lastLimitedAt || "");
    let limitedForMs = null;
    if (Number.isFinite(limitedAtMs)) {
      limitedForMs = Math.max(0, nowMs - limitedAtMs);
    } else if (Number.isFinite(recoveredMs) && Number.isFinite(lastLimitedMs)) {
      limitedForMs = Math.max(0, recoveredMs - lastLimitedMs);
    }

    // 观测（0.10.0 只展示，不参与排序）：消耗速率、预计耗尽时间、文本状态。
    let burnRatePerHour = null;
    let etaExhaustMs = null;
    if (rec && typeof rec.quotaAtCheck === "number" && typeof imageQuota === "number") {
      const checkedMs = Date.parse(rec.quotaCheckedAt || "");
      const hours = Number.isFinite(checkedMs) ? (nowMs - checkedMs) / 3_600_000 : 0;
      if (hours > 0) {
        const burned = rec.quotaAtCheck - imageQuota;
        burnRatePerHour = burned > 0 ? burned / hours : 0;
        if (burnRatePerHour > 0 && imageQuota > 0) {
          etaExhaustMs = Math.round((imageQuota / burnRatePerHour) * 3_600_000);
        }
      }
    }
    const textLimitedMs = Date.parse(rec?.textLimitedUntil || "");
    const textLimited = Number.isFinite(textLimitedMs) && textLimitedMs > nowMs;
    const textStatus = deadReason ? "dead"
      : textLimited ? "limited"
        : (rec && (rec.textSuccessCalls > 0 || rec.textFailCalls > 0)) ? "available"
          : "unchecked";

    if (textLimited) textLimitedCount += 1;
    if (typeof imageQuota === "number" && rec && typeof rec.quotaAtCheck === "number") {
      utilRemaining += imageQuota;
      utilAtCheck += rec.quotaAtCheck;
    }

    accounts.push({
      ...(typeof resolveId === "function" ? { id: resolveId(row.email) } : {}),
      email: safeAccountName(row.email),
      slotLabel,
      slotTag,
      updatedAt: row.updatedAt || null,
      hasAccess,
      tokenState,
      imageQuota,
      quotaStatus,
      hasImageLimit,
      planType,
      quotaResetAt,
      quotaCheckedAt,
      quotaError,
      cooldownExpired,
      successCalls,
      failCalls,
      lastUsedAt,
      consecutiveFails: rec ? rec.consecutiveFails : 0,
      failCooldownUntil: rec?.cooldownUntil || null,
      deadReason,
      failSince: rec?.failSince || null,
      lastSuccessAt: rec?.lastSuccessAt || null,
      lastErrorCode: rec?.lastErrorCode || null,
      lastErrorAt: rec?.lastErrorAt || null,
      lastErrorMessage: rec?.lastErrorMessage || null,
      lastUpstreamStatus: rec?.lastUpstreamStatus ?? null,
      authFails: rec ? rec.authFails : 0,
      limitedAt: rec?.limitedAt || null,
      limitedAtEstimated: rec?.limitedAtEstimated === true,
      lastLimitedAt: rec?.lastLimitedAt || null,
      recoveredAt: rec?.recoveredAt || null,
      limitCount: rec ? rec.limitCount : 0,
      limitedForMs,
      // 文本链路的独立计数，界面上只在提示里露出来，不占主表的列。
      textSuccessCalls: rec ? rec.textSuccessCalls : 0,
      textFailCalls: rec ? rec.textFailCalls : 0,
      textLastUsedAt: rec?.textLastUsedAt || null,
      textLastErrorCode: rec?.textLastErrorCode || null,
      // 0.10.0 观测字段：limits 全量、额度快照、文本限流状态、性能画像。
      limits: rec ? rec.limits : [],
      quotaAtCheck: rec ? rec.quotaAtCheck : null,
      textLimitedUntil: rec?.textLimitedUntil || null,
      textConsecutiveFails: rec ? rec.textConsecutiveFails : 0,
      avgImageMs: rec ? rec.avgImageMs : null,
      avgTextMs: rec ? rec.avgTextMs : null,
      ttfbP50Ms: rec ? rec.ttfbP50Ms : null,
      imageSamples: rec ? rec.imageSamples : 0,
      textSamples: rec ? rec.textSamples : 0,
      burnRatePerHour,
      etaExhaustMs,
      textStatus,
      // 有效权重在 0.11.0 接入，这里先占位，避免前端字段忽有忽无。
      effectiveWeight: null,
    });
  }

  // 趋势按天记账，界面自己聚合到周/月/年，所以保留期内每天都要给出去。
  const allDays = Object.keys(safeStats.history).sort();
  const recentDays = allDays.slice(-7);
  const history = allDays.map((date) => ({
    date,
    success: safeStats.history[date].success,
    fail: safeStats.history[date].fail,
    textSuccess: safeStats.history[date].textSuccess || 0,
    textFail: safeStats.history[date].textFail || 0,
  }));
  const todayKey = dayKey(nowMs);
  const todayBucket = safeStats.history[todayKey] || { success: 0, fail: 0, byCode: {} };
  const last7 = { success: 0, fail: 0, textSuccess: 0, textFail: 0 };
  const failBreakdown = {};
  for (const date of recentDays) {
    const bucket = safeStats.history[date];
    last7.success += bucket.success;
    last7.fail += bucket.fail;
    last7.textSuccess += bucket.textSuccess || 0;
    last7.textFail += bucket.textFail || 0;
    for (const [code, n] of Object.entries(bucket.byCode || {})) {
      failBreakdown[code] = (failBreakdown[code] || 0) + n;
    }
  }

  return {
    accounts,
    quotaStats: {
      total: accounts.length,
      active,
      limited,
      unchecked,
      errored,
      needsRenew,
      checked,
      dead,
      totalQuota,
      totalSuccess: safeStats.totals.successCalls,
      totalFail: safeStats.totals.failCalls,
      totalTextSuccess: cleanCount(safeStats.totals.textSuccessCalls),
      totalTextFail: cleanCount(safeStats.totals.textFailCalls),
      // 文本链路限流中的号数（和图片 limited 独立）。
      textLimited: textLimitedCount,
      // 额度利用率：只统计「有检测快照」的号，ratio=1-剩余/检测时额度。
      utilization: {
        remaining: utilRemaining,
        atCheck: utilAtCheck,
        ratio: utilAtCheck > 0 ? 1 - utilRemaining / utilAtCheck : null,
      },
      updatedAt: new Date(nowMs).toISOString(),
    },
    // 失效账号分类：界面按这个分组，一眼看出哪些能救、哪些该删。
    deadBreakdown,
    // 统计：近 7 天趋势、今天、7 天合计、失败原因分布。
    history,
    today: {
      date: todayKey,
      success: todayBucket.success,
      fail: todayBucket.fail,
      textSuccess: todayBucket.textSuccess || 0,
      textFail: todayBucket.textFail || 0,
    },
    last7,
    failBreakdown,
  };
}
