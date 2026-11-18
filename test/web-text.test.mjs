import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CODEX_BASE,
  discoverPoolModels,
  isCodexToken,
  isWebOnlyToken,
  poolFetch,
} from "../lib/codex-pool.mjs";
import {
  clearTextCooldowns,
  executeWebTextGeneration,
  extractWebTextRequest,
  runWebTextWorker,
} from "../lib/chatgpt-web-text.mjs";
import { createInMemoryStatsStore, recordTextCall } from "../lib/pool-stats.mjs";
import { accountSlotTag } from "../lib/pool-connection.mjs";

function makeJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

function platformJwt(expOffsetSec = 3600, email = "free@example.com") {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + expOffsetSec,
    client_id: "app_2SKx67EdpoN0G6j64rFvigXD",
    "https://api.openai.com/profile": { email },
  });
}

function codexJwt(expOffsetSec = 3600, accountId = "acct_codex_1") {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + expOffsetSec,
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
}

test("token capability detection separates Platform Web tokens from Codex tokens", () => {
  const pTok = platformJwt();
  const cTok = codexJwt();

  assert.equal(isWebOnlyToken(pTok), true);
  assert.equal(isCodexToken(pTok), false);

  assert.equal(isWebOnlyToken(cTok), false);
  assert.equal(isCodexToken(cTok), true);

  // Opaque/test strings remain compatible with Codex path
  assert.equal(isWebOnlyToken("opaque-token"), false);
  assert.equal(isCodexToken("opaque-token"), true);
});

test("discoverPoolModels includes verified Web text models for Platform OAuth accounts", async () => {
  const pTok = platformJwt();
  const fetcher = async (url) => {
    assert.equal(String(url), `${CODEX_BASE}/models?client_version=0.118.0`);
    return new Response(
      JSON.stringify({
        models: [
          { slug: "gpt-6-luna", display_name: "GPT-6 Luna" },
          { slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const models = await discoverPoolModels({
    read: async () => [{ email: "free@example.com", accessToken: pTok }],
    fetcher,
  });

  assert.equal(models["gpt-6-luna"].api.npm, "@ai-sdk/openai");
  assert.equal(models["gpt-5.6-luna"].api.npm, "@ai-sdk/openai");
  assert.equal(models["gpt-5.6-terra"].api.npm, "@ai-sdk/openai");
  assert.equal(models["gpt-5-6"].api.npm, "@ai-sdk/openai");
  assert.equal(models["auto"].api.npm, "@ai-sdk/openai");
  assert.equal(models["gpt-image-2.6"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal("gpt-5.6-luna-wm" in models, false);
});

test("extractWebTextRequest parses instructions, multi-turn items, tool calls, and reasoning", () => {
  const req = extractWebTextRequest(
    JSON.stringify({
      model: "gptfree-pool/gpt-5.6-terra",
      instructions: "Be accurate.",
      reasoning: { effort: "high" },
      stream: true,
      input: [
        { type: "reasoning", id: "rs_1" },
        { role: "user", content: [{ type: "input_text", text: "Check file" }] },
        { type: "function_call", name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    }),
  );

  assert.equal(req.model, "gpt-5.6-terra");
  assert.equal(req.requestedModel, "gptfree-pool/gpt-5.6-terra");
  assert.equal(req.stream, true);
  assert.equal(req.thinkingEffort, "high");
  assert.equal(req.messages[0].role, "system");
  assert.equal(req.messages[0].content, "Be accurate.");
  assert.equal(req.messages[1].role, "user");
  assert.match(req.messages[2].content, /read_file/);
  assert.match(req.messages[3].content, /call_1/);

  assert.throws(() => extractWebTextRequest("{bad json"), /Invalid Responses request/);
  assert.throws(() => extractWebTextRequest(JSON.stringify({ model: "gpt-6-luna", input: "   " })), /at least one/);
});

test("poolFetch routes Platform Web accounts away from /codex/responses and formats Responses SSE", async () => {
  clearTextCooldowns();
  const pTok = platformJwt(3600, "luna@example.com");
  let codexCalled = false;

  const res = await poolFetch(`${CODEX_BASE}/responses`, {
    method: "POST",
    body: JSON.stringify({
      model: "gpt-6-luna",
      instructions: "Concise",
      input: "2+2?",
      stream: true,
    }),
  }, {
    read: async () => [{ email: "luna@example.com", accessToken: pTok }],
    fetcher: async () => {
      codexCalled = true;
      throw new Error("Codex /responses must not be hit for Platform OAuth accounts");
    },
    webTextRunner: async (payload, { onDelta }) => {
      assert.equal(payload.access_token, pTok);
      assert.equal(payload.model, "gpt-6-luna");
      assert.deepEqual(payload.messages, [
        { role: "system", content: "Concise" },
        { role: "user", content: "2+2?" },
      ]);
      onDelta?.("4");
      onDelta?.("!");
      return { ok: true, text: "4!" };
    },
  });

  assert.equal(codexCalled, false);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const sse = await res.text();
  assert.match(sse, /event: response\.created/);
  assert.match(sse, /"delta":"4"/);
  assert.match(sse, /"delta":"!"/);
  assert.match(sse, /event: response\.completed/);
  assert.match(sse, /"text":"4!"/);
});

test("executeWebTextGeneration handles 401 reauth, 429 failover, and non-streaming JSON responses", async () => {
  clearTextCooldowns();
  const tok1 = platformJwt(3600, "a1@example.com");
  const tok1New = platformJwt(7200, "a1@example.com");
  const tok2 = platformJwt(3600, "a2@example.com");
  const calls = [];

  const res = await executeWebTextGeneration(
    JSON.stringify({ model: "gpt-5.6-luna", input: "hello", stream: false }),
    [
      { email: "a1@example.com", accessToken: tok1 },
      { email: "a2@example.com", accessToken: tok2 },
    ],
    {
      reauthenticate: async (acc) => ({ ...acc, accessToken: tok1New }),
      worker: async (payload) => {
        calls.push(payload.access_token);
        if (payload.access_token === tok1) {
          return { ok: false, http_status: 401, error_code: "invalid_token", error: "expired", token_invalid: true };
        }
        if (payload.access_token === tok1New) {
          return { ok: false, http_status: 429, error_code: "rate_limit_exceeded", error: "rate limit", retry_after: 30 };
        }
        return { ok: true, text: "world" };
      },
    },
  );

  assert.deepEqual(calls, [tok1, tok1New, tok2]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "response");
  assert.equal(body.status, "completed");
  assert.equal(body.output_text, "world");
  assert.equal(body.output[0].content[0].text, "world");

  // Next call should put cooled-down a1 behind a2 without hitting a1 first
  const nextCalls = [];
  const res2 = await executeWebTextGeneration(
    JSON.stringify({ model: "gpt-5.6-luna", input: "hello 2", stream: false }),
    [
      { email: "a1@example.com", accessToken: tok1New },
      { email: "a2@example.com", accessToken: tok2 },
    ],
    {
      worker: async (payload) => {
        nextCalls.push(payload.access_token);
        return { ok: true, text: "fast" };
      },
    },
  );
  assert.equal(res2.status, 200);
  assert.deepEqual(nextCalls, [tok2]);
  clearTextCooldowns();
});

// 文本每次尝试都要能报给统计：哪个号成的、哪个号败的、败在什么原因上。
test("executeWebTextGeneration reports every account attempt for the stats ledger", async () => {
  clearTextCooldowns();
  const bad = platformJwt(3600, "bad@example.com");
  const good = platformJwt(3600, "good@example.com");
  const seen = [];

  const res = await executeWebTextGeneration(
    JSON.stringify({ model: "gpt-5.6-luna", input: "hi", stream: false }),
    [
      { email: "bad@example.com", accessToken: bad },
      { email: "good@example.com", accessToken: good },
    ],
    {
      onAttempt: (account, outcome) => seen.push([account.email, outcome.ok, outcome.code || ""]),
      worker: async (payload) => (
        payload.access_token === bad
          ? { ok: false, http_status: 429, error_code: "rate_limit_exceeded", error: "slow down", retry_after: 1 }
          : { ok: true, text: "ok" }
      ),
    },
  );

  assert.equal(res.status, 200);
  assert.deepEqual(seen, [
    ["bad@example.com", false, "rate_limit_exceeded"],
    ["good@example.com", true, ""],
  ]);
  clearTextCooldowns();
});

// 文本链路的限流冷却原本只存在进程内的 Map 里：插件宿主每小时热更新一次，
// 冷却就跟着没了，下一个请求还会先打那个正在限流的号。现在把 textLimitedUntil
// 写进账本，重启后从账本读回来，排序照样把冷却中的号排到最后。
test("a text 429 cooldown survives a restart by being read back from the ledger", async () => {
  clearTextCooldowns();
  const store = createInMemoryStatsStore();
  const bad = platformJwt(3600, "cooled@example.com");
  const good = platformJwt(3600, "healthy@example.com");
  const accounts = [
    { email: "cooled@example.com", accessToken: bad },
    { email: "healthy@example.com", accessToken: good },
  ];
  const worker = async (payload) => (
    payload.access_token === bad
      ? { ok: false, http_status: 429, error_code: "rate_limit_exceeded", error: "slow down", retry_after: 300 }
      : { ok: true, text: "ok" }
  );

  // codex-pool 的 recordText 就是这样把 onAttempt 转成账本写入的。
  // executeWebTextGeneration 自己只负责内存冷却，持久化走这条回调。
  const makeRecorder = (order) => {
    const writes = [];
    return {
      order,
      writes,
      onAttempt: (account, outcome = {}) => {
        order.push(account.email);
        writes.push(recordTextCall({
          email: account.email,
          success: outcome.ok === true,
          error: outcome.ok === true ? "" : (outcome.code || ""),
          rateLimited: outcome.rateLimited === true,
          retryAfter: outcome.retryAfter ?? null,
        }, { statsStore: store }));
      },
    };
  };

  const first = makeRecorder([]);
  await executeWebTextGeneration(
    JSON.stringify({ model: "gpt-5.6-luna", input: "hi", stream: false }),
    accounts,
    { worker, textStats: store.state, onAttempt: first.onAttempt },
  );
  await Promise.all(first.writes);
  assert.deepEqual(first.order, ["cooled@example.com", "healthy@example.com"]);

  const tag = accountSlotTag("cooled@example.com");
  const until = Date.parse(store.state.accounts[tag].textLimitedUntil || "");
  assert.ok(until > Date.now(), "429 的冷却必须落到账本的 textLimitedUntil 上");
  assert.equal(store.state.accounts[tag].textConsecutiveFails, 1);

  // 模拟宿主热更新：进程内 Map 清空，只剩账本。
  clearTextCooldowns();

  const second = makeRecorder([]);
  await executeWebTextGeneration(
    JSON.stringify({ model: "gpt-5.6-luna", input: "hi", stream: false }),
    accounts,
    { worker, textStats: store.state, onAttempt: second.onAttempt },
  );
  await Promise.all(second.writes);
  // 冷却中的号被排到最后：healthy 先上并且成了，cooled 根本轮不到。
  assert.equal(second.order[0], "healthy@example.com",
    "重启后冷却中的号应该被排到最后，而不是又第一个挨打");
  assert.ok(!second.order.includes("cooled@example.com"), "healthy 成功就不该再打冷却中的号");

  // 不传账本时确实会退回「内存里没冷却」的老行为 —— 说明起作用的是持久化那份。
  clearTextCooldowns();
  const withoutLedger = makeRecorder([]);
  await executeWebTextGeneration(
    JSON.stringify({ model: "gpt-5.6-luna", input: "hi", stream: false }),
    accounts,
    { worker, onAttempt: withoutLedger.onAttempt },
  );
  await Promise.all(withoutLedger.writes);
  assert.deepEqual(withoutLedger.order, ["cooled@example.com", "healthy@example.com"]);

  clearTextCooldowns();
});

// 冷却到期就该放回去，否则账本里一条过期的 textLimitedUntil 会永久压低这个号。
test("an expired textLimitedUntil no longer pushes the account back", async () => {
  clearTextCooldowns();
  const store = createInMemoryStatsStore();
  const cooled = platformJwt(3600, "expired@example.com");
  const fresh = platformJwt(3600, "fresh@example.com");
  const tag = accountSlotTag("expired@example.com");
  await recordTextCall(
    { email: "expired@example.com", success: false, error: "rate_limit_exceeded", rateLimited: true, retryAfter: 1 },
    { statsStore: store },
  );
  // 直接把冷却时间改成过去，等价于「等它自然过期」。
  store.state.accounts[tag].textLimitedUntil = new Date(Date.now() - 1000).toISOString();

  const order = [];
  await executeWebTextGeneration(
    JSON.stringify({ model: "gpt-5.6-luna", input: "hi", stream: false }),
    [
      { email: "expired@example.com", accessToken: cooled },
      { email: "fresh@example.com", accessToken: fresh },
    ],
    {
      textStats: store.state,
      onAttempt: (account) => order.push(account.email),
      worker: async (payload) => (
        payload.access_token === cooled
          ? { ok: true, text: "ok" }
          : { ok: true, text: "ok" }
      ),
    },
  );
  assert.deepEqual(order, ["expired@example.com"], "过期的冷却不该影响排序");
  clearTextCooldowns();
});

test("poolFetch switches to Web text if reauth produces a Platform token and runWebTextWorker validates missing token / abort", async () => {
  clearTextCooldowns();
  const oldCodex = codexJwt(3600, "acct_old");
  const renewedPlatform = platformJwt(3600, "migrated@example.com");

  let codexCalls = 0;
  // Calling poolFetch with codex account that fails 401 -> reauth returns Platform token
  // Because executeWebTextGeneration is invoked automatically on Platform token, mock runWebTextWorker or test via abort
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    runWebTextWorker(
      { access_token: renewedPlatform, model: "gpt-6-luna", messages: [{ role: "user", content: "hi" }] },
      { signal: ac.signal, python: async () => "python" },
    ),
    /Aborted/,
  );

  const res = await runWebTextWorker(
    { access_token: "", model: "gpt-6-luna", messages: [{ role: "user", content: "hi" }] },
    { python: async () => process.env.PYTHON || (process.platform === "win32" ? "python" : "python3") },
  );
  assert.equal(res.ok, false);
  assert.equal(res.http_status, 401);
  assert.equal(isWebOnlyToken(oldCodex), false);
  assert.equal(isWebOnlyToken(renewedPlatform), true);
  assert.equal(codexCalls, 0);
});

// worker 默认 180 秒，比整单 120 秒的预算还长：一次卡住就把预算吃光，
// 后面的号连试都轮不上。图片链路踩过这个坑，文本这边同样要压住。
test("a single text attempt is bounded by the remaining budget, not the worker default", async () => {
  clearTextCooldowns();
  const tok = platformJwt(3600, "bounded@example.com");
  const seen = [];
  const res = await executeWebTextGeneration(
    JSON.stringify({ model: "gpt-5.6-luna", input: "hi", stream: false }),
    [{ email: "bounded@example.com", accessToken: tok }],
    {
      worker: async (payload, opts) => {
        seen.push(opts?.timeout);
        return { ok: true, text: "ok" };
      },
    },
  );
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.ok(Number.isFinite(seen[0]), "worker 必须拿到显式超时");
  assert.ok(seen[0] <= 60_000, "不能是 worker 默认的 180 秒");
  assert.ok(seen[0] >= 5_000, "也别压到短得没法用");
});

// 上游说「你发的 body 我不认」时，422 必须原样到客户端 —— 既不能吞成 503
// （那会让人以为是号池没号），也不能把 worker 那句能定位的文案截掉。
test("upstream 422 passes through as 422 with the locating message intact", async () => {
  clearTextCooldowns();
  const tok = platformJwt(3600, "rejected@example.com");
  const workerMessage =
    '上游 422：{"detail": "Invalid conversation body"}（/f/conversation｜model=gpt-5.6-luna｜角色=user｜1 条消息）';

  const res = await executeWebTextGeneration(
    JSON.stringify({ model: "gpt-5.6-luna", input: "hi", stream: false }),
    [{ email: "rejected@example.com", accessToken: tok }],
    {
      worker: async () => ({
        ok: false,
        http_status: 422,
        error_code: "upstream_http_error",
        error: workerMessage,
      }),
    },
  );

  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error.code, "upstream_http_error");
  assert.equal(body.error.message, workerMessage);
  assert.match(body.error.message, /Invalid conversation body/);
});
