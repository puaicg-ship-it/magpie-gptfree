/**
 * 生图错误日志：什么时候、哪个号、什么错、上游到底说了什么。
 *
 * 为什么要有它：`pool-stats.json` 每个账号只留**最后一次**失败的 code 和原文，
 * 一个号失败第二次就把第一次覆盖掉了。而排查「上游只回了文字」这类问题时，
 * 最值钱的恰恰是那串被丢掉的原文 —— 到底是限流、额度用尽、还是封号，
 * 只有上游自己那句话说得清。
 *
 * 存储：`~/.magpie-gptfree/image-errors.jsonl`，一行一条，追加写，0600。
 * 只记失败（成功的没什么可排查的）。一行有两种 `kind`：
 *
 *   account —— 单个账号的一次失败
 *   { at, kind:"account", code, tag, status, upstreamStatus, message }
 *
 *   request —— 一次客户端请求的汇总（只在整单失败时写一条）
 *   { at, kind:"request", code, requestId, status, upstreamStatus,
 *     attempted, poolSize, skipped, ms, message }
 *
 * 为什么要 request 那条：池子里 20 个号，55 秒预算只够试 7 个，剩下 13 个
 * **根本没轮到**。只记 account 的话，「没轮到」和「试了失败」长得一模一样，
 * 会把一次预算耗尽误读成「全部号都挂了」。
 *
 * 两个 status 别混：
 * - `status` 是我们归一化后给客户端看的（上游回文字时是 502）；
 * - `upstreamStatus` 是上游**真实**返回的（这种情况通常是 200 —— 流是好的，
 *   只是内容不是图）。只写 `status` 会让人以为上游网关挂了。
 *
 * 脱敏：`tag` 是 `s<sha256前10位>`（`accountSlotTag`），**永远不落邮箱明文**；
 * `message` 走 `sanitizeStatsMessage`，JWT / 邮箱 / URL 都会被替换掉再截断。
 *
 * 裁剪：每写一条读一遍文件，超过 500 条只留最近 500 条。写日志的频率是
 * 「每次账号失败一次」，读几十 KB 的文件可以忽略；换来的是「只留最近 500 条」
 * 永远是真的，不会哪天把磁盘写满。
 */
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accountSlotTag } from "./pool-connection.mjs";
import { sanitizeStatsMessage } from "./pool-stats.mjs";
import { poolDir } from "./pool-vault.mjs";

export const IMAGE_ERROR_LOG_FILE = "image-errors.jsonl";
/** 读取接口默认 / 最多返回多少条。 */
export const IMAGE_ERROR_LOG_DEFAULT_LIMIT = 50;
export const IMAGE_ERROR_LOG_MAX_LIMIT = 500;
/** 文件里最多留多少条，超出的从最旧的开始丢。 */
export const IMAGE_ERROR_LOG_MAX_ENTRIES = 500;
/** 原文截断长度。比账本里的 180 宽松些，排查时多几个字往往就是关键。 */
export const IMAGE_ERROR_LOG_MESSAGE_LIMIT = 240;

/** 一条记录是「单个账号的失败」还是「一次请求的汇总」。 */
export const IMAGE_ERROR_LOG_KINDS = ["account", "request"];

const SLOT_TAG_RE = /^s[0-9a-f]{10}$/;
const REQUEST_ID_RE = /^[0-9a-f]{6,16}$/;

export function imageErrorLogFile() {
  return join(poolDir(), IMAGE_ERROR_LOG_FILE);
}

/** 只认 `s<10位hex>` 或邮箱；别的（空串、乱码）一律当「没有账号」处理。 */
function resolveTag(emailOrTag, explicitTag) {
  if (typeof explicitTag === "string" && SLOT_TAG_RE.test(explicitTag)) return explicitTag;
  if (typeof emailOrTag === "string") {
    const trimmed = emailOrTag.trim();
    if (SLOT_TAG_RE.test(trimmed)) return trimmed;
    if (trimmed.includes("@")) return accountSlotTag(trimmed);
  }
  return "";
}

function countOf(value, max = 100_000) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}

function statusOf(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 100 && n <= 599 ? n : null;
}

function normalizeEntry(entry, atMs) {
  if (!entry || typeof entry !== "object") return null;
  const code = typeof entry.code === "string" ? entry.code.trim().slice(0, 64) : "";
  // 没有错误码的行对排查没有意义，直接不写 —— 免得日志里全是空壳。
  if (!code) return null;

  const kind = IMAGE_ERROR_LOG_KINDS.includes(entry.kind) ? entry.kind : "account";
  const record = { at: new Date(atMs).toISOString(), kind, code };

  if (kind === "request") {
    const requestId = typeof entry.requestId === "string" ? entry.requestId.trim().toLowerCase() : "";
    if (REQUEST_ID_RE.test(requestId)) record.requestId = requestId;
    for (const [field, max] of [["attempted", 1000], ["poolSize", 1000], ["skipped", 1000], ["ms", 3_600_000]]) {
      const value = countOf(entry[field], max);
      if (value !== null) record[field] = value;
    }
  } else {
    const tag = resolveTag(entry.email, entry.tag);
    if (tag) record.tag = tag;
    const requestId = typeof entry.requestId === "string" ? entry.requestId.trim().toLowerCase() : "";
    if (REQUEST_ID_RE.test(requestId)) record.requestId = requestId;
  }

  const status = statusOf(entry.status);
  if (status !== null) record.status = status;
  // 上游真实状态码：和 status 并存，两个都有才看得出「谁编的谁是真的」。
  const upstreamStatus = statusOf(entry.upstreamStatus);
  if (upstreamStatus !== null) record.upstreamStatus = upstreamStatus;

  const message = sanitizeStatsMessage(entry.message, IMAGE_ERROR_LOG_MESSAGE_LIMIT);
  if (message) record.message = message;

  return record;
}

// 追加和裁剪必须串行：并发失败（一次请求里 18 个号接连挂）撞在一起时，
// 裁剪可能把刚写进去的那行读漏。
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
  if (lines.length <= IMAGE_ERROR_LOG_MAX_ENTRIES) return;
  const kept = lines.slice(-IMAGE_ERROR_LOG_MAX_ENTRIES).join("\n") + "\n";
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, kept, { mode: 0o600 });
    await rename(tmp, file);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * 追加一条失败记录。`nowMs` 只给测试用（假时间）。
 * 返回写入的记录；入参不合法时返回 null，不抛错 —— 日志永远不该拖垮生图。
 */
export async function appendImageErrorLog(entry, { nowMs = Date.now() } = {}) {
  const record = normalizeEntry(entry, nowMs);
  if (!record) return null;
  return exclusive(async () => {
    const file = imageErrorLogFile();
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
export async function readImageErrorLog({ limit = IMAGE_ERROR_LOG_DEFAULT_LIMIT } = {}) {
  const take = Math.min(
    Math.max(1, Math.round(Number(limit) || IMAGE_ERROR_LOG_DEFAULT_LIMIT)),
    IMAGE_ERROR_LOG_MAX_LIMIT,
  );
  let raw = "";
  try { raw = await readFile(imageErrorLogFile(), "utf8"); }
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
export async function clearImageErrorLog() {
  return exclusive(async () => {
    let total = 0;
    try {
      const raw = await readFile(imageErrorLogFile(), "utf8");
      total = raw.split("\n").filter((line) => line.trim()).length;
    } catch {}
    await rm(imageErrorLogFile(), { force: true }).catch(() => {});
    return total;
  });
}
