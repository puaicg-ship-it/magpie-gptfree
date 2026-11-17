import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMAGE_ERROR_LOG_MAX_ENTRIES,
  IMAGE_ERROR_LOG_MESSAGE_LIMIT,
  appendImageErrorLog,
  clearImageErrorLog,
  imageErrorLogFile,
  readImageErrorLog,
} from "../lib/image-error-log.mjs";
import { CODEX_BASE, poolFetch } from "../lib/codex-pool.mjs";

/** 一个「没过期」的假 token，够让池子跳过重新登录。 */
function jwt(delta, email = "a@example.com") {
  return [
    Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url"),
    Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + delta,
      email,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct123" },
    })).toString("base64url"),
    "signature",
  ].join(".");
}

/** 临时 home：日志落这里，不碰真实的 ~/.magpie-gptfree。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gptfree-image-error-log-"));
  process.env.MAGPIE_GPTFREE_HOME = join(root, "home");
  return root;
}

function cleanup(root) {
  delete process.env.MAGPIE_GPTFREE_HOME;
  return rm(root, { recursive: true, force: true });
}

test("生图错误日志：追加后新的在前，字段被归一化", async () => {
  const root = await fixture();
  try {
    const at = Date.parse("2026-11-16T02:00:00");
    await appendImageErrorLog({
      email: "someone@example.com",
      code: "upstream_text_reply",
      status: 502,
      message: "图片生成功能暂时不可用。输出尺寸要求：1024 × 1024。",
    }, { nowMs: at });

    // 没有 code 的行不写；status 越界丢掉；tag 不合法丢掉；message 里带 token 要脱敏。
    await appendImageErrorLog({ code: "", status: 200, message: "x" }, { nowMs: at + 1000 });
    assert.equal(await appendImageErrorLog({ code: "   " }), null);
    assert.equal(await appendImageErrorLog(null), null);

    await appendImageErrorLog({
      tag: "not-a-tag",
      code: "upstream_rate_limited",
      status: 999,
      message: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefg",
    }, { nowMs: at + 2000 });

    const { total, items } = await readImageErrorLog({ limit: 10 });
    assert.equal(total, 2, "没有 code 的两条都不该写进去");

    // 新的在前
    assert.equal(items[0].code, "upstream_rate_limited");
    assert.equal(items[0].status, undefined, "越界状态码丢掉");
    assert.equal(items[0].tag, undefined, "不合法的 tag 不落盘");
    assert.match(items[0].message, /\[redacted-token\]/);
    assert.doesNotMatch(items[0].message, /eyJhbGciOiJIUzI1NiJ9/);

    assert.equal(items[1].code, "upstream_text_reply");
    assert.equal(items[1].status, 502);
    assert.equal(items[1].at, new Date(at).toISOString());
    // 邮箱必须变成 slot tag（s + sha256 前 10 位），不能留明文。
    assert.match(items[1].tag, /^s[0-9a-f]{10}$/);
    assert.equal(items[1].message, "图片生成功能暂时不可用。输出尺寸要求：1024 × 1024。");

    // limit 生效，total 仍是全量。
    const limited = await readImageErrorLog({ limit: 1 });
    assert.equal(limited.items.length, 1);
    assert.equal(limited.total, 2);

    // 文件里绝不能出现邮箱明文。
    const raw = await readFile(imageErrorLogFile(), "utf8");
    assert.doesNotMatch(raw, /someone@example\.com/);
  } finally {
    await cleanup(root);
  }
});

test("生图错误日志：原文超长截断，换行压平", async () => {
  const root = await fixture();
  try {
    const long = "上游报错\r\n" + "啊".repeat(500);
    await appendImageErrorLog({ code: "upstream_banned", message: long });
    const { items } = await readImageErrorLog({ limit: 5 });
    assert.equal(items[0].message.length, IMAGE_ERROR_LOG_MESSAGE_LIMIT);
    assert.doesNotMatch(items[0].message, /[\r\n]/);
  } finally {
    await cleanup(root);
  }
});

test("生图错误日志：超过上限只留最近 500 条", async () => {
  const root = await fixture();
  try {
    const file = imageErrorLogFile();
    await mkdir(join(root, "home"), { recursive: true });
    const lines = [];
    for (let i = 0; i < IMAGE_ERROR_LOG_MAX_ENTRIES + 20; i++) {
      lines.push(JSON.stringify({
        at: new Date(Date.parse("2026-01-01T00:00:00") + i * 1000).toISOString(),
        code: "worker_timeout",
        n: i,
      }));
    }
    await writeFile(file, lines.join("\n") + "\n");

    await appendImageErrorLog({ code: "upstream_text_reply", message: "最新那条" }, {
      nowMs: Date.parse("2026-02-01T00:00:00"),
    });

    const raw = await readFile(file, "utf8");
    assert.equal(raw.split("\n").filter(Boolean).length, IMAGE_ERROR_LOG_MAX_ENTRIES);

    const { total, items } = await readImageErrorLog({ limit: IMAGE_ERROR_LOG_MAX_ENTRIES });
    assert.equal(total, IMAGE_ERROR_LOG_MAX_ENTRIES);
    assert.equal(items[0].code, "upstream_text_reply", "最新那条必须在");
    // 521 条裁到 500：最旧的 21 条（n 0–20）被丢掉，剩下的最旧一条是 21。
    assert.equal(items[items.length - 1].n, 21);
  } finally {
    await cleanup(root);
  }
});

test("生图错误日志：坏行跳过，不影响整份读取", async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, "home"), { recursive: true });
    const file = imageErrorLogFile();
    await writeFile(file, [
      JSON.stringify({ at: "2026-11-16T02:00:00.000Z", code: "upstream_text_reply" }),
      "{半截行",
      JSON.stringify({ code: "no-at-field" }),
      JSON.stringify({ at: "2026-11-16T02:01:00.000Z", code: "worker_timeout" }),
    ].join("\n") + "\n");

    const { total, items } = await readImageErrorLog({ limit: 10 });
    assert.equal(total, 2);
    assert.equal(items[0].code, "worker_timeout");
    assert.equal(items[1].code, "upstream_text_reply");
  } finally {
    await cleanup(root);
  }
});

test("生图错误日志：整单记录带请求号、尝试数与未尝试数", async () => {
  const root = await fixture();
  try {
    const at = Date.parse("2026-11-16T03:00:00");
    await appendImageErrorLog({
      kind: "request",
      requestId: "A1B2C3D4",
      code: "request_timeout",
      status: 504,
      attempted: 7,
      poolSize: 23,
      skipped: 16,
      ms: 55123,
      message: "生图超时：55 秒内没有账号完成生成",
    }, { nowMs: at });

    // 非法值一律丢掉：请求号不是 hex、计数是负数/超范围、耗时离谱。
    await appendImageErrorLog({
      kind: "request",
      requestId: "not-hex!",
      code: "request_failed",
      attempted: -1,
      poolSize: "x",
      skipped: 9_999_999,
      ms: 1e12,
    }, { nowMs: at + 1000 });

    const { items } = await readImageErrorLog({ limit: 10 });
    assert.equal(items.length, 2);

    const full = items[1];
    assert.equal(full.kind, "request");
    assert.equal(full.requestId, "a1b2c3d4", "请求号统一小写，方便和账号记录对上");
    assert.equal(full.code, "request_timeout");
    assert.equal(full.status, 504);
    assert.equal(full.attempted, 7);
    assert.equal(full.poolSize, 23);
    assert.equal(full.skipped, 16);
    assert.equal(full.ms, 55123);

    const dirty = items[0];
    assert.equal(dirty.kind, "request");
    assert.equal(dirty.requestId, undefined, "不是 hex 的请求号不落盘");
    assert.equal(dirty.attempted, undefined, "负数丢掉");
    assert.equal(dirty.poolSize, undefined, "非数字丢掉");
    assert.equal(dirty.skipped, undefined, "超范围丢掉");
    assert.equal(dirty.ms, undefined, "离谱的耗时丢掉");
  } finally {
    await cleanup(root);
  }
});

test("生图错误日志：不写 kind 时按单账号记录处理", async () => {
  const root = await fixture();
  try {
    await appendImageErrorLog({ tag: "s3f9a1c2d4e", code: "upstream_unavailable", status: 502, upstreamStatus: 200 });
    const { items } = await readImageErrorLog({ limit: 5 });
    assert.equal(items[0].kind, "account");
    assert.equal(items[0].tag, "s3f9a1c2d4e");
    assert.equal(items[0].status, 502);
    assert.equal(items[0].upstreamStatus, 200, "上游真实码要单独留住");
  } finally {
    await cleanup(root);
  }
});

test("生图错误日志：清空返回条数，之后读取是空", async () => {
  const root = await fixture();
  try {
    await appendImageErrorLog({ code: "upstream_text_reply", message: "a" });
    await appendImageErrorLog({ code: "upstream_rate_limited", message: "b" });
    assert.equal(await clearImageErrorLog(), 2);
    assert.deepEqual(await readImageErrorLog(), { total: 0, items: [] });
    // 没有文件时再清一次也不能报错。
    assert.equal(await clearImageErrorLog(), 0);
  } finally {
    await cleanup(root);
  }
});

test("生图失败真的会落日志：走 poolFetch 全链路，上游原文进文件", async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, "home"), { recursive: true });
    const statsFile = join(root, "home", "pool-stats.json");
    const account = { email: "a@example.com", accessToken: jwt(3600) };

    const res = await poolFetch(CODEX_BASE + "/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-image-2", prompt: "a cat" }),
    }, {
      read: async () => [account],
      statsFile,
      runWorker: async () => ({
        ok: false,
        http_status: 502,
        // 上游真实返回的是 200：流是好的，只是内容不是图。这个码要单独留住。
        upstream_status: 200,
        error_code: "upstream_text_reply",
        error: "图片生成功能暂时不可用。输出尺寸要求：1024 × 1024。",
      }),
    });

    // 单账号、上游 502 → 池子走完所有号后统一抛 503（最近原因里带着上游那句话）。
    assert.equal(res.status, 503);
    assert.match((await res.json()).error.message, /图片生成功能暂时不可用/);

    // 一次失败写两条：账号那条（谁、什么错、上游原话）+ 整单那条（试了几个号）。
    const { total, items } = await readImageErrorLog({ limit: 10 });
    assert.equal(total, 2);
    const request = items.find((e) => e.kind === "request");
    const accountEntry = items.find((e) => e.kind === "account");
    assert(request && accountEntry, "两种记录都要有");

    // 整单那条：状态码是我们返回的 503，试了 1 个号、池子里就 1 个、没有漏掉的。
    assert.equal(request.code, "upstream_text_reply", "整单的码沿用最后一个号的原因");
    assert.equal(request.status, 503);
    assert.equal(request.attempted, 1);
    assert.equal(request.poolSize, 1);
    assert.equal(request.skipped, 0);
    assert.equal(typeof request.ms, "number");
    assert.match(request.requestId, /^[0-9a-f]{6,16}$/);

    // 账号那条：带着上游原话，并且上游真实码（200）和我们返回的（502）分得开。
    assert.equal(accountEntry.code, "upstream_text_reply");
    assert.equal(accountEntry.status, 502);
    assert.equal(accountEntry.upstreamStatus, 200, "上游其实是 200，不能只记 502");
    assert.match(accountEntry.tag, /^s[0-9a-f]{10}$/);
    assert.equal(accountEntry.message, "图片生成功能暂时不可用。输出尺寸要求：1024 × 1024。");
    assert.equal(accountEntry.requestId, request.requestId, "两条要能串起来");
  } finally {
    await cleanup(root);
  }
});

test("生图成功不写日志：只有失败才记", async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, "home"), { recursive: true });
    const statsFile = join(root, "home", "pool-stats.json");
    const account = { email: "b@example.com", accessToken: jwt(3600, "b@example.com") };

    const res = await poolFetch(CODEX_BASE + "/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-image-2", prompt: "a dog" }),
    }, {
      read: async () => [account],
      statsFile,
      runWorker: async () => ({ ok: true, http_status: 200, data: [{ b64_json: "AAAA" }] }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await readImageErrorLog(), { total: 0, items: [] });
  } finally {
    await cleanup(root);
  }
});
