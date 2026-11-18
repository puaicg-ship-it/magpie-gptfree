import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  REQUEST_LOG_MAX_LIMIT,
  accountActivity,
  clearRequestLog,
  currentInflight,
  noteInflight,
  recentRequests,
  recordRequest,
  requestMetrics,
} from "../lib/request-log.mjs";
import { forecastExhaustion, poolUtilization } from "../lib/pool-forecast.mjs";
import { accountSlotTag } from "../lib/pool-connection.mjs";

const email = "ring@example.com";
const tag = accountSlotTag(email);

// ring 是模块级单例（整个进程共用一块缓冲），每个用例先清空再断言，
// 否则用例顺序会影响结果。
const reset = () => clearRequestLog();

test("request log never stores a raw email, only the hashed slot tag", () => {
  reset();
  const rec = recordRequest({ kind: "image", email, ok: true, ms: 1200 });
  assert.equal(rec.tag, tag);
  assert.ok(!JSON.stringify(rec).includes("@"), "落进 ring 的记录里不能出现邮箱明文");

  // 直接传 tag 也认，前端回显用得上。
  const byTag = recordRequest({ kind: "image", tag, ok: true });
  assert.equal(byTag.tag, tag);

  // 认不出来的标识一律丢掉，不猜。
  const unknown = recordRequest({ kind: "image", email: "not-an-email", ok: true });
  assert.equal(unknown.tag, undefined);
});

test("unknown and oversized fields are dropped instead of persisted", () => {
  reset();
  const rec = recordRequest({
    kind: "video",            // 不在白名单：落成 image
    email,
    ok: "yes",                // 非 true：落成 false
    code: "x".repeat(200),    // 超长：截断到 64
    ms: 9_999_999,            // 超过 1 小时：丢掉
    ttfbMs: -5,               // 负数：丢掉
    status: 42,               // 不是合法 HTTP 码：丢掉
    upstreamStatus: 200,
    model: "gpt-image-1",
    n: 4,
    attempt: 2,
    secret: "should not survive",
  });
  assert.equal(rec.kind, "image");
  assert.equal(rec.ok, false);
  assert.equal(rec.code.length, 64);
  assert.equal(rec.ms, undefined);
  assert.equal(rec.ttfbMs, undefined);
  assert.equal(rec.status, undefined);
  assert.equal(rec.upstreamStatus, 200);
  assert.equal(rec.model, "gpt-image-1");
  assert.equal(rec.n, 4);
  assert.equal(rec.attempt, 2);
  assert.equal(rec.secret, undefined, "未在白名单里的字段不能被写进 ring");
});

test("seq is monotonic and the since cursor only returns newer entries", () => {
  reset();
  const first = recordRequest({ kind: "image", email, ok: true });
  recordRequest({ kind: "text", email, ok: true });
  recordRequest({ kind: "image", email, ok: false, code: "rate_limited" });

  const all = recentRequests({ limit: 10 });
  assert.equal(all.items.length, 3);
  assert.deepEqual(all.items.map((item) => item.seq), [1, 2, 3]);
  assert.equal(all.reset, false);
  assert.ok(all.since > 0);
  assert.equal(typeof all.pid, "number");

  // 从第一条之后开始拉，只该拿到后两条。
  const tail = recentRequests({ since: first.seq, limit: 10 });
  assert.deepEqual(tail.items.map((item) => item.seq), [2, 3]);
  assert.equal(tail.reset, false);

  // 没有新记录时返回空数组而不是重复推一遍。
  const idle = recentRequests({ since: 3, limit: 10 });
  assert.equal(idle.items.length, 0);
});

// 进程重启后 seq 从 0 重新数，前端手里的游标会比服务端还大。
// 这时候必须回 reset=true 并把最近的整段重发，否则前端会一直等一个永远不来的增量。
test("a cursor newer than the server seq asks the caller to reset", () => {
  reset();
  recordRequest({ kind: "image", email, ok: true });
  recordRequest({ kind: "image", email, ok: true });

  const stale = recentRequests({ since: 99, limit: 10 });
  assert.equal(stale.reset, true);
  assert.equal(stale.items.length, 2, "reset 时要把现有内容整段回给前端");
});

test("limit is clamped to the documented maximum", () => {
  reset();
  // 造够超过上限的量，才能验证「钳到 200」而不是「有多少给多少」。
  for (let i = 0; i < REQUEST_LOG_MAX_LIMIT + 50; i++) {
    recordRequest({ kind: "image", email, ok: true });
  }
  assert.equal(recentRequests({ limit: 1000 }).items.length, REQUEST_LOG_MAX_LIMIT);
  assert.equal(recentRequests({ limit: 5 }).items.length, 5);
  // 0 / NaN 走默认值 100，而不是变成「一条都不要」。
  assert.equal(recentRequests({ limit: 0 }).items.length, 100);
  assert.equal(recentRequests({ limit: "abc" }).items.length, 100);
});

test("metrics only count the window and separate success from failure", () => {
  reset();
  const now = Date.now();
  // 窗口外的记录：用 nowMs 把它顶到 1 小时前。
  recordRequest({ kind: "image", email, ok: false, code: "worker_timeout", ms: 55000 },
    { nowMs: now - 60 * 60_000 });
  recordRequest({ kind: "image", email, ok: true, ms: 4000, ttfbMs: 900 }, { nowMs: now - 2000 });
  recordRequest({ kind: "image", email, ok: true, ms: 6000, ttfbMs: 1100 }, { nowMs: now - 1000 });
  recordRequest({ kind: "text", email, ok: false, code: "rate_limited" }, { nowMs: now });

  const m = requestMetrics({ windowMs: 15 * 60_000, nowMs: now });
  assert.equal(m.count, 3, "1 小时前那条在 15 分钟窗口外");
  assert.equal(m.ok, 2);
  assert.equal(m.fail, 1);
  assert.equal(m.successRate, 2 / 3);
  assert.equal(m.byKind.image.count, 2);
  assert.equal(m.byKind.text.fail, 1);
  assert.equal(m.byCode.rate_limited, 1);
  // 延迟只统计成功的请求：失败那几条没有可比的耗时。
  assert.equal(m.p50, 4000);
  assert.equal(m.p95, 6000);
  assert.equal(m.ttfbP50, 900);
  assert.equal(m.ttfbP95, 1100);
});

test("metrics report null instead of a fake 0% when the window is empty", () => {
  reset();
  const m = requestMetrics({ windowMs: 60_000 });
  assert.equal(m.count, 0);
  assert.equal(m.successRate, null, "没数据时不能说成功率 0%");
  assert.equal(m.p50, null);
  assert.equal(m.p95, null);
});

test("inflight counter never goes negative", () => {
  reset();
  assert.equal(currentInflight(), 0);
  noteInflight(1);
  noteInflight(1);
  assert.equal(currentInflight(), 2);
  noteInflight(-1);
  assert.equal(currentInflight(), 1);
  noteInflight(-5);
  assert.equal(currentInflight(), 0, "多减只归零，不出现负数");
  assert.equal(requestMetrics({ windowMs: 60_000 }).inflight, 0);
});

test("account activity aggregates per slot inside the window and sorts by volume", () => {
  reset();
  const now = Date.now();
  const other = "second@example.com";
  for (let i = 0; i < 3; i++) {
    recordRequest({ kind: "image", email, ok: true, ms: 2000 }, { nowMs: now - 1000 });
  }
  recordRequest({ kind: "image", email: other, ok: false, code: "quota_exhausted" }, { nowMs: now });
  recordRequest({ kind: "image", email: other, ok: true, ms: 9000 }, { nowMs: now });
  // 窗口外的那条不该出现在活跃度里。
  recordRequest({ kind: "image", email: other, ok: true }, { nowMs: now - 3 * 60 * 60_000 });

  const rows = accountActivity({ windowMs: 60 * 60_000, top: 20, nowMs: now });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tag, tag);
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].avgMs, 2000);
  assert.equal(rows[1].count, 2);
  assert.equal(rows[1].ok, 1);
  assert.equal(rows[1].fail, 1);

  assert.equal(accountActivity({ windowMs: 60 * 60_000, top: 1, nowMs: now }).length, 1);
});

test("clearRequestLog wipes the ring and restarts seq", () => {
  reset();
  recordRequest({ kind: "image", email, ok: true });
  recordRequest({ kind: "image", email, ok: true });
  clearRequestLog();
  const after = recentRequests({ limit: 10 });
  assert.equal(after.seq, 0);
  assert.equal(after.items.length, 0);
  assert.equal(currentInflight(), 0);
});

// ---------- 额度耗尽预测 ----------

test("forecast sorts by how soon an account runs dry and drops unusable rows", () => {
  const rows = [
    { slotTag: "s0000000001", imageQuota: 40, etaExhaustMs: 90 * 60_000, burnRatePerHour: 26 },
    { slotTag: "s0000000002", imageQuota: 3, etaExhaustMs: 8 * 60_000, burnRatePerHour: 22 },
    // 下面三种都不该进预测：没有 ETA、额度已空、ETA 非正数。
    { slotTag: "s0000000003", imageQuota: 12, etaExhaustMs: null },
    { slotTag: "s0000000004", imageQuota: 0, etaExhaustMs: 60_000 },
    { slotTag: "s0000000005", imageQuota: 5, etaExhaustMs: -1 },
  ];
  const forecast = forecastExhaustion(rows, { nowMs: 1_700_000_000_000 });
  assert.equal(forecast.count, 2);
  assert.deepEqual(forecast.items.map((item) => item.slotTag), ["s0000000002", "s0000000001"]);
  assert.equal(forecast.items[0].etaExhaustMs, 8 * 60_000);
  assert.equal(forecast.items[0].etaAt, new Date(1_700_000_000_000 + 8 * 60_000).toISOString());
});

test("forecast returns an empty list for junk input instead of throwing", () => {
  assert.equal(forecastExhaustion(null).count, 0);
  assert.equal(forecastExhaustion(undefined).items.length, 0);
  assert.equal(forecastExhaustion([null, 42, "x"]).count, 0);
});

test("pool utilization is null until a quota snapshot exists", () => {
  assert.equal(poolUtilization({}).ratio, null);
  assert.equal(poolUtilization(null).ratio, null);
  const util = poolUtilization({ utilization: { remaining: 30, atCheck: 120 } });
  assert.equal(util.ratio, 0.75);
  assert.equal(util.remaining, 30);
  // 检测后又补了额度：剩余比检测时还多，比率夹到 0 而不是负数。
  assert.equal(poolUtilization({ utilization: { remaining: 200, atCheck: 120 } }).ratio, 0);
});
