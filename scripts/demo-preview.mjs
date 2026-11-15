#!/usr/bin/env node
// 演示号池：起一个只读的本地 GUI，用假账号 + 假调用记录把六种状态都铺满。
//
// 用途：截图、肉眼验收、样式回归。**不连真实号池**：poolRead 与 statsStore 都是注入的
// 内存实现，会话不落盘；图片页要真文件，所以在系统临时目录里造一批假图（退出时删掉），
// 绝不会碰 ~/.magpie-gptfree 和 /config/images。
//
//   node scripts/demo-preview.mjs            # 默认 http://127.0.0.1:37991/ui
//   node scripts/demo-preview.mjs 38001      # 指定端口
import { createGuiService } from "../lib/gui-service.mjs";
import { createInMemoryStatsStore } from "../lib/pool-stats.mjs";
import { accountSlotTag } from "../lib/pool-connection.mjs";
import { deflateSync } from "node:zlib";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.argv[2]) || 37991;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const daysAgo = (n) => iso(now - n * 86400000);

// 结构完整、签名是假的 JWT：只为让本地解码出 exp，不会发给任何上游。
function fakeToken(expMs) {
  return [
    Buffer.from('{"alg":"RS256"}').toString("base64url"),
    Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64url"),
    "demo-signature",
  ].join(".");
}
const validToken = fakeToken(now + 3600_000);
const expiredToken = fakeToken(now - 3600_000);

const demo = [
  { email: "alpha.demo@gmail.com", quota: 18, plan: "plus", success: 42, fail: 1 },
  { email: "bravo.demo@gmail.com", quota: 25, plan: "plus", success: 31, fail: 0 },
  { email: "charlie.demo@gmail.com", quota: 12, plan: "free", success: 27, fail: 2 },
  { email: "delta.demo@gmail.com", quota: 31, plan: "plus", success: 18, fail: 0 },
  { email: "echo.demo@gmail.com", quota: 9, plan: "free", success: 14, fail: 3 },
  { email: "foxtrot.demo@gmail.com", quota: 6, plan: "free", success: 9, fail: 1 },
  { email: "golf.demo@gmail.com", quota: 14, plan: "plus", success: 7, fail: 0 },
  { email: "hotel.demo@gmail.com", quota: 22, plan: "plus", success: 5, fail: 0 },
  { email: "india.demo@gmail.com", quota: 0, plan: "free", success: 11, fail: 4, limited: true },
  { email: "juliett.demo@gmail.com", quota: 0, plan: "free", success: 3, fail: 2, limited: true },
  { email: "kilo.demo@gmail.com", quota: null, plan: null, success: 0, fail: 0 },
  { email: "lima.demo@gmail.com", quota: null, plan: null, success: 0, fail: 0 },
  { email: "mike.demo@gmail.com", quota: null, plan: "plus", success: 0, fail: 0, quotaError: "查询 ChatGPT Web 生图额度失败：connect ETIMEDOUT" },
  { email: "november.demo@gmail.com", quota: 16, plan: "plus", success: 8, fail: 0, expired: true },
  { email: "oscar.demo@gmail.com", quota: 0, plan: "free", success: 0, fail: 0, deadAt: daysAgo(2), authFails: 3 },
  { email: "papa.demo@gmail.com", quota: 0, plan: "free", success: 0, fail: 15, never: true },
];

const rows = demo.map((a, i) => ({
  email: a.email,
  accessToken: a.expired ? expiredToken : validToken,
  updatedAt: daysAgo(i % 3),
  line: i + 1,
}));

const statsStore = createInMemoryStatsStore();
statsStore.state.totals = { successCalls: 0, failCalls: 0 };
for (const a of demo) {
  const tag = accountSlotTag(a.email);
  const checkedAt = daysAgo(0);
  const entry = {
    planType: a.plan,
    imageQuota: a.quota,
    quotaCheckedAt: a.quota === null && !a.quotaError ? null : checkedAt,
    quotaError: a.quotaError || null,
    successCalls: a.success,
    failCalls: a.fail,
    lastSuccessAt: a.success ? daysAgo(1) : null,
    lastUsedAt: a.success ? daysAgo(1) : null,
    lastErrorCode: a.fail ? "rate_limited" : null,
    lastErrorAt: a.fail ? daysAgo(1) : null,
    limitedAt: a.limited ? daysAgo(0) : null,
    limitedUntil: a.limited ? iso(now + 3 * 3600_000) : null,
    limitedForMs: a.limited ? 3600_000 : null,
    deadAt: a.deadAt || null,
    authFails: a.authFails || 0,
    failSince: a.never ? daysAgo(5) : null,
  };
  statsStore.state.accounts[tag] = entry;
  statsStore.state.totals.successCalls += a.success;
  statsStore.state.totals.failCalls += a.fail;
}

// 近 14 天的调用记录：数字有起伏，柱顶才看得出效果。
const history = {};
for (let i = 13; i >= 0; i--) {
  const d = new Date(now - i * 86400000);
  const key = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  const success = [18, 24, 31, 12, 0, 9, 27, 34, 41, 22, 16, 38, 44, 29][13 - i];
  const fail = [2, 1, 4, 0, 0, 3, 1, 2, 6, 1, 0, 2, 3, 1][13 - i];
  history[key] = {
    success,
    fail,
    textSuccess: Math.round(success * 0.4),
    textFail: Math.round(fail * 0.3),
    byCode: fail ? { rate_limited: Math.max(1, fail - 1), worker_timeout: 1 } : {},
  };
}
statsStore.state.history = history;

// ---------- 假图片 ----------
// 图片页要真文件才有缩略图，所以现造几张纯色 PNG（不引任何依赖，手工拼 PNG 分块）。
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function solidPng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3;
      // 加点斜向渐变，缩略图排在一起才不糊成一片
      const t = (x + y) / (width + height);
      raw[at] = Math.round(r * (0.65 + t * 0.35));
      raw[at + 1] = Math.round(g * (0.65 + t * 0.35));
      raw[at + 2] = Math.round(b * (0.65 + t * 0.35));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PALETTE = [
  [15, 110, 86], [59, 109, 17], [49, 119, 217], [168, 84, 24],
  [122, 90, 168], [13, 106, 128], [176, 58, 92], [90, 100, 120],
];
const imageHome = await mkdtemp(join(tmpdir(), "gptfree-demo-"));
const imageDir = join(imageHome, "images");
const homeDir = join(imageHome, "home");
process.env.MAGPIE_GPTFREE_IMAGE_DIR = imageDir;
// 面板设置也指到临时目录：截图时点「保留天数」不会写进真实的 ~/.magpie-gptfree。
process.env.MAGPIE_GPTFREE_HOME = homeDir;
await mkdir(imageDir, { recursive: true });
for (let i = 0; i < 34; i++) {
  // 摊到近 14 天：今天的多几张，看起来才像真的在出图
  const daysBack = Math.min(13, Math.floor(i / 3));
  const mtime = now - daysBack * 86400000 - (i % 7) * 3600_000;
  const name = `${mtime.toString(36)}-${String(i).padStart(16, "0")}.png`;
  const size = 96 + (i % 5) * 32;
  const file = join(imageDir, name);
  await writeFile(file, solidPng(size, size, PALETTE[i % PALETTE.length]));
  await utimes(file, new Date(mtime), new Date(mtime));
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await rm(imageHome, { recursive: true, force: true });
    process.exit(0);
  });
}

const service = createGuiService({
  port,
  poolRead: async () => rows,
  statsStore,
});
const addr = await service.listen();
console.log(`演示号池已启动：http://127.0.0.1:${addr.port}/ui`);
console.log("假数据，只读；Ctrl+C 结束。");
