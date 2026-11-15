#!/usr/bin/env node
// 演示号池：起一个只读的本地 GUI，用假账号 + 假调用记录把六种状态都铺满。
//
// 用途：截图、肉眼验收、样式回归。**不连真实号池、不写任何文件** ——
// poolRead 与 statsStore 都是注入的内存实现，会话也不落盘。
//
//   node scripts/demo-preview.mjs            # 默认 http://127.0.0.1:37991/ui
//   node scripts/demo-preview.mjs 38001      # 指定端口
import { createGuiService } from "../lib/gui-service.mjs";
import { createInMemoryStatsStore } from "../lib/pool-stats.mjs";
import { accountSlotTag } from "../lib/pool-connection.mjs";

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

const service = createGuiService({
  port,
  poolRead: async () => rows,
  statsStore,
});
const addr = await service.listen();
console.log(`演示号池已启动：http://127.0.0.1:${addr.port}/ui`);
console.log("假数据，只读；Ctrl+C 结束。");
