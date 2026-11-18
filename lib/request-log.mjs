/**
 * 进程内请求日志（ring buffer）。
 *
 * 为什么要有它：`pool-stats.json` 只记聚合计数，`image-errors.jsonl` 只记失败。
 * 于是「这次请求到底试了哪些号、每个号多久、谁赢了、文本请求有没有发生」全都
 * 看不见 —— 面板只能画按天的柱子，排查延迟和卡死时没有任何逐次线索。
 *
 * 定位：**快变量**。纯内存、零 I/O、单条 < 300B；容量由
 * `MAGPIE_GPTFREE_REQUEST_LOG_SIZE` 控制（默认 800 条）。失败取证继续走
 * `image-errors.jsonl`，这里默认不落盘 —— 每次请求都写文件会把 500 条裁剪的
 * 读放大搬到热路径上。
 *
 * 只在本进程内：热更新时可能新旧两个 host 并存（见 gui-service 的
 * scheduleGuiGuard），ring 会各记各的。所以 metrics 会带上 `since`（进程启动
 * 时间）和 `pid`，面板要注明「本进程自 X 起」，不能当成全局数据。
 *
 * 脱敏：`tag` 用 `accountSlotTag`（`s<sha256前10位>`），**永不写邮箱明文**。
 */
import { accountSlotTag } from "./pool-connection.mjs";

export const REQUEST_LOG_DEFAULT_SIZE = 800;
export const REQUEST_LOG_MAX_LIMIT = 200;

const STARTED_AT = Date.now();
const PROCESS_PID = process.pid;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CAPACITY = Math.max(50, envInt("MAGPIE_GPTFREE_REQUEST_LOG_SIZE", REQUEST_LOG_DEFAULT_SIZE));

const SLOT_TAG_RE = /^s[0-9a-f]{10}$/;
const REQUEST_ID_RE = /^[0-9a-f]{6,16}$/;
const KIND_SET = new Set(["image", "text"]);
const TIER_SET = new Set(["S", "A", "B", "C"]);

// 定长环形缓冲：写入 O(1)，不随容量增长做数组拷贝。
let seq = 0;
let writeIdx = 0;
let stored = 0;
let inflight = 0;
const buffer = new Array(CAPACITY).fill(null);

function resolveTag(emailOrTag, explicitTag) {
  if (typeof explicitTag === "string" && SLOT_TAG_RE.test(explicitTag)) return explicitTag;
  if (typeof emailOrTag === "string") {
    const trimmed = emailOrTag.trim();
    if (SLOT_TAG_RE.test(trimmed)) return trimmed;
    if (trimmed.includes("@")) return accountSlotTag(trimmed);
  }
  return "";
}

function cleanStr(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "";
}

function cleanInt(value, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}

function cleanStatus(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 100 && n <= 599 ? n : null;
}

function cleanMs(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= 3_600_000 ? n : null;
}

function cleanQuota(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeEntry(entry, atMs) {
  if (!entry || typeof entry !== "object") return null;
  const rec = {
    at: new Date(atMs).toISOString(),
    kind: KIND_SET.has(entry.kind) ? entry.kind : "image",
    ok: entry.ok === true,
  };

  const tag = resolveTag(entry.email, entry.tag);
  if (tag) rec.tag = tag;

  const requestId = cleanStr(entry.requestId, 16).toLowerCase();
  if (REQUEST_ID_RE.test(requestId)) rec.requestId = requestId;

  const code = cleanStr(entry.code, 64);
  if (code) rec.code = code;

  const status = cleanStatus(entry.status);
  if (status !== null) rec.status = status;
  const upstreamStatus = cleanStatus(entry.upstreamStatus);
  if (upstreamStatus !== null) rec.upstreamStatus = upstreamStatus;

  const ms = cleanMs(entry.ms);
  if (ms !== null) rec.ms = ms;
  const ttfbMs = cleanMs(entry.ttfbMs);
  if (ttfbMs !== null) rec.ttfbMs = ttfbMs;

  for (const [field, max] of [["lane", 16], ["attempt", 1000], ["n", 100]]) {
    const value = cleanInt(entry[field], max);
    if (value !== null) rec[field] = value;
  }
  if (entry.exploring === true) rec.exploring = true;

  const model = cleanStr(entry.model, 64);
  if (model) rec.model = model;

  const quotaBefore = cleanQuota(entry.quotaBefore);
  if (quotaBefore !== null) rec.quotaBefore = quotaBefore;
  const quotaAfter = cleanQuota(entry.quotaAfter);
  if (quotaAfter !== null) rec.quotaAfter = quotaAfter;

  const reason = cleanStr(entry.reason, 24);
  if (reason) rec.reason = reason;

  const tier = cleanStr(entry.tier, 1);
  if (TIER_SET.has(tier)) rec.tier = tier;

  return rec;
}

/**
 * 记一条请求尝试。`nowMs` 只给测试用（假时间）。
 * 入参不合法返回 null；日志永远不该拖垮请求路径。
 */
export function recordRequest(entry, { nowMs = Date.now() } = {}) {
  const rec = normalizeEntry(entry, nowMs);
  if (!rec) return null;
  seq += 1;
  rec.seq = seq;
  buffer[writeIdx] = rec;
  writeIdx = (writeIdx + 1) % CAPACITY;
  if (stored < CAPACITY) stored += 1;
  return rec;
}

/** 按 seq 升序取出当前 ring 里的全部记录。 */
function orderedEntries() {
  const out = [];
  const start = stored < CAPACITY ? 0 : writeIdx;
  for (let i = 0; i < stored; i++) {
    const item = buffer[(start + i) % CAPACITY];
    if (item) out.push(item);
  }
  return out;
}

/**
 * 增量读取。`since=0` 返回最近 limit 条；`since>0` 返回 seq 更大的条目（升序）。
 * `reset=true` 表示调用方的游标比当前 seq 还新（进程重启 / 清空），前端应清空重来。
 */
export function recentRequests({ since = 0, limit = 100 } = {}) {
  const take = Math.min(Math.max(1, Math.round(Number(limit) || 100)), REQUEST_LOG_MAX_LIMIT);
  const all = orderedEntries();
  const sinceSeq = Number.isFinite(Number(since)) ? Math.max(0, Math.round(Number(since))) : 0;

  let items;
  let reset = false;
  if (sinceSeq > seq) {
    reset = true;
    items = all.slice(-take);
  } else if (sinceSeq > 0) {
    items = all.filter((entry) => entry.seq > sinceSeq).slice(0, take);
  } else {
    items = all.slice(-take);
  }

  return { seq, since: STARTED_AT, pid: PROCESS_PID, reset, items };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * 窗口内聚合：请求数、成功率、在飞、P50/P95/P99、TTFB 分位、按类型/错误码分布。
 * 只统计「已完成」的记录（ring 只存完成态），`inflight` 由 noteInflight 单独维护。
 */
export function requestMetrics({ windowMs = 15 * 60_000, nowMs = Date.now() } = {}) {
  const from = nowMs - Math.max(0, Number(windowMs) || 0);
  const items = orderedEntries().filter((entry) => Date.parse(entry.at) >= from);

  const ok = items.filter((entry) => entry.ok).length;
  const latencies = items
    .filter((entry) => entry.ok && typeof entry.ms === "number")
    .map((entry) => entry.ms)
    .sort((a, b) => a - b);
  const ttfbs = items
    .filter((entry) => entry.ok && typeof entry.ttfbMs === "number")
    .map((entry) => entry.ttfbMs)
    .sort((a, b) => a - b);

  const byKind = {};
  const byCode = {};
  for (const entry of items) {
    const bucket = byKind[entry.kind] || (byKind[entry.kind] = { count: 0, ok: 0, fail: 0 });
    bucket.count += 1;
    if (entry.ok) bucket.ok += 1;
    else bucket.fail += 1;
    if (!entry.ok && entry.code) byCode[entry.code] = (byCode[entry.code] || 0) + 1;
  }

  return {
    windowMs,
    from: new Date(from).toISOString(),
    seq,
    since: STARTED_AT,
    pid: PROCESS_PID,
    count: items.length,
    ok,
    fail: items.length - ok,
    successRate: items.length ? ok / items.length : null,
    inflight,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    ttfbP50: percentile(ttfbs, 0.5),
    ttfbP95: percentile(ttfbs, 0.95),
    byKind,
    byCode,
  };
}

/** 窗口内按账号聚合：请求数、成败、平均耗时。用于面板「活跃度 Top N」。 */
export function accountActivity({ windowMs = 60 * 60_000, top = 20, nowMs = Date.now() } = {}) {
  const from = nowMs - Math.max(0, Number(windowMs) || 0);
  const map = new Map();
  for (const entry of orderedEntries()) {
    if (Date.parse(entry.at) < from || !entry.tag) continue;
    const row = map.get(entry.tag) ||
      { tag: entry.tag, count: 0, ok: 0, fail: 0, totalMs: 0, msCount: 0 };
    row.count += 1;
    if (entry.ok) row.ok += 1;
    else row.fail += 1;
    if (typeof entry.ms === "number") {
      row.totalMs += entry.ms;
      row.msCount += 1;
    }
    map.set(entry.tag, row);
  }
  const rows = [...map.values()].map((row) => ({
    tag: row.tag,
    count: row.count,
    ok: row.ok,
    fail: row.fail,
    avgMs: row.msCount ? Math.round(row.totalMs / row.msCount) : null,
  }));
  rows.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return rows.slice(0, Math.max(1, Math.round(Number(top) || 20)));
}

/** 在飞计数（图片分支用 try/finally 维护）。 */
export function noteInflight(delta) {
  inflight = Math.max(0, inflight + Math.round(Number(delta) || 0));
  return inflight;
}

export function currentInflight() {
  return inflight;
}

/** 清空 ring（不碰账本、不碰 image-errors.jsonl）。seq 归零，前端游标会触发 reset。 */
export function clearRequestLog() {
  buffer.fill(null);
  writeIdx = 0;
  stored = 0;
  seq = 0;
  inflight = 0;
  return true;
}
