/**
 * 清理日志：什么时候、因为什么、删了多少张、腾了多少地方。
 *
 * 为什么要有它：自动清理是「默默发生」的。图打不开了，用户分不清是被保留期
 * 清掉的、是自己手滑删的、还是压根没生成成功 —— 之前 `pruneOldImages()`
 * 只把 deleted 计数返回给调用方，而最主要的调用方 `saveImage()` 直接把它丢了，
 * 等于一点痕迹都不留。这个模块把那条痕迹补上。
 *
 * 存储：`~/.magpie-gptfree/cleanup-log.jsonl`，一行一条，追加写，0600。
 * 只记数量 / 字节 / 触发方式，**不记文件名** —— 文件名是随机 hash，没有信息量，
 * 记了只会让日志膨胀（一次清理几百个）。
 *
 * 裁剪：每写一条就把文件读一遍，超过 500 条就只留最近 500 条。写日志的频率是
 * 「每次清理一次」（自动清理最多每小时一次，手动删除是人点的），读一个几十 KB
 * 的文件可以忽略；换来的是设置页那个「只留最近 500 条」永远是真的。
 */
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { poolDir } from "./pool-vault.mjs";

export const CLEANUP_LOG_FILE = "cleanup-log.jsonl";
/** 读取接口默认 / 最多返回多少条。 */
export const CLEANUP_LOG_DEFAULT_LIMIT = 50;
export const CLEANUP_LOG_MAX_LIMIT = 500;
/** 文件里最多留多少条，超出的从最旧的开始丢。 */
export const CLEANUP_LOG_MAX_ENTRIES = 500;

/** 触发方式。auto = 保留期定时清理；其余是用户在面板上点的。 */
export const CLEANUP_TRIGGERS = ["auto", "manual-purge", "manual-delete"];

export function cleanupLogFile() {
  return join(poolDir(), CLEANUP_LOG_FILE);
}

function toCount(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeWindow(value) {
  if (!value || typeof value !== "object") return null;
  const from = Number(value.from);
  const to = Number(value.to);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 0 || from > 23 || to < 1 || to > 24) return null;
  return { from, to };
}

function normalizeEntry(entry, atMs) {
  if (!entry || typeof entry !== "object") return null;
  const trigger = CLEANUP_TRIGGERS.includes(entry.trigger) ? entry.trigger : "auto";
  const record = {
    at: new Date(atMs).toISOString(),
    trigger,
    deleted: toCount(entry.deleted),
    bytes: toCount(entry.bytes),
    failed: toCount(entry.failed),
  };
  const days = toCount(entry.days);
  if (days) record.days = days;
  const window = normalizeWindow(entry.window);
  if (window) record.window = window;
  if (entry.note) record.note = String(entry.note).slice(0, 160);
  return record;
}

// 追加和裁剪必须串行：两个 prune 同时跑（saveImage 之后 + 15 分钟定时器）
// 撞在一起时，裁剪可能把刚写进去的那行读漏。
let pending = Promise.resolve();
function exclusive(work) {
  const run = pending.then(work, work);
  pending = run.catch(() => {});
  return run;
}

async function trim(file) {
  let raw;
  try { raw = await readFile(file, "utf8"); } catch { return; }
  const lines = raw.split("\n").filter((line) => line.trim());
  if (lines.length <= CLEANUP_LOG_MAX_ENTRIES) return;
  const kept = lines.slice(-CLEANUP_LOG_MAX_ENTRIES).join("\n") + "\n";
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, kept, { mode: 0o600 });
    await rename(tmp, file);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * 追加一条记录。`nowMs` 只给测试用（假时间）。
 * 返回写入的记录；入参不合法时返回 null，不抛错 —— 日志永远不该拖垮清理。
 */
export async function appendCleanupLog(entry, { nowMs = Date.now() } = {}) {
  const record = normalizeEntry(entry, nowMs);
  if (!record) return null;
  return exclusive(async () => {
    const file = cleanupLogFile();
    try {
      await mkdir(poolDir(), { recursive: true, mode: 0o700 });
      await appendFile(file, JSON.stringify(record) + "\n", { mode: 0o600 });
      await trim(file);
      return record;
    } catch {
      return null;
    }
  });
}

/**
 * 读最近的记录，**新的在前**。`limit` 超出上限时按上限截断。
 * 返回 { total, items }：total 是文件里的总条数，用来告诉用户「只显示了最近 N 条」。
 */
export async function readCleanupLog({ limit = CLEANUP_LOG_DEFAULT_LIMIT } = {}) {
  const take = Math.min(Math.max(1, Math.round(Number(limit) || CLEANUP_LOG_DEFAULT_LIMIT)), CLEANUP_LOG_MAX_LIMIT);
  let raw = "";
  try { raw = await readFile(cleanupLogFile(), "utf8"); }
  catch { return { total: 0, items: [] }; }
  const items = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      // 半截行（写到一半进程被杀）或手改坏的行走这里：跳过，不让整份日志读不出来。
      if (!parsed || typeof parsed !== "object" || typeof parsed.at !== "string") continue;
      items.push(parsed);
    } catch {}
  }
  items.reverse();
  return { total: items.length, items: items.slice(0, take) };
}

/** 清空日志文件。返回删掉了几条，方便面板说「已清空 N 条」。 */
export async function clearCleanupLog() {
  return exclusive(async () => {
    let total = 0;
    try {
      const raw = await readFile(cleanupLogFile(), "utf8");
      total = raw.split("\n").filter((line) => line.trim()).length;
    } catch {}
    await rm(cleanupLogFile(), { force: true }).catch(() => {});
    return total;
  });
}
