/**
 * 导入批次：把「一次导入」当成一个可命名的单位。
 *
 * 为什么需要它：以前账号库里每条只有 email/password/totp/accessToken/updatedAt，
 * 一次导入 37 个号就是 37 次独立写入，彼此之间没有任何关联 —— 既说不出「这个号是
 * 哪天进来的」，也说不出「这批号整体表现怎么样」。而买号是一批一批买的，不同批次
 * 的质量差别很大，这个信息在数据里完全不存在。
 *
 * 两个文件分工：
 *   - `pool.enc.json`（加密）：每条账号上带 `addedAt` + `batchId`。**必须加密**，
 *     因为它是账号记录的一部分。
 *   - `batches.json`（明文）：只放批次元数据（标签、导入时间、条数、来源），
 *     不含任何凭证。放明文是为了能在日志/面板里直接看，不用解一次密。
 *
 * `batchId` 设计成**可按字符串排序**：`b` + UTC 的 yyyymmddHHMMSS + `-` + 4 位随机。
 * 这样「哪个批次更新」不需要读 batches.json，光比较 id 就知道 —— 权重计算在热路径上，
 * 不能为了排个序去读文件。legacy 用全 0 的时间戳，天然排在所有真实批次之后（最旧）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { poolDir } from "./pool-vault.mjs";

/** 0.10.x 之前导入的号没有批次信息，统一归到这一个（时间未知）。 */
export const LEGACY_BATCH_ID = "b00000000000000";
export const LEGACY_BATCH_LABEL = "历史批次";

const BATCH_ID_RE = /^b\d{14}(?:-[0-9a-f]{4})?$/;
const MAX_BATCHES = 200;
const MAX_LABEL = 60;

export const LEGACY_BATCH = Object.freeze({
  id: LEGACY_BATCH_ID,
  label: LEGACY_BATCH_LABEL,
  importedAt: null,
  count: 0,
  source: "legacy",
});

function batchesFile({ file } = {}) {
  return file || join(poolDir(), "batches.json");
}

/** `b20261118105437-3f2a`。UTC 时间戳保证跨时区也能正确排序。 */
export function newBatchId(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = [
    d.getUTCFullYear(), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()),
    pad(d.getUTCHours()), pad(d.getUTCMinutes()), pad(d.getUTCSeconds()),
  ].join("");
  return `b${stamp}-${randomBytes(2).toString("hex")}`;
}

export function isBatchId(value) {
  return typeof value === "string" && BATCH_ID_RE.test(value);
}

/** 账号上的批次号；没有 / 不合法一律当历史批次，绝不返回空。 */
export function batchIdOf(record) {
  const id = record?.batchId;
  return isBatchId(id) ? id : LEGACY_BATCH_ID;
}

/** 新的在前。字符串比较就够了，不需要解析时间。 */
export function sortBatchIds(ids) {
  return [...new Set(ids.filter(isBatchId))].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/**
 * 批次排名表：`batchId → 0(最新) / 1 / 2 …`。
 *
 * 权重计算只需要「这个批次是第几新的」，不需要知道具体时间，所以排名在选号时
 * 从账号数组现算一次就够，不必读 batches.json。
 */
export function batchRankMap(accounts) {
  const ids = sortBatchIds((Array.isArray(accounts) ? accounts : []).map((a) => batchIdOf(a)));
  return new Map(ids.map((id, index) => [id, index]));
}

function cleanLabel(value) {
  return String(value ?? "")
    // 标签会进面板和日志：去掉控制字符，压掉连续空白。
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL);
}

/** 默认标签：「2026-11-18 10:54 · 37 个」。用本地时间，和面板其他地方一致。 */
export function defaultBatchLabel(importedAtMs, count) {
  const d = new Date(importedAtMs);
  if (Number.isNaN(d.getTime())) return `${count} 个`;
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return count > 0 ? `${stamp} · ${count} 个` : stamp;
}

function normalizeBatch(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (!isBatchId(entry.id)) return null;
  const importedMs = Date.parse(entry.importedAt || "");
  return {
    id: entry.id,
    label: cleanLabel(entry.label) || entry.id,
    importedAt: Number.isFinite(importedMs) ? new Date(importedMs).toISOString() : null,
    count: Math.max(0, Math.round(Number(entry.count) || 0)),
    source: cleanLabel(entry.source) || "",
  };
}

/** 读批次表。文件不存在 / 坏掉都当空表 —— 批次信息缺失不该影响出图。 */
export async function readBatches({ file } = {}) {
  let raw;
  try {
    raw = await readFile(batchesFile({ file }), "utf8");
  } catch {
    return { version: 1, batches: [] };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { version: 1, batches: [] }; }
  const list = Array.isArray(parsed?.batches) ? parsed.batches : [];
  const batches = [];
  const seen = new Set();
  for (const entry of list) {
    const item = normalizeBatch(entry);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    batches.push(item);
    if (batches.length >= MAX_BATCHES) break;
  }
  return { version: 1, batches };
}

/**
 * 写一条批次（同 id 覆盖）。原子写 + 0600。
 *
 * 只保留最近 MAX_BATCHES 条：批次元数据是给人看的，不是账本，没必要无限增长。
 * 裁剪按 id 排序（新的留），而不是按写入顺序 —— 补录旧批次时顺序才不会被搞乱。
 */
export async function recordBatch(
  { id, label, importedAt = new Date().toISOString(), count = 0, source = "" } = {},
  { file } = {},
) {
  if (!isBatchId(id)) return { ok: false, reason: "invalid_id" };
  const target = batchesFile({ file });
  const current = await readBatches({ file });
  const item = normalizeBatch({ id, label, importedAt, count, source });
  if (!item) return { ok: false, reason: "invalid_batch" };
  const kept = current.batches.filter((entry) => entry.id !== item.id);
  kept.push(item);
  const batches = kept
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, MAX_BATCHES);

  await mkdir(poolDir(), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, batches }, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, target);
  return { ok: true, batch: item };
}

/**
 * 按批次聚合账号表现：几个号、几个可用、剩多少额度、成功/失败各多少。
 *
 * 这是「批次权重该往哪调」的判断依据 —— 面板上看到某个批次的成功率明显偏低，
 * 就该去调 BATCH_RECENCY_BONUS 或者干脆把那批撤掉，而不是等单号熔断慢慢发现。
 */
export function summarizeBatches(rows, stored) {
  const buckets = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = batchIdOf(row);
    const bucket = buckets.get(id) || {
      id, accounts: 0, usable: 0, limited: 0, dead: 0, quota: 0, success: 0, fail: 0,
    };
    bucket.accounts += 1;
    if (row.deadReason) bucket.dead += 1;
    else if (row.quotaStatus === "available") bucket.usable += 1;
    else if (row.quotaStatus === "limited") bucket.limited += 1;
    if (typeof row.imageQuota === "number") bucket.quota += row.imageQuota;
    bucket.success += Number(row.successCalls) || 0;
    bucket.fail += Number(row.failCalls) || 0;
    buckets.set(id, bucket);
  }
  const meta = new Map((stored?.batches || []).map((entry) => [entry.id, entry]));
  return sortBatchIds([...buckets.keys()]).map((id) => {
    const bucket = buckets.get(id);
    const info = meta.get(id);
    const calls = bucket.success + bucket.fail;
    return {
      ...bucket,
      label: info?.label || (id === LEGACY_BATCH_ID ? LEGACY_BATCH_LABEL : id),
      importedAt: info?.importedAt || null,
      source: info?.source || "",
      // 没调用过就是 null，不是 0% —— 「还没跑过」和「跑一次败一次」是两件事。
      successRate: calls > 0 ? bucket.success / calls : null,
    };
  });
}

/** 给面板用：把账号实际用到的批次（含 legacy）和元数据合起来，缺元数据的补占位。 */
export function mergeBatchView(accounts, stored) {
  const used = new Set((Array.isArray(accounts) ? accounts : []).map((a) => batchIdOf(a)));
  const byId = new Map((stored?.batches || []).map((entry) => [entry.id, entry]));
  const out = [];
  for (const id of sortBatchIds([...used])) {
    const meta = byId.get(id);
    out.push(meta || {
      id,
      label: id === LEGACY_BATCH_ID ? LEGACY_BATCH_LABEL : id,
      importedAt: null,
      count: 0,
      source: id === LEGACY_BATCH_ID ? "legacy" : "",
    });
  }
  return out;
}
