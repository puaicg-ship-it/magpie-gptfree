/**
 * 图片文件层：落盘、列表、删除、保留期清理。
 *
 * 图片归插件所有（`MAGPIE_GPTFREE_IMAGE_DIR`，默认容器内 /config/images，
 * 宿主机 /var/www/magpie-images，由 nginx 的 /img/ 对外），所以「有多少张、占多少、
 * 什么时候的、手动腾地方」这些能力都应该由插件提供，而不是让外部脚本去抢同一批文件。
 *
 * 两条硬规则：
 *   1. 任何按名字操作的地方都先过 `resolveImagePath()`：白名单正则 + resolve 后
 *      校验前缀，防止 `../../etc/passwd` 这种（哪怕服务只监听 127.0.0.1）。
 *   2. 删除逐条容错：某张失败不影响其它，ENOENT 当成功（可能刚被 prune 删掉）。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { readImageCleanupWindow, readImageRetentionDays } from "./reply-settings.mjs";

/** 只认我们自己生成的文件名形态。带 `/`、`\`、`..` 的一律过不去。 */
export const IMAGE_NAME_RE = /^[A-Za-z0-9._-]+\.(png|jpg|jpeg|webp|gif)$/i;

const PRUNE_INTERVAL_MS = 3600 * 1000;
// 翻页不该每次都扫目录：1000 张的 readdir+stat 在慢盘上要几百毫秒。
const LIST_TTL_MS = 30 * 1000;
export const MAX_DELETE_PER_REQUEST = 500;

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

let lastPruneAt = 0;
/** 目录扫描缓存：{ at, dir, entries }。写/删之后主动失效。 */
let listCache = null;

export function imageDir() {
  return process.env.MAGPIE_GPTFREE_IMAGE_DIR || "/config/images";
}

export function sniffExt(b64) {
  if (b64.startsWith("iVBORw0KGgo")) return "png";
  if (b64.startsWith("/9j/")) return "jpg";
  if (b64.startsWith("UklGR")) return "webp";
  if (b64.startsWith("R0lGOD")) return "gif";
  return "png";
}

export function mimeOf(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

/**
 * 名字 → 绝对路径。不合法（白名单不过、resolve 后跑出图片目录）返回空串。
 * 所有对外接口都必须先走这里，再碰文件系统。
 */
export function resolveImagePath(name) {
  const clean = String(name ?? "");
  if (!IMAGE_NAME_RE.test(clean)) return "";
  const dir = resolve(imageDir());
  const full = resolve(dir, clean);
  // resolve 之后再比前缀：`..` 之类已经被折叠掉了，比不出界就是真没出界。
  if (full !== join(dir, clean) || !full.startsWith(dir + sep)) return "";
  return full;
}

/** 落盘一张图，返回 { name, url }。base 为空时回相对路径 /img/xxx.png。 */
export async function saveImage(b64, base = "") {
  const name = `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}.${sniffExt(b64)}`;
  const dir = imageDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), Buffer.from(b64, "base64"), { mode: 0o644 });
  invalidateListCache();
  pruneOldImages().catch(() => {});
  return { name, url: base ? `${base}/img/${name}` : `/img/${name}` };
}

export function invalidateListCache() {
  listCache = null;
}

/**
 * 目录里所有图片的 { name, size, mtime }，按 30 秒缓存。
 * `fresh: true` 绕过缓存（删除之后要立刻看到新数字）。
 */
export async function scanImages({ fresh = false } = {}) {
  const dir = imageDir();
  if (!fresh && listCache && listCache.dir === dir && Date.now() - listCache.at < LIST_TTL_MS) {
    return listCache.entries;
  }
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    // 目录还不存在（一张图都没出过）：当空列表，不报错。
    names = [];
  }
  const entries = [];
  await Promise.all(names.filter((name) => IMAGE_NAME_RE.test(name)).map(async (name) => {
    try {
      const info = await stat(join(dir, name));
      if (info.isFile()) entries.push({ name, size: info.size, mtime: Math.round(info.mtimeMs) });
    } catch {
      // 扫到一半被 prune 删了：跳过。
    }
  }));
  entries.sort((a, b) => b.mtime - a.mtime);
  listCache = { at: Date.now(), dir, entries };
  return entries;
}

/** 本地日期的 YYYY-MM-DD。不能用 toISOString：那是 UTC，本地午夜会被算到前一天。 */
function localDayKey(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 14 天（含今天）的每日生成数量，按本地日期切。 */
export function dailyCounts(entries, days = 14, nowMs = Date.now()) {
  const buckets = new Map();
  const oneDay = 86400000;
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    buckets.set(localDayKey(today.getTime() - i * oneDay), 0);
  }
  for (const entry of entries) {
    const key = localDayKey(entry.mtime);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
  }
  return [...buckets].map(([date, count]) => ({ date, count }));
}

function parseBound(value, endOfDay) {
  if (value === undefined || value === null || value === "") return 0;
  const text = String(value).trim();
  // 只给日期（2026-11-15）时：起点取当天 00:00，终点取当天 23:59:59.999。
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const start = new Date(`${text}T00:00:00`);
    if (Number.isNaN(start.getTime())) return 0;
    return endOfDay ? start.getTime() + 86400000 - 1 : start.getTime();
  }
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * 分页列表。sort: time（默认，新的在前）| size（大的在前）。
 * from/to 支持 `YYYY-MM-DD` 或完整时间戳。
 */
export async function listImages({ sort = "time", from = "", to = "", offset = 0, limit = 20 } = {}) {
  const entries = await scanImages();
  const fromMs = parseBound(from, false);
  const toMs = parseBound(to, true);
  const matched = entries.filter((entry) =>
    (!fromMs || entry.mtime >= fromMs) && (!toMs || entry.mtime <= toMs));
  if (sort === "size") matched.sort((a, b) => b.size - a.size || b.mtime - a.mtime);
  else matched.sort((a, b) => b.mtime - a.mtime);

  const start = Math.max(0, Number(offset) || 0);
  const take = Math.min(Math.max(1, Number(limit) || 20), 200);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const matchedBytes = matched.reduce((sum, entry) => sum + entry.size, 0);
  return {
    total: matched.length,
    allCount: entries.length,
    totalBytes,
    matchedBytes,
    earliest: entries.length ? entries[entries.length - 1].mtime : null,
    latest: entries.length ? entries[0].mtime : null,
    daily: dailyCounts(entries),
    items: matched.slice(start, start + take).map(({ name, size, mtime }) => ({ name, size, mtime })),
  };
}

/** 按筛选条件取全部名字（给「全选当前筛选结果」用，不带分页）。 */
export async function listImageNames({ from = "", to = "" } = {}) {
  const entries = await scanImages();
  const fromMs = parseBound(from, false);
  const toMs = parseBound(to, true);
  return entries
    .filter((entry) => (!fromMs || entry.mtime >= fromMs) && (!toMs || entry.mtime <= toMs))
    .map(({ name, size, mtime }) => ({ name, size, mtime }));
}

/**
 * 删除一批图片。逐条容错，ENOENT 算成功（可能刚被 prune 删掉）。
 * 返回 { deleted, failed: [{ name, reason }], skipped: [{ name, reason }] }。
 */
export async function deleteImages(names) {
  const deleted = [];
  const failed = [];
  for (const raw of names) {
    const name = String(raw ?? "");
    const full = resolveImagePath(name);
    if (!full) {
      failed.push({ name: name.slice(0, 120), reason: "文件名不合法，已拒绝" });
      continue;
    }
    try {
      await unlink(full);
      deleted.push(name);
    } catch (err) {
      if (err?.code === "ENOENT") {
        // 已经被 prune 或别的进程删掉了：结果一样，算成功。
        deleted.push(name);
        continue;
      }
      failed.push({ name, reason: String(err?.code || err?.message || err) });
    }
  }
  if (deleted.length) invalidateListCache();
  return { deleted, failed };
}

/** 清理早于 N 天的图片（临时腾地方，不改全局保留天数）。 */
export async function purgeOlderThanDays(days, nowMs = Date.now()) {
  const span = Math.max(1, Math.round(Number(days) || 0)) * 86400000;
  const cutoff = nowMs - span;
  const entries = await scanImages({ fresh: true });
  const targets = entries.filter((entry) => entry.mtime < cutoff).map((entry) => entry.name);
  const { deleted, failed } = await deleteImages(targets);
  return { deleted, failed, cutoff, scanned: targets.length };
}

/**
 * 现在这个时刻落在清理时段里吗。`from > to` 表示跨午夜（22 → 6）。
 * 用本地小时（`getHours()`），跟 `dailyCounts` 的分桶口径一致。
 */
export function inCleanupWindow(nowMs, { from = 0, to = 24 } = {}) {
  const hour = new Date(nowMs).getHours();
  if (from === 0 && to === 24) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * 保留期清理：每小时最多跑一次，且只在「清理时段」内跑。
 *
 * 为什么要有时段：清理本身是 unlink（很快），但要先 readdir + stat 整个目录，
 * 上千张时在慢盘上能吃掉几百毫秒 —— 而生图高峰期恰恰是最频繁触发它的时刻
 * （它是 saveImage 之后顺手跑的）。设成 2-6 点就只在闲置时段扫。
 *
 * 注意「只靠 saveImage 触发」的坑：如果夜里没人用插件，就没有任何调用，
 * 时段一到也不会自己跑。所以 gui-service 另外挂了一个 15 分钟的定时器，
 * 不依赖有没有人生图。
 */
export async function pruneOldImages({ force = false, nowMs = Date.now() } = {}) {
  if (!force && nowMs - lastPruneAt < PRUNE_INTERVAL_MS) {
    return { deleted: 0, skipped: true, reason: "throttle" };
  }
  // 时段外也更新节流时间：否则白天每来一张图就要读一次设置文件问「到点没」。
  // 代价是时段刚开的那一下最多晚一小时，而时段通常有好几个小时。
  lastPruneAt = nowMs;
  const window = await readImageCleanupWindow();
  // force 是手动补跑 / 测试用的，连时段一起绕过。
  if (!force && !inCleanupWindow(nowMs, window)) {
    return { deleted: 0, skipped: true, reason: "window", window: { from: window.from, to: window.to } };
  }
  const { days } = await readImageRetentionDays();
  const cutoff = nowMs - days * 86400000;
  let deleted = 0;
  try {
    for (const name of await readdir(imageDir())) {
      if (!IMAGE_NAME_RE.test(name)) continue;
      const path = join(imageDir(), name);
      try {
        const info = await stat(path);
        // 比的是绝对时间戳对 cutoff，不是「时间差对 cutoff」—— 后者永远不成立。
        if (info.mtimeMs < cutoff) {
          await unlink(path);
          deleted++;
        }
      } catch {}
    }
  } catch {}
  if (deleted) invalidateListCache();
  return { deleted, skipped: false, days, window: { from: window.from, to: window.to } };
}

/**
 * 定时清理：不依赖有没有人生图。15 分钟看一次，时段内 + 过了一小时节流才真的扫。
 * `unref()` 让定时器不拖住进程退出（测试里起几十个服务也不会挂住）。
 */
export const CLEANUP_TICK_MS = 15 * 60 * 1000;
export function startCleanupTimer(tickMs = CLEANUP_TICK_MS) {
  const timer = setInterval(() => { pruneOldImages().catch(() => {}); }, tickMs);
  timer.unref?.();
  return timer;
}
