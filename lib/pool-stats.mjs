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
    totals: { successCalls: 0, failCalls: 0 },
    accounts: {},
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
    successCalls: cleanCount(src.successCalls),
    failCalls: cleanCount(src.failCalls),
    lastUsedAt: cleanIso(src.lastUsedAt),
    // 本地熔断：连续失败到阈值就冷却一段时间，避免坏号把每次请求都拖到超时。
    consecutiveFails: cleanCount(src.consecutiveFails),
    cooldownUntil: cleanIso(src.cooldownUntil),
    // 长周期健康：最后一次成功、当前失败连串从什么时候开始、连续授权失败次数。
    lastSuccessAt: cleanIso(src.lastSuccessAt),
    failSince: cleanIso(src.failSince),
    authFails: cleanCount(src.authFails),
    deadAt: cleanIso(src.deadAt),
  };
}

function normalizeStats(parsed) {
  const base = createEmptyStats();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return base;
  base.totals = {
    successCalls: cleanCount(parsed.totals?.successCalls),
    failCalls: cleanCount(parsed.totals?.failCalls),
  };
  if (parsed.accounts && typeof parsed.accounts === "object" && !Array.isArray(parsed.accounts)) {
    for (const [slotTag, entry] of Object.entries(parsed.accounts)) {
      if (!SLOT_TAG_RE.test(slotTag)) continue;
      base.accounts[slotTag] = normalizeAccountEntry(entry);
    }
  }
  return base;
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
} = {}, opts = {}) {
  const tag = resolveTargetSlot(email, slotTag);
  if (!tag) return null;
  const checkedAt = new Date().toISOString();
  return updatePoolStats((stats) => {
    const prev = normalizeAccountEntry(stats.accounts[tag]);
    if (error && !rateLimited) {
      stats.accounts[tag] = normalizeAccountEntry({
        ...prev,
        quotaCheckedAt: checkedAt,
        quotaError: sanitizeStatsMessage(error) || "额度查询失败",
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
      // 额度能读出来，说明登录链路（含 MFA）是通的：把「重新登录失败」判的死解掉，
      // 让它重新回到队列里试。这是人工点「检测额度」的复活路径。
      ...(prev.deadAt && prev.authFails >= AUTH_FAIL_LIMIT
        ? { deadAt: null, authFails: 0, consecutiveFails: 0, cooldownUntil: null, failSince: null }
        : {}),
    });
    return stats;
  }, opts);
}

export async function recordImageCall({
  email = "",
  slotTag = "",
  success = false,
  count = 1,
  rateLimited = false,
  retryAfter = null,
  error = "",
  // 这次失败是不是账号自己的问题。提示词被拒（content policy）、图片格式不对这类
  // 是请求的错，算到账号头上会把好号一个个冷却掉。
  accountFault = true,
  // 授权失败（token 过期且重新登录也没成）：比"打不通"更硬，攒够次数直接判死。
  authFault = false,
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
      });
      return stats;
    }

    // 请求本身的错：只记总失败数，不动账号健康。
    if (!accountFault) {
      stats.accounts[tag] = normalizeAccountEntry({
        ...prev,
        failCalls: prev.failCalls + 1,
        lastUsedAt: nowIso,
      });
      return stats;
    }

    let nextQuota = prev.imageQuota;
    let nextLimitedUntil = prev.limitedUntil;
    let nextCheckedAt = prev.quotaCheckedAt;
    const consecutiveFails = prev.consecutiveFails + 1;
    let cooldownUntil = prev.cooldownUntil;
    if (rateLimited) {
      nextQuota = 0;
      const retrySec = Number(retryAfter);
      if (Number.isFinite(retrySec) && retrySec > 0) {
        nextLimitedUntil = new Date(Date.now() + retrySec * 1000).toISOString();
      }
      nextCheckedAt = nowIso;
    } else {
      const cooldownMs = failCooldownMs(consecutiveFails);
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
      failSince: prev.failSince || nowIso,
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
      authFails: rec ? rec.authFails : 0,
    });
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
      updatedAt: new Date(nowMs).toISOString(),
    },
  };
}
