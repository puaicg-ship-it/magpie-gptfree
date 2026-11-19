/**
 * 池级事件日志（进程内 ring buffer）。
 *
 * 和 `request-log.mjs` 的分工：那边记「一次请求试了谁、多久、谁赢」，
 * 这边记「池子本身发生了什么事」—— 巡检跑了什么、策略什么时候改的、
 * 哪个号因为什么被停/放回。两者的差别不是粒度，是**主语**：一个是请求，
 * 一个是池子。排查「昨天 14 点为什么把那个号停了」时，请求日志里只有一条
 * 失败记录，看不出是巡检判的还是限流判的。
 *
 * 为什么也放内存：和 request-log 一样，快变量、零 I/O、单条 < 200B。
 * 落盘（上游是 pool-events.jsonl）能回溯更久，但要多管一套轮转和清理；
 * 先把「看得见」做出来，真要长期留存再单独加。容量由
 * `MAGPIE_GPTFREE_POOL_EVENT_SIZE` 控制（默认 400 条）。
 *
 * 只在本进程内：热更新时可能新旧两个 host 并存，ring 各记各的，
 * 所以返回的每一批都带 `since`（进程启动时间）和 `pid`，面板要注明
 * 「本进程自 X 起」，不能当成全局历史。
 *
 * 脱敏：只用 `accountSlotTag`（`s<sha256前10位>`），**永不写邮箱明文**；
 * 上游返回的原文只留截断后的短串。
 */
import { accountSlotTag } from "./pool-connection.mjs";

export const POOL_EVENT_DEFAULT_SIZE = 400;
export const POOL_EVENT_MAX_LIMIT = 200;

const STARTED_AT = Date.now();
const PROCESS_PID = process.pid;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CAPACITY = Math.max(50, envInt("MAGPIE_GPTFREE_POOL_EVENT_SIZE", POOL_EVENT_DEFAULT_SIZE));

const SLOT_TAG_RE = /^s[0-9a-f]{10}$/;
const KIND_RE = /^[a-z][a-z0-9._-]{0,31}$/;

// 定长环形缓冲：写入 O(1)，不随容量增长做数组拷贝。
let seq = 0;
let writeIdx = 0;
let stored = 0;
const buffer = new Array(CAPACITY).fill(null);

function cleanStr(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "";
}

function cleanCount(value, max = 100_000) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : null;
}

function resolveTag(emailOrTag, explicitTag) {
  if (typeof explicitTag === "string" && SLOT_TAG_RE.test(explicitTag)) return explicitTag;
  if (typeof emailOrTag === "string") {
    const trimmed = emailOrTag.trim();
    if (SLOT_TAG_RE.test(trimmed)) return trimmed;
    if (trimmed.includes("@")) return accountSlotTag(trimmed);
  }
  return "";
}

/**
 * 记一条池级事件。
 *
 * `kind` 用点分短名（`sweep.run`、`policy.change`、`account.parked`），
 * 面板按前缀分组。入参不合法返回 null —— 日志永远不该拖垮调用方，
 * 巡检和选号都在热路径上。
 */
export function recordPoolEvent(kind, detail = {}, { nowMs = Date.now() } = {}) {
  const name = cleanStr(kind, 32);
  if (!KIND_RE.test(name)) return null;
  const src = detail && typeof detail === "object" ? detail : {};
  const rec = { at: new Date(nowMs).toISOString(), kind: name };

  const tag = resolveTag(src.email, src.tag);
  if (tag) rec.tag = tag;

  const reason = cleanStr(src.reason, 48);
  if (reason) rec.reason = reason;

  for (const field of ["count", "limit", "minutes", "ms"]) {
    const value = cleanCount(src[field]);
    if (value !== null) rec[field] = value;
  }
  if (typeof src.ok === "boolean") rec.ok = src.ok;

  const until = cleanStr(src.until, 32);
  if (until) rec.until = until;

  const strategy = cleanStr(src.strategy, 24);
  if (strategy) rec.strategy = strategy;

  if (Array.isArray(src.keys) && src.keys.length) {
    rec.keys = src.keys
      .map((key) => cleanStr(String(key), 24))
      .filter(Boolean)
      .slice(0, 12);
  }

  buffer[writeIdx] = { ...rec, seq: ++seq };
  writeIdx = (writeIdx + 1) % CAPACITY;
  stored = Math.min(stored + 1, CAPACITY);
  return rec;
}

/**
 * 最近的事件，按时间正序（最老的在前）。
 * `since` 传上一次拿到的最后一条 `at` 时间戳（ms）可以只取增量。
 */
export function recentPoolEvents({ since = 0, limit = 100, kind = "" } = {}) {
  const cap = Math.max(1, Math.min(POOL_EVENT_MAX_LIMIT, Math.round(Number(limit) || 100)));
  const prefix = cleanStr(kind, 32);
  const sinceMs = Number(since) > 0 ? Number(since) : 0;
  const out = [];
  for (let i = 0; i < stored; i++) {
    const idx = (writeIdx - 1 - i + CAPACITY * 2) % CAPACITY;
    const rec = buffer[idx];
    if (!rec) continue;
    if (prefix && !rec.kind.startsWith(prefix)) continue;
    if (sinceMs && Date.parse(rec.at) <= sinceMs) continue;
    out.push(rec);
    if (out.length >= cap) break;
  }
  return out.reverse();
}

export function poolEventStats() {
  return {
    since: new Date(STARTED_AT).toISOString(),
    pid: PROCESS_PID,
    capacity: CAPACITY,
    stored,
    dropped: seq - stored,
  };
}

export function clearPoolEvents() {
  buffer.fill(null);
  writeIdx = 0;
  stored = 0;
  seq = 0;
}
