import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_BASE, discoverPoolModels, poolFetch, probeAccountImageQuota, refreshPoolAccount,
} from "../lib/codex-pool.mjs";
import { bridgeChatToImage } from "../lib/chat-image-bridge.mjs";
import { accountInflight, clearAccountInflight } from "../lib/account-inflight.mjs";
import { readImageReplyMode, writeImageReplyMode } from "../lib/reply-settings.mjs";
import {
  IMAGE_MODEL_ID,
  buildImageModelCatalog,
  checkWebImageQuota,
  executeWebImageGeneration,
  isImageModelId,
  parseImageRequest,
  runWebImageWorker,
  supportsGifOutput,
} from "../lib/chatgpt-web-image.mjs";
import {
  createInMemoryStatsStore, isAccountRateLimited, readPoolStats, recordQuotaCheck,
  sanitizeStatsMessage, summarizePoolStats,
} from "../lib/pool-stats.mjs";
import { accountSlotTag, buildSlotAuthBody } from "../lib/pool-connection.mjs";
import { GPTFreePoolPlugin } from "../index.mjs";

const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
function jwt(delta, email = "a@example.com") {
  return [
    Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url"),
    Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + delta, email,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct123" },
    })).toString("base64url"),
    "signature",
  ].join(".");
}

function findPython() {
  for (const cmd of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    const res = spawnSync(cmd, ["-c", "import sys;print(sys.version_info.major)"], { encoding: "utf8" });
    if (res.status === 0 && String(res.stdout).trim() === "3") return cmd;
  }
  return null;
}

test("image model catalog exposes Magpie host.js @ai-sdk/openai-compatible schema and capabilities", async () => {
  const cat = buildImageModelCatalog(CODEX_BASE);
  const img = cat[IMAGE_MODEL_ID];
  assert.equal(img.id, "gpt-image-2");
  assert.equal(img.api.id, "gpt-image-2");
  assert.equal(img.api.url, CODEX_BASE);
  assert.equal(img.api.npm, "@ai-sdk/openai-compatible");
  assert.equal(img.capabilities.input.text, true);
  assert.equal(img.capabilities.input.image, true);
  assert.equal(img.capabilities.output.text, false);
  assert.equal(img.capabilities.output.image, true);
  assert.equal(img.attachment, true);

  // The 2.6 family must be exposed too, and only 2.6 supports animated GIF.
  const flags = ["gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"];
  for (const id of flags) {
    const model = cat[id];
    assert.equal(model.id, id);
    assert.equal(model.api.npm, "@ai-sdk/openai-compatible");
    assert.equal(model.capabilities.output.image, true);
    assert.equal(model.capabilities.animated, true);
  }
  assert.equal(cat["gpt-image-2"].capabilities.animated, undefined);
  assert.equal(isImageModelId("plus-gpt-image-2.6"), true);

  // GIF output is accepted for 2.6 and rejected for the older model.
  const gif2 = await parseImageRequest("/backend-api/codex/images/generations", JSON.stringify({
    model: "gpt-image-2.6",
    prompt: "spinning coin",
    output_format: "gif",
    frame_count: 12,
    frame_duration_ms: 100,
  }));
  assert.equal(gif2.model, "gpt-image-2.6");
  assert.equal(gif2.output_format, "gif");
  assert.equal(gif2.frame_count, 12);
  assert.equal(gif2.frame_duration_ms, 100);
  await assert.rejects(
    parseImageRequest("/backend-api/codex/images/generations", JSON.stringify({
      model: "gpt-image-2",
      prompt: "spinning coin",
      output_format: "gif",
    })),
    (err) => err.status === 400 && /2\.6/.test(err.message),
  );
  await assert.rejects(
    parseImageRequest("/backend-api/codex/images/generations",
      JSON.stringify({ model: "gpt-image-9", prompt: "x" })),
    (err) => err.status === 400 && err.code === "model_not_found",
  );

  // Verify integrated discoverPoolModels keeps Codex text models on @ai-sdk/openai
  const models = await discoverPoolModels({
    read: async () => [{ email: "free@example.com", password: "p", totp: seed, accessToken: jwt(3600, "free@example.com") }],
    fetcher: async () => new Response(JSON.stringify({
      models: [{ slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(models["gpt-5.6-luna"].api.npm, "@ai-sdk/openai");
  assert.equal(models["gpt-image-2"].api.npm, "@ai-sdk/openai-compatible");
});

test("local bridge: chat/completions with an image model goes through /images/generations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-bridge-"));
  process.env.MAGPIE_GPTFREE_IMAGE_DIR = dir;
  // 回复形态从 poolDir()/settings.json 读，也指到临时目录，免得读到开发机上的真实设置。
  process.env.MAGPIE_GPTFREE_HOME = dir;
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    let forwarded = null;
    const response = await bridgeChatToImage(
      JSON.stringify({ model: "gpt-image-2", messages: [{ role: "user", content: "a corgi in space" }] }),
      {},
      {
        forward: async (endpoint, body) => {
          forwarded = { endpoint, body: JSON.parse(body) };
          return new Response(JSON.stringify({ created: 1, data: [{ b64_json: png }] }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(forwarded.endpoint, "/images/generations");
    assert.equal(forwarded.body.prompt, "a corgi in space");
    assert.equal(forwarded.body.model, "gpt-image-2");

    const body = await response.json();
    assert.equal(body.object, "chat.completion");
    // 默认 both：第一行内联图负责渲染，第二行裸地址负责复制转发，两行 URL 相同。
    // 没设 MAGPIE_GPTFREE_PUBLIC_BASE 时两行都回相对路径：代码里不绑任何具体主机。
    const content = body.choices[0].message.content;
    const lines = content.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^!\[image\]\(\/img\/[^()\s]+\.png\)$/);
    assert.match(lines[1], /^\/img\/[^()\s]+\.png$/);
    assert.equal(lines[0].replace(/^!\[image\]\(|\)$/g, ""), lines[1]);
    const saved = await readFile(join(dir, lines[1].replace(/^\/img\//, "")));
    assert.equal(saved.length > 0, true);
  } finally {
    delete process.env.MAGPIE_GPTFREE_IMAGE_DIR;
    delete process.env.MAGPIE_GPTFREE_HOME;
    await rm(dir, { recursive: true, force: true });
  }
});

test("an image link becomes absolute only when MAGPIE_GPTFREE_PUBLIC_BASE says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-bridge-base-"));
  process.env.MAGPIE_GPTFREE_IMAGE_DIR = dir;
  // 回复形态从 poolDir()/settings.json 读，也指到临时目录，免得读到开发机上的真实设置。
  process.env.MAGPIE_GPTFREE_HOME = dir;
  process.env.MAGPIE_GPTFREE_PUBLIC_BASE = "https://images.example.test/";
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    const response = await bridgeChatToImage(
      JSON.stringify({ model: "gpt-image-2", messages: [{ role: "user", content: "a cat" }] }),
      {},
      {
        forward: async () => new Response(JSON.stringify({ created: 1, data: [{ b64_json: png }] }), {
          status: 200, headers: { "content-type": "application/json" },
        }),
      },
    );
    const body = await response.json();
    // 结尾的斜杠要去掉，不能拼出 //img/。
    const lines = body.choices[0].message.content.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^!\[image\]\(https:\/\/images\.example\.test\/img\/[^()\s]+\.png\)$/);
    assert.match(lines[1], /^https:\/\/images\.example\.test\/img\/[^()\s]+\.png$/);
    assert.equal(lines[0].replace(/^!\[image\]\(|\)$/g, ""), lines[1]);
  } finally {
    delete process.env.MAGPIE_GPTFREE_IMAGE_DIR;
    delete process.env.MAGPIE_GPTFREE_HOME;
    delete process.env.MAGPIE_GPTFREE_PUBLIC_BASE;
    await rm(dir, { recursive: true, force: true });
  }
});

test("MAGPIE_GPTFREE_IMAGE_REPLY=url keeps 0.8.8: one bare URL per line, streaming included", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-bridge-n2-"));
  process.env.MAGPIE_GPTFREE_IMAGE_DIR = dir;
  // 回复形态从 poolDir()/settings.json 读，也指到临时目录，免得读到开发机上的真实设置。
  process.env.MAGPIE_GPTFREE_HOME = dir;
  process.env.MAGPIE_GPTFREE_PUBLIC_BASE = "https://rk.example.test";
  process.env.MAGPIE_GPTFREE_IMAGE_REPLY = "url";
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    const jpg = Buffer.from("ffd8ffe000104a464946", "hex").toString("base64");
    // 上游单次只出一张：n=2 就打两次，每次一张。按调用顺序第一张 png、第二张 jpg。
    const calls = [];
    let inFlight = 0, peak = 0;
    const forward = async (_endpoint, body) => {
      const payload = JSON.parse(body);
      const index = calls.push(payload) - 1;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight--;
      return new Response(JSON.stringify({
        created: 1, data: [{ b64_json: index === 0 ? png : jpg }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    // 非流式：两行，每行一个绝对地址，顺序与提交顺序一致（第一张 png、第二张 jpg）。
    const plain = await bridgeChatToImage(
      JSON.stringify({ model: "gpt-image-2", messages: [{ role: "user", content: "two cats" }], n: 2 }),
      {}, { forward },
    );
    const content = (await plain.json()).choices[0].message.content;
    const lines = content.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^https:\/\/rk\.example\.test\/img\/[^()\s]+\.png$/);
    assert.match(lines[1], /^https:\/\/rk\.example\.test\/img\/[^()\s]+\.jpg$/);
    assert.equal(calls.length, 2, "n=2 要打两次上游");
    assert(calls.every((c) => c.n === 1), "每次请求的 n 必须是 1，否则上游会重复计数");
    assert.equal(peak, 2, "并发上限是 2：两张应该同时在跑");

    // 流式：delta.content 同样是纯地址，不夹 markdown。
    const streamed = await bridgeChatToImage(
      JSON.stringify({ model: "gpt-image-2", messages: [{ role: "user", content: "two cats" }], n: 2, stream: true }),
      {}, { forward },
    );
    assert.match(streamed.headers.get("content-type"), /text\/event-stream/);
    const raw = await streamed.text();
    const deltas = raw.split("\n\n")
      .filter((chunk) => chunk.startsWith("data: ") && !chunk.includes("[DONE]"))
      .map((chunk) => JSON.parse(chunk.slice(6)).choices[0].delta.content)
      .filter((text) => typeof text === "string");
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].split("\n").length, 2);
    assert(!deltas[0].includes("![image]("), "流式正文也不能夹 markdown");
  } finally {
    delete process.env.MAGPIE_GPTFREE_IMAGE_DIR;
    delete process.env.MAGPIE_GPTFREE_HOME;
    delete process.env.MAGPIE_GPTFREE_PUBLIC_BASE;
    delete process.env.MAGPIE_GPTFREE_IMAGE_REPLY;
    await rm(dir, { recursive: true, force: true });
  }
});

test("both mode groups each image as inline + bare URL, blank line between groups, streaming included", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-bridge-both-"));
  process.env.MAGPIE_GPTFREE_IMAGE_DIR = dir;
  // 回复形态从 poolDir()/settings.json 读，也指到临时目录，免得读到开发机上的真实设置。
  process.env.MAGPIE_GPTFREE_HOME = dir;
  process.env.MAGPIE_GPTFREE_PUBLIC_BASE = "https://rk.example.test";
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    const jpg = Buffer.from("ffd8ffe000104a464946", "hex").toString("base64");
    // 一次调用只出一张（上游就是这样），n=2 靠桥接层打两次。
    let callIndex = 0;
    const forward = async () => {
      const b64 = callIndex++ % 2 === 0 ? png : jpg;
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: b64 }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };

    const plain = await bridgeChatToImage(
      JSON.stringify({ model: "gpt-image-2", messages: [{ role: "user", content: "two cats" }], n: 2 }),
      {}, { forward },
    );
    const content = (await plain.json()).choices[0].message.content;
    const lines = content.split("\n");
    // 组内两行不空行，组与组之间空一行。
    assert.equal(lines.length, 5);
    assert.match(lines[0], /^!\[image\]\(https:\/\/rk\.example\.test\/img\/[^()\s]+\.png\)$/);
    assert.match(lines[1], /^https:\/\/rk\.example\.test\/img\/[^()\s]+\.png$/);
    assert.equal(lines[2], "", "组与组之间要空一行");
    assert.match(lines[3], /^!\[image\]\(https:\/\/rk\.example\.test\/img\/[^()\s]+\.jpg\)$/);
    assert.match(lines[4], /^https:\/\/rk\.example\.test\/img\/[^()\s]+\.jpg$/);
    assert.equal(lines[0].replace(/^!\[image\]\(|\)$/g, ""), lines[1]);
    assert.equal(lines[3].replace(/^!\[image\]\(|\)$/g, ""), lines[4]);

    // 流式 delta.content 与非流式完全一致（整段一次性下发）。
    const streamed = await bridgeChatToImage(
      JSON.stringify({ model: "gpt-image-2", messages: [{ role: "user", content: "two cats" }], n: 2, stream: true }),
      {}, { forward },
    );
    const raw = await streamed.text();
    const deltas = raw.split("\n\n")
      .filter((chunk) => chunk.startsWith("data: ") && !chunk.includes("[DONE]"))
      .map((chunk) => JSON.parse(chunk.slice(6)).choices[0].delta.content)
      .filter((text) => typeof text === "string");
    assert.equal(deltas.length, 1);
    // 每次调用都会落新文件（文件名带随机串），所以比结构不比字面量。
    const streamedLines = deltas[0].split("\n");
    assert.equal(streamedLines.length, 5);
    assert.match(streamedLines[0], /^!\[image\]\(https:\/\/rk\.example\.test\/img\/[^()\s]+\.png\)$/);
    assert.equal(streamedLines[2], "");
    assert.match(streamedLines[4], /^https:\/\/rk\.example\.test\/img\/[^()\s]+\.jpg$/);
  } finally {
    delete process.env.MAGPIE_GPTFREE_IMAGE_DIR;
    delete process.env.MAGPIE_GPTFREE_HOME;
    delete process.env.MAGPIE_GPTFREE_PUBLIC_BASE;
    await rm(dir, { recursive: true, force: true });
  }
});

test("multi-image: a single failure doesn't kill the request; only all-failure errors out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-bridge-partial-"));
  process.env.MAGPIE_GPTFREE_IMAGE_DIR = dir;
  process.env.MAGPIE_GPTFREE_HOME = dir;
  process.env.MAGPIE_GPTFREE_PUBLIC_BASE = "https://rk.example.test";
  process.env.MAGPIE_GPTFREE_IMAGE_REPLY = "url";
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    const jsonHeaders = { "content-type": "application/json" };
    const request = (n) => JSON.stringify({
      model: "gpt-image-2", messages: [{ role: "user", content: "two cats" }], n,
    });

    // 第一张成功、第二张 502：把成功那张给出去，不报错。
    let call = 0;
    const halfBroken = async () => {
      if (call++ === 1) {
        return new Response(JSON.stringify({ error: { message: "upstream glitch" } }), {
          status: 502, headers: jsonHeaders,
        });
      }
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: png }] }), {
        status: 200, headers: jsonHeaders,
      });
    };
    const partial = await bridgeChatToImage(request(2), {}, { forward: halfBroken });
    assert.equal(partial.status, 200);
    const lines = (await partial.json()).choices[0].message.content.split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^https:\/\/rk\.example\.test\/img\/[^()\s]+\.png$/);

    // 两张都失败：502，文案沿用上游的。
    const allBroken = async () => new Response(JSON.stringify({ error: { message: "号池里没号能出图" } }), {
      status: 502, headers: jsonHeaders,
    });
    const dead = await bridgeChatToImage(request(2), {}, { forward: allBroken });
    assert.equal(dead.status, 502);
    assert.match((await dead.json()).error.message, /没号能出图/);

    // 预算到点（request_timeout）对外仍报 400，免得网关把一次失败重试成两次。
    const timedOut = async () => new Response(JSON.stringify({
      error: { message: "生图超时", code: "request_timeout" },
    }), { status: 504, headers: jsonHeaders });
    const timeout = await bridgeChatToImage(request(1), {}, { forward: timedOut });
    assert.equal(timeout.status, 400);
    assert.equal((await timeout.json()).error.code, "request_timeout");
  } finally {
    delete process.env.MAGPIE_GPTFREE_IMAGE_DIR;
    delete process.env.MAGPIE_GPTFREE_HOME;
    delete process.env.MAGPIE_GPTFREE_PUBLIC_BASE;
    delete process.env.MAGPIE_GPTFREE_IMAGE_REPLY;
    await rm(dir, { recursive: true, force: true });
  }
});

test("multi-image: n=4 queues behind a concurrency cap of 2 and keeps submission order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-bridge-cap-"));
  process.env.MAGPIE_GPTFREE_IMAGE_DIR = dir;
  process.env.MAGPIE_GPTFREE_HOME = dir;
  process.env.MAGPIE_GPTFREE_PUBLIC_BASE = "https://rk.example.test";
  process.env.MAGPIE_GPTFREE_IMAGE_REPLY = "url";
  try {
    // 四种不同的字节头 → 落盘后扩展名不同，正好能验证「顺序 = 提交顺序」。
    const bodies = [
      "89504e470d0a1a0a0000000d49484452", // png
      "ffd8ffe000104a464946",             // jpg
      "52494646aabbccdd",                 // webp
      "474946383961aabbccdd",             // gif
    ].map((hex) => Buffer.from(hex, "hex").toString("base64"));
    const order = [];
    let inFlight = 0, peak = 0;
    const forward = async (_endpoint, body) => {
      assert.equal(JSON.parse(body).n, 1);
      const index = order.push(null) - 1;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: bodies[index] }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };

    const response = await bridgeChatToImage(
      JSON.stringify({ model: "gpt-image-2", messages: [{ role: "user", content: "four cats" }], n: 4 }),
      {}, { forward },
    );
    assert.equal(response.status, 200);
    const lines = (await response.json()).choices[0].message.content.split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[0], /\.png$/);
    assert.match(lines[1], /\.jpg$/);
    assert.match(lines[2], /\.webp$/);
    assert.match(lines[3], /\.gif$/);
    assert.equal(peak, 2, "同时在跑的请求不能超过 2 个");
  } finally {
    delete process.env.MAGPIE_GPTFREE_IMAGE_DIR;
    delete process.env.MAGPIE_GPTFREE_HOME;
    delete process.env.MAGPIE_GPTFREE_PUBLIC_BASE;
    delete process.env.MAGPIE_GPTFREE_IMAGE_REPLY;
    await rm(dir, { recursive: true, force: true });
  }
});

test("MAGPIE_GPTFREE_IMAGE_REPLY=markdown restores the old inline-image reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-bridge-md-"));
  process.env.MAGPIE_GPTFREE_IMAGE_DIR = dir;
  // 回复形态从 poolDir()/settings.json 读，也指到临时目录，免得读到开发机上的真实设置。
  process.env.MAGPIE_GPTFREE_HOME = dir;
  process.env.MAGPIE_GPTFREE_IMAGE_REPLY = "markdown";
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    const response = await bridgeChatToImage(
      JSON.stringify({ model: "gpt-image-2", messages: [{ role: "user", content: "a cat" }] }),
      {},
      {
        forward: async () => new Response(JSON.stringify({ created: 1, data: [{ b64_json: png }] }), {
          status: 200, headers: { "content-type": "application/json" },
        }),
      },
    );
    const content = (await response.json()).choices[0].message.content;
    assert.match(content, /^!\[image\]\(\/img\/[^()\s]+\.png\)$/);
  } finally {
    delete process.env.MAGPIE_GPTFREE_IMAGE_DIR;
    delete process.env.MAGPIE_GPTFREE_HOME;
    delete process.env.MAGPIE_GPTFREE_IMAGE_REPLY;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the reply mode can be set from the panel (settings file), and env still overrides it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-bridge-settings-"));
  process.env.MAGPIE_GPTFREE_IMAGE_DIR = dir;
  process.env.MAGPIE_GPTFREE_HOME = dir;
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    const reply = async () => {
      const response = await bridgeChatToImage(
        JSON.stringify({ model: "gpt-image-2", messages: [{ role: "user", content: "a cat" }] }),
        {},
        {
          forward: async () => new Response(JSON.stringify({ created: 1, data: [{ b64_json: png }] }), {
            status: 200, headers: { "content-type": "application/json" },
          }),
        },
      );
      return (await response.json()).choices[0].message.content;
    };

    // 没设置过：默认 both。
    assert.equal((await readImageReplyMode()).source, "default");
    assert.equal((await readImageReplyMode()).mode, "both");

    // 面板写入 url：桥接立刻跟着变，不用重启、不用环境变量。
    assert.equal(await writeImageReplyMode("url"), "url");
    assert.deepEqual(await readImageReplyMode(), { mode: "url", source: "settings" });
    assert.match(await reply(), /^\/img\/[^()\s]+\.png$/);

    // 面板写入 markdown。
    await writeImageReplyMode("markdown");
    assert.match(await reply(), /^!\[image\]\(\/img\/[^()\s]+\.png\)$/);

    // 环境变量优先于设置文件。
    process.env.MAGPIE_GPTFREE_IMAGE_REPLY = "url";
    assert.deepEqual(await readImageReplyMode(), { mode: "url", source: "env" });
    assert.match(await reply(), /^\/img\/[^()\s]+\.png$/);
    delete process.env.MAGPIE_GPTFREE_IMAGE_REPLY;

    // 不认识的值写不进去，也不会把文件写坏。
    await assert.rejects(() => writeImageReplyMode("gif"), (err) => err.status === 400);
    assert.deepEqual(await readImageReplyMode(), { mode: "markdown", source: "settings" });

    // 文件被写坏（半截 JSON）时退回默认，不影响出图。
    await writeFile(join(dir, "settings.json"), "{ broken", "utf8");
    assert.deepEqual(await readImageReplyMode(), { mode: "both", source: "default" });
    assert.equal((await reply()).split("\n").length, 2);
  } finally {
    delete process.env.MAGPIE_GPTFREE_IMAGE_DIR;
    delete process.env.MAGPIE_GPTFREE_HOME;
    delete process.env.MAGPIE_GPTFREE_IMAGE_REPLY;
    await rm(dir, { recursive: true, force: true });
  }
});

test("TestModels chat/completions probe points Codex models to /v1/responses", async () => {
  const codexProbe = await poolFetch(CODEX_BASE + "/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(codexProbe.status, 400);
  const codexJson = await codexProbe.json();
  assert.match(codexJson.error.message, /\/v1\/responses/);
});

test("parseImageRequest parses both JSON generations and multipart/form-data edits with image[], mask, and markup", async () => {
  const gen = await parseImageRequest("/backend-api/codex/images/generations", JSON.stringify({
    model: "gpt-image-2",
    prompt: "a corgi in space",
    n: 2,
    size: "1024x1024",
    quality: "high",
    output_format: "webp",
    background: "transparent",
  }));
  assert.equal(gen.model, "gpt-image-2");
  assert.equal(gen.n, 2);
  assert.equal(gen.output_format, "webp");
  assert.equal(gen.background, "transparent");
  assert.deepEqual(gen.images, []);

  // Build real multipart/form-data payload using FormData + Response
  const fd = new FormData();
  fd.append("model", "gpt-image-2");
  fd.append("prompt", "add sunglasses");
  fd.append("n", "1");
  fd.append("image[]", new File([Buffer.from("png-bytes-1")], "photo.png", { type: "image/png" }));
  fd.append("mask", new File([Buffer.from("mask-bytes-1")], "mask.png", { type: "image/png" }));
  fd.append("markup", new File([Buffer.from("markup-bytes-1")], "markup.png", { type: "image/png" }));
  const multipartReq = new Request("https://chatgpt.com/backend-api/codex/images/edits", {
    method: "POST",
    body: fd,
  });
  const rawBuf = Buffer.from(await multipartReq.arrayBuffer());
  const contentType = multipartReq.headers.get("content-type");

  const edit = await parseImageRequest("/backend-api/codex/images/edits", rawBuf, { "content-type": contentType });
  assert.equal(edit.model, "gpt-image-2");
  assert.equal(edit.prompt, "add sunglasses");
  assert.equal(edit.images.length, 2);
  assert.equal(edit.images[0].filename, "photo.png");
  assert.equal(edit.images[1].filename, "markup.png");
  assert.equal(edit.masks.length, 1);
  assert.equal(edit.masks[0].filename, "mask.png");

  // Remote image URL in JSON edits is rejected with 400
  await assert.rejects(
    parseImageRequest("/backend-api/codex/images/edits", JSON.stringify({
      prompt: "edit",
      image: "https://attacker.invalid/secret.png",
    })),
    (err) => err.status === 400,
  );
});

test("poolFetch /images/generations supports 401 reauth, 429/502 failover, preferredSlot, and multiple images (n=2)", async () => {
  const accA = { email: "alpha@example.com", password: "p1", totp: seed, accessToken: jwt(3600, "alpha@example.com") };
  const accB = { email: "beta@example.com", password: "p2", totp: seed, accessToken: jwt(3600, "beta@example.com") };
  const renewedB = jwt(3600, "beta@example.com") + "2";
  const slotB = accountSlotTag(accB.email);

  const calls = [];
  let reauthCalls = 0;

  const res = await poolFetch(CODEX_BASE + "/images/generations", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-image-2", prompt: "cute orange cat", n: 2, size: "1024x1024" }),
  }, {
    read: async () => [accA, accB],
    preferredSlot: slotB,
    reauthenticate: async (account) => {
      reauthCalls++;
      return { ...account, accessToken: renewedB };
    },
    runWorker: async (payload) => {
      calls.push({ token: payload.access_token, prompt: payload.prompt });
      // accB initially 401 -> reauth -> renewedB succeeds; accA 429 -> failover to renewedB
      if (payload.access_token === accB.accessToken) {
        return { ok: false, http_status: 401, error_code: "unauthorized", error: "token expired" };
      }
      if (payload.access_token === accA.accessToken) {
        return { ok: false, http_status: 429, error_code: "rate_limited", error: "quota exceeded" };
      }
      return {
        ok: true,
        created: 1731150000,
        data: [{ b64_json: Buffer.from("fake-png").toString("base64"), media_type: "image/png", revised_prompt: payload.prompt }],
      };
    },
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, 1731150000);
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].media_type, "image/png");
  assert(body.usage.input_tokens > 0);
  assert(body.usage.output_tokens >= 2048);
  assert.equal(reauthCalls, 1);
  // Preferred slot B tried first
  assert.equal(calls[0].token, accB.accessToken);
});

test("content policy refusal (400) stops immediately without burning remaining pooled accounts", async () => {
  const acc1 = { email: "a@example.com", password: "p", totp: seed, accessToken: jwt(3600, "a@example.com") };
  const acc2 = { email: "b@example.com", password: "p", totp: seed, accessToken: jwt(3600, "b@example.com") };
  let workerCalls = 0;

  const res = await poolFetch(CODEX_BASE + "/images/generations", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-image-2", prompt: "blocked prompt" }),
  }, {
    read: async () => [acc1, acc2],
    runWorker: async () => {
      workerCalls++;
      return {
        ok: false,
        http_status: 400,
        error_code: "content_policy_violation",
        error: "Rejected by safety system",
      };
    },
  });

  assert.equal(res.status, 400);
  assert.equal(workerCalls, 1);
  const json = await res.json();
  assert.equal(json.error.code, "content_policy_violation");
});

test("GPTFreePoolPlugin loader wires poolSlot into poolFetch for /images/edits", async () => {
  const plug = await GPTFreePoolPlugin();
  const auth = buildSlotAuthBody("slot@example.com");
  const loaderOpts = await plug.auth.loader(async () => auth);
  assert.equal(loaderOpts.baseURL, CODEX_BASE);
  // Calling loader fetch with an invalid URL still goes through poolFetch validation
  await assert.rejects(loaderOpts.fetch("https://attacker.invalid/images/generations"), /only forwards/);
});

test("runWebImageWorker supports real Python IPC, Chinese UTF-8 payloads, and AbortSignal cancellation", {
  skip: !findPython(),
}, async () => {
  const pythonCmd = findPython();
  const tmp = await mkdtemp(join(tmpdir(), "gptfree-py-worker-"));
  try {
    // 1. Real image_worker.py clean JSON validation on missing prompt (with UTF-8 Chinese text)
    const badPromptRes = await runWebImageWorker(
      { action: "generate_image", access_token: "tok", prompt: "   " },
      { python: async () => pythonCmd },
    );
    assert.equal(badPromptRes.ok, false);
    assert.equal(badPromptRes.http_status, 400);

    // 2. AbortSignal immediately terminates a long-running Python worker process
    const sleepScript = join(tmp, "slow_worker.py");
    await writeFile(sleepScript, "import sys, time\ntime.sleep(30)\n", "utf8");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    await assert.rejects(
      runWebImageWorker(
        { action: "generate_image", prompt: "一只可爱的橘猫" },
        { python: async () => pythonCmd, workerPath: sleepScript, signal: ac.signal },
      ),
      (err) => err.name === "AbortError",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("executeWebImageGeneration stops rotating once maxTotalMs budget is exhausted", async () => {
  const accounts = [1, 2, 3, 4].map((n) => ({
    email: `u${n}@example.com`,
    password: "p",
    totp: seed,
    accessToken: jwt(3600, `u${n}@example.com`),
  }));
  let calls = 0;
  await assert.rejects(
    executeWebImageGeneration({
      accounts,
      request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
      reauthenticate: async (a) => a,
      maxTotalMs: 20,
      runWorker: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 35));
        return { ok: false, http_status: 502, error_code: "upstream_error", error: "transient glitch" };
      },
    }),
    (err) => err.status === 503 && /transient glitch/.test(err.message),
  );
  assert.equal(calls, 1);
});

test("a slow first account no longer blocks the request: the hedge lane wins", async () => {
  const accounts = [1, 2, 3].map((n) => ({
    email: `h${n}@example.com`,
    password: "p",
    totp: seed,
    accessToken: jwt(3600, `h${n}@example.com`),
  }));
  const seen = [];
  const started = Date.now();
  const result = await executeWebImageGeneration({
    accounts,
    request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
    reauthenticate: async (a) => a,
    maxTotalMs: 3_000,
    attemptTimeoutMs: 2_500,
    hedgeDelayMs: 100,
    runWorker: async (payload) => {
      seen.push(payload.access_token);
      // 第一个号慢（900ms），第二路（对冲）60ms 就回来了。
      await new Promise((r) => setTimeout(r, seen.length === 1 ? 900 : 60));
      return { ok: true, data: [{ b64_json: "AAAA" }] };
    },
  });
  assert.equal(seen.length, 2, "the hedge lane must pick a different account");
  assert.notEqual(seen[0], seen[1]);
  assert.equal(result.data.length, 1);
  assert(
    Date.now() - started < 600,
    "the request must return on the hedge result, not wait for the slow first account",
  );
});

// 单号并发闸：`tried` 只保证同一请求内两条 lane 不撞号，但四个并发请求各自的
// 第一条 lane 完全可能挑中同一个号 —— 那个号就被四个 worker 同时打。
// 排序里降权挡不住（四条 lane 各自排序，第一名照样是同一个），必须在这里硬跳过。
test("two concurrent requests never hit the same account when the pool has alternatives", async () => {
  clearAccountInflight();
  const accounts = [1, 2].map((n) => ({
    email: `c${n}@example.com`,
    password: "p",
    totp: seed,
    accessToken: jwt(3600, `c${n}@example.com`),
  }));
  const seen = [];
  let releaseFirst;
  const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });

  const request = { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 };
  const first = executeWebImageGeneration({
    accounts,
    request,
    reauthenticate: async (a) => a,
    maxTotalMs: 5_000,
    // 不打算测对冲：把第二路推远，保证只有一个 lane 在领号。
    hedgeDelayMs: 60_000,
    perAccountInflight: 1,
    runWorker: async (payload) => {
      seen.push(payload.access_token);
      markFirstStarted();
      await holdFirst;
      return { ok: true, data: [{ b64_json: "AAAA" }] };
    },
  });
  try {
    await firstStarted;   // 第一个请求已经攥住 c1
    const second = await executeWebImageGeneration({
      accounts,
      request,
      reauthenticate: async (a) => a,
      maxTotalMs: 5_000,
      hedgeDelayMs: 60_000,
      perAccountInflight: 1,
      runWorker: async (payload) => {
        seen.push(payload.access_token);
        return { ok: true, data: [{ b64_json: "BBBB" }] };
      },
    });
    assert.equal(second.data.length, 1);
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1], "第二个请求必须换一个号，不能压在被占用的号上");
  } finally {
    releaseFirst();
    await first.catch(() => {});
    clearAccountInflight();
  }
});

// 反证：把闸关掉（0 = 不限制）同样的场景就会撞同一个号。
// 没有这条，「上面那个用例通过」也可能只是碰巧。
test("without the gate the same scenario collides on one account", async () => {
  clearAccountInflight();
  const accounts = [1, 2].map((n) => ({
    email: `d${n}@example.com`, password: "p", totp: seed, accessToken: jwt(3600, `d${n}@example.com`),
  }));
  const seen = [];
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const request = { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 };

  const first = executeWebImageGeneration({
    accounts, request, reauthenticate: async (a) => a,
    maxTotalMs: 5_000, hedgeDelayMs: 60_000, perAccountInflight: 0,
    runWorker: async (payload) => {
      seen.push(payload.access_token);
      started();
      await hold;
      return { ok: true, data: [{ b64_json: "AAAA" }] };
    },
  });
  try {
    await started;
    await executeWebImageGeneration({
      accounts, request, reauthenticate: async (a) => a,
      maxTotalMs: 5_000, hedgeDelayMs: 60_000, perAccountInflight: 0,
      runWorker: async (payload) => {
        seen.push(payload.access_token);
        return { ok: true, data: [{ b64_json: "BBBB" }] };
      },
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1], "关掉闸之后两个请求都从队首开始，必然撞号");
  } finally {
    release();
    await first.catch(() => {});
    clearAccountInflight();
  }
});

// 池子只有一个号时不能因为闸而直接不出图：宁可让这个号稍微超载。
test("a single-account pool still serves concurrent requests instead of failing", async () => {
  clearAccountInflight();
  const accounts = [{
    email: "only@example.com", password: "p", totp: seed, accessToken: jwt(3600, "only@example.com"),
  }];
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const request = { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 };

  const first = executeWebImageGeneration({
    accounts, request, reauthenticate: async (a) => a,
    maxTotalMs: 5_000, hedgeDelayMs: 60_000, perAccountInflight: 1,
    runWorker: async () => { started(); await hold; return { ok: true, data: [{ b64_json: "AAAA" }] }; },
  });
  try {
    await started;
    const second = await executeWebImageGeneration({
      accounts, request, reauthenticate: async (a) => a,
      maxTotalMs: 5_000, hedgeDelayMs: 60_000, perAccountInflight: 1,
      runWorker: async () => ({ ok: true, data: [{ b64_json: "BBBB" }] }),
    });
    assert.equal(second.data.length, 1, "只有一个号时也得照常出图");
  } finally {
    release();
    await first.catch(() => {});
    clearAccountInflight();
  }
});

// 计数必须在 finally 里减回来：一次异常不能把这个号永久钉在「满」上。
test("a failed attempt releases the inflight slot", async () => {
  clearAccountInflight();
  const accounts = [{
    email: "boom@example.com", password: "p", totp: seed, accessToken: jwt(3600, "boom@example.com"),
  }];
  await assert.rejects(
    executeWebImageGeneration({
      accounts,
      request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
      reauthenticate: async (a) => a,
      maxTotalMs: 2_000,
      hedgeDelayMs: 60_000,
      perAccountInflight: 1,
      runWorker: async () => { throw new Error("worker exploded"); },
    }),
  );
  assert.equal(accountInflight("boom@example.com"), 0, "失败之后这个号必须重新可用");
  clearAccountInflight();
});

// 首字节来了但没在预算内出图 = worker_slow，不是卡死。这条区分很重要：
// 混成一个码的话，慢模型会把池子里的好号一个个隔离掉。
test("a worker that sends a first byte and then stalls is slow, not hung", async () => {
  const accounts = [{
    email: "slow@example.com", password: "p", totp: seed, accessToken: jwt(3600, "slow@example.com"),
  }];
  const results = [];
  await assert.rejects(
    executeWebImageGeneration({
      accounts,
      request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
      reauthenticate: async (a) => a,
      maxTotalMs: 3_000,
      attemptTimeoutMs: 300,
      hangJudgeMs: 100,
      hedgeDelayMs: 10_000,
      onAccountResult: (e) => results.push(e),
      runWorker: async (_payload, opts) => {
        opts.onProgress("first_byte");
        // 真实 worker 内建单次超时；这里按同样的口径模拟：到点回 worker_timeout。
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({
            ok: false, http_status: 504, error_code: "worker_timeout",
            error: "Image generation worker timed out",
          }), opts.timeout);
          timer.unref?.();
          opts.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve({ ok: false, http_status: 504, error_code: "worker_timeout", error: "aborted" });
          }, { once: true });
        });
      },
    }),
  );
  const slow = results.find((r) => r.errorCode === "worker_slow");
  assert.ok(slow, "首字节来了就该记 worker_slow，而不是 worker_hang");
  assert.equal(results.some((r) => r.errorCode === "worker_hang"), false);
});

// 对冲只在「头号一个字节都没来」时启动。首字节 2.7–5 秒就到了，说明上游在正常
// 推流、只是慢 —— 这时再复制一份请求，等于白烧一张图的额度。
test("no hedge is spawned once the first lane has received a first byte", async () => {
  const accounts = [1, 2].map((n) => ({
    email: `prog${n}@example.com`, password: "p", totp: seed, accessToken: jwt(3600, `prog${n}@example.com`),
  }));
  const seen = [];
  const result = await executeWebImageGeneration({
    accounts,
    request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
    reauthenticate: async (a) => a,
    maxTotalMs: 3_000,
    attemptTimeoutMs: 2_000,
    hedgeDelayMs: 100,
    runWorker: async (payload, opts) => {
      seen.push(payload.access_token);
      opts.onProgress("first_byte");
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, data: [{ b64_json: "AAAA" }] };
    },
  });
  assert.equal(result.data.length, 1);
  assert.equal(seen.length, 1, "头号已经在推流，第二路不该被拉起");
});

// 探索路是另一个诉求（去试没上过场的号），所以给独立开关：
// 打开它，头号在推流时也会起第二路去探；关着（默认）就完全不复制。
test("the explore lane can be re-enabled even while the head is progressing", async () => {
  const accounts = [1, 2].map((n) => ({
    email: `exp${n}@example.com`, password: "p", totp: seed, accessToken: jwt(3600, `exp${n}@example.com`),
  }));
  const seen = [];
  const result = await executeWebImageGeneration({
    accounts,
    request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
    reauthenticate: async (a) => a,
    maxTotalMs: 3_000,
    attemptTimeoutMs: 2_000,
    hedgeDelayMs: 100,
    exploreAccounts: [accounts[1]],
    allowExploreWhileProgressing: true,
    runWorker: async (payload, opts) => {
      seen.push(payload.access_token);
      opts.onProgress("first_byte");
      await new Promise((r) => setTimeout(r, seen.length === 1 ? 500 : 30));
      return { ok: true, data: [{ b64_json: "AAAA" }] };
    },
  });
  assert.equal(result.data.length, 1);
  assert.equal(seen.length, 2, "开了探索开关就该去探第二个号");
});

// 被放弃的尝试以前完全不留痕 —— 上游可能已经生成了，等于白烧额度还查不到。
test("an aborted lane is recorded as attempt_aborted instead of vanishing", async () => {
  const accounts = [1, 2].map((n) => ({
    email: `abor${n}@example.com`, password: "p", totp: seed, accessToken: jwt(3600, `abor${n}@example.com`),
  }));
  const results = [];
  let firstSeen = 0;
  await executeWebImageGeneration({
    accounts,
    request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
    reauthenticate: async (a) => a,
    maxTotalMs: 3_000,
    attemptTimeoutMs: 2_500,
    hedgeDelayMs: 100,
    onAccountResult: (e) => results.push(e),
    runWorker: async (payload, opts) => {
      if (firstSeen++ === 0) {
        // 头号：一个字节都不来，等被掐。这样对冲会正常启动。
        await new Promise((_, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          }, { once: true });
        });
      }
      return { ok: true, data: [{ b64_json: "BBBB" }] };
    },
  });
  // 被放弃的那一路是在后台异步上报的（它不该阻塞胜出的那一路），等一拍再看。
  await new Promise((r) => setTimeout(r, 60));
  const aborted = results.filter((r) => r.errorCode === "attempt_aborted");
  assert.equal(aborted.length, 1, "被放弃的那一路要留一条记录");
  assert.ok(results.some((r) => r.success === true), "另一路应该正常出图");
});

// 出图要 20–35 秒，在此之前一个字节都不发的话，客户端会当成死连接放弃 ——
// 实测它在 26 秒左右就放弃了：既没渲染图片、也没来取图，但我们的响应其实发完了。
test("a streaming request answers immediately with keepalives, then the content", async () => {
  const previous = process.env.MAGPIE_GPTFREE_SSE_KEEPALIVE_MS;
  process.env.MAGPIE_GPTFREE_SSE_KEEPALIVE_MS = "20";
  const png = "iVBORw0KGgo=";
  try {
    const started = Date.now();
    const response = await bridgeChatToImage(
      JSON.stringify({ model: "gpt-image-2", stream: true, messages: [{ role: "user", content: "a cat" }] }),
      {},
      {
        forward: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return new Response(JSON.stringify({ created: 1, data: [{ b64_json: png }] }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        },
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert(Date.now() - started < 150, `响应头必须立刻返回，实际 ${Date.now() - started}ms`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    // 第一帧必须是 **data:** 帧 —— 客户端等的是 data 帧，注释帧对它等于没数据。
    // 实测客户端 5 秒左右就重发了一次请求，就是因为它只看到注释帧。
    assert.match(first, /^data: /, "第一帧要是 data 帧，不能只是注释帧");
    const firstJson = JSON.parse(first.slice("data: ".length).trim());
    assert.equal(firstJson.choices[0].delta.role, "assistant");
    assert.equal(firstJson.choices[0].delta.content, undefined, "role 帧不带内容");

    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value);
    }
    assert.match(rest, /: keepalive/, "生成期间要持续发 keepalive");
    assert.match(rest, /!\[image\]/);
    assert.match(rest, /data: \[DONE\]/);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_GPTFREE_SSE_KEEPALIVE_MS;
    else process.env.MAGPIE_GPTFREE_SSE_KEEPALIVE_MS = previous;
  }
});

// 流式响应一旦发出去就改不了状态码，失败只能按 OpenAI 的惯例放进流里。
// 附带好处：网关不会再把一次 150 秒的失败重试一遍（那是 2 分 32 秒的来源）。
test("a streaming failure comes back as an error frame, not a 5xx", async () => {
  const response = await bridgeChatToImage(
    JSON.stringify({ model: "gpt-image-2", stream: true, messages: [{ role: "user", content: "x" }] }),
    {},
    {
      forward: async () => new Response(JSON.stringify({ error: { message: "上游挂了" } }), {
        status: 500, headers: { "content-type": "application/json" },
      }),
    },
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /"error"/);
  assert.match(text, /上游挂了/);
  assert.match(text, /data: \[DONE\]/);
});

test("a client abort surfaces as AbortError, not a 503", async () => {
  const ctrl = new AbortController();
  const accounts = [{ email: "gone@example.com", password: "p", totp: seed, accessToken: jwt(3600, "gone@example.com") }];
  const running = executeWebImageGeneration({
    accounts,
    request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
    signal: ctrl.signal,
    reauthenticate: async (a) => a,
    maxTotalMs: 5_000,
    runWorker: (_payload, opts) => new Promise((_, reject) => {
      opts.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("Image generation aborted"), { name: "AbortError" }));
      }, { once: true });
    }),
  });
  setTimeout(() => ctrl.abort(), 30);
  await assert.rejects(running, (err) => err.name === "AbortError");
});

test("the timeout error never mentions quota (Magpie classifies by wording)", async () => {
  const accounts = [{ email: "slow@example.com", password: "p", totp: seed, accessToken: jwt(3600, "slow@example.com") }];
  await assert.rejects(
    executeWebImageGeneration({
      accounts,
      request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
      reauthenticate: async (a) => a,
      maxTotalMs: 400,
      runWorker: () => new Promise(() => {}),
    }),
    (err) => {
      assert.equal(err.status, 504);
      assert.match(err.message, /超时/);
      // Magpie 的失败分类正则里有「额度」，一出现就被标成「额度用尽」。
      assert.doesNotMatch(err.message, /额度/);
      return true;
    },
  );
});

test("a quota-exhausted 400 fails over to the next account instead of failing the request", async () => {
  const accounts = [1, 2].map((n) => ({
    email: `q${n}@example.com`,
    password: "p",
    totp: seed,
    accessToken: jwt(3600, `q${n}@example.com`),
  }));
  const seen = [];
  const events = [];
  const result = await executeWebImageGeneration({
    accounts,
    request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
    reauthenticate: async (a) => a,
    onAccountResult: (evt) => { events.push(evt); },
    runWorker: async (payload) => {
      seen.push(payload.access_token);
      if (seen.length === 1) {
        return {
          ok: false,
          http_status: 400,
          error_code: "content_policy_violation",
          error: "你已达到 Free 套餐的图像生成请求上限。上限将在 21小时 后重置，届时可创建更多图像。",
        };
      }
      return { ok: true, data: [{ b64_json: "iVBORw0KGgo=" }] };
    },
  });

  assert.equal(seen.length, 2, "the second account must be tried");
  assert.equal(result.data.length, 1);
  assert.equal(events[0].rateLimited, true, "quota exhaustion counts as rate limiting");
  assert.equal(events[0].errorCode, "quota_exhausted");
  assert.equal(events[0].retryAfter, 21 * 3600, "reset window is parsed from the message");
  assert.equal(events[1].success, true);
});

test("a worker that never returns is cut by the hard budget", async () => {
  const accounts = [1, 2].map((n) => ({
    email: `h${n}@example.com`,
    password: "p",
    totp: seed,
    accessToken: jwt(3600, `h${n}@example.com`),
  }));
  const started = Date.now();
  await assert.rejects(
    executeWebImageGeneration({
      accounts,
      request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
      reauthenticate: async (a) => a,
      maxTotalMs: 2_500,
      runWorker: () => new Promise(() => {}),
    }),
    (err) => err.status === 504 && /超时/.test(err.message),
  );
  assert(Date.now() - started < 5_000, "the budget must end the request");
});

test("pool-stats persists atomically without raw emails, JWTs or URLs and tracks cooldowns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-stats-"));
  const statsFile = join(dir, "pool-stats.json");
  const email = "secret-owner@example.com";
  const secretJwt = jwt(3600, email);
  try {
    await recordQuotaCheck({
      email,
      quota: 9,
      restoreAt: null,
      hasImageLimit: true,
      planType: "free",
    }, { statsFile });
    await recordQuotaCheck({
      email: "broken@example.com",
      error: `Failed fetching https://chatgpt.com/backend-api?tok=${secretJwt} for ${email}`,
    }, { statsFile });

    const raw = await readFile(statsFile, "utf8");
    assert(!raw.includes(email));
    assert(!raw.includes("broken@example.com"));
    assert(!raw.includes(secretJwt));
    assert(!raw.includes("https://chatgpt.com"));
    assert(raw.includes(accountSlotTag(email)));

    const stats = await readPoolStats({ statsFile });
    const rows = [
      { email, accessToken: secretJwt },
      { email: "broken@example.com", accessToken: jwt(3600, "broken@example.com") },
      { email: "unchecked@example.com", accessToken: jwt(3600, "unchecked@example.com") },
    ];
    const summary = summarizePoolStats(rows, stats);
    assert.equal(summary.quotaStats.total, 3);
    assert.equal(summary.quotaStats.active, 1);
    assert.equal(summary.quotaStats.errored, 1);
    assert.equal(summary.quotaStats.unchecked, 1);
    assert.equal(summary.quotaStats.totalQuota, 9);
    assert.equal(summary.accounts[0].planType, "free");
    assert.equal(summary.accounts[1].quotaStatus, "error");
    assert(!JSON.stringify(summary).includes("secret-owner@example.com"));

    // Rate-limit expiry behavior
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    const store = createInMemoryStatsStore();
    await recordQuotaCheck({ email, quota: 0, restoreAt: pastIso }, { statsStore: store });
    const s1 = await readPoolStats({ statsStore: store });
    assert.equal(isAccountRateLimited(email, s1), false);
    await recordQuotaCheck({ email, quota: 0, restoreAt: futureIso }, { statsStore: store });
    const s2 = await readPoolStats({ statsStore: store });
    assert.equal(isAccountRateLimited(email, s2), true);
    assert(!sanitizeStatsMessage("err https://example.com user@test.com").includes("https://"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("probeAccountImageQuota & refreshPoolAccount probe quota with 401 reauth and respect quotaOnly", async () => {
  const acc = { email: "probe@example.com", password: "p", totp: seed, accessToken: jwt(3600, "probe@example.com") };
  const renewedToken = jwt(3600, "probe@example.com") + "fresh";
  const store = createInMemoryStatsStore();

  let workerCalls = 0;
  const probeRes = await probeAccountImageQuota(acc, {
    statsStore: store,
    reauthenticate: async (a) => ({ ...a, accessToken: renewedToken }),
    runWorker: async (payload) => {
      assert.equal(payload.action, "check_image_quota");
      workerCalls++;
      if (workerCalls === 1) {
        return { ok: false, http_status: 401, error_code: "unauthorized", error: "expired" };
      }
      assert.equal(payload.access_token, renewedToken);
      return { ok: true, quota: 14, restore_at: null, has_image_limit: true, plan_type: "plus" };
    },
  });
  assert.equal(probeRes.ok, true);
  assert.equal(probeRes.renewed, true);
  assert.equal(probeRes.imageQuota, 14);
  assert.equal(probeRes.planType, "plus");

  const direct = await checkWebImageQuota({ accessToken: "" });
  assert.equal(direct.ok, false);
  assert.equal(direct.http_status, 401);

  let verifyCalls = 0;
  const quotaOnlyRes = await refreshPoolAccount(
    { ...acc, accessToken: renewedToken },
    {
      quotaOnly: true,
      statsStore: store,
      verify: async () => { verifyCalls++; return { accepted: true }; },
      runWorker: async () => ({ ok: true, quota: 11, restore_at: null, has_image_limit: true, plan_type: "free" }),
    },
  );
  assert.equal(verifyCalls, 0);
  assert.equal(quotaOnlyRes.quotaOk, true);
  assert.equal(quotaOnlyRes.imageQuota, 11);
});

test("poolFetch image generation updates stats, avoids double-fail on 401 reauth, and deprioritizes rate-limited slots", async () => {
  const accA = { email: "slotA@example.com", password: "p", totp: seed, accessToken: jwt(3600, "slotA@example.com") };
  const accB = { email: "slotB@example.com", password: "p", totp: seed, accessToken: jwt(3600, "slotB@example.com") };
  const renewedB = jwt(3600, "slotB@example.com") + "2";
  const slotA = accountSlotTag(accA.email);
  const store = createInMemoryStatsStore();

  await recordQuotaCheck({ email: accA.email, quota: 5, hasImageLimit: true }, { statsStore: store });
  await recordQuotaCheck({ email: accB.email, quota: 5, hasImageLimit: true }, { statsStore: store });

  // Call 1: preferred slot A rate-limits (429), fails over to B which hits 401 -> reauth -> succeeds.
  // Should record 1 fail (A only), 1 success (B), B quota decremented to 4, A quota marked 0 (rate limited).
  const firstRes = await poolFetch(CODEX_BASE + "/images/generations", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-image-2", prompt: "neon owl" }),
  }, {
    read: async () => [accA, accB],
    preferredSlot: slotA,
    statsStore: store,
    reauthenticate: async (a) => ({ ...a, accessToken: renewedB }),
    runWorker: async (payload) => {
      if (payload.access_token === accA.accessToken) {
        return { ok: false, http_status: 429, error_code: "rate_limited", error: "limit reached", retry_after: 1200 };
      }
      if (payload.access_token === accB.accessToken) {
        return { ok: false, http_status: 401, error_code: "unauthorized", error: "expired" };
      }
      return {
        ok: true,
        created: 1731150000,
        data: [{ b64_json: Buffer.from("png").toString("base64"), media_type: "image/png" }],
      };
    },
  });
  assert.equal(firstRes.status, 200);
  const sAfterFirst = summarizePoolStats([accA, accB], await readPoolStats({ statsStore: store }));
  assert.equal(sAfterFirst.quotaStats.limited, 1);
  assert.equal(sAfterFirst.quotaStats.active, 1);
  assert.equal(sAfterFirst.quotaStats.totalQuota, 4);
  assert.equal(sAfterFirst.quotaStats.totalSuccess, 1);
  assert.equal(sAfterFirst.quotaStats.totalFail, 1);

  // Call 2: even if preferredSlot points to rate-limited A, non-limited B is tried FIRST!
  const callOrder = [];
  const secondRes = await poolFetch(CODEX_BASE + "/images/generations", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-image-2", prompt: "blue sky" }),
  }, {
    read: async () => [accA, accB],
    preferredSlot: slotA,
    statsStore: store,
    runWorker: async (payload) => {
      callOrder.push(payload.access_token);
      return {
        ok: true,
        created: 1731150001,
        data: [{ b64_json: Buffer.from("png2").toString("base64"), media_type: "image/png" }],
      };
    },
  });
  assert.equal(secondRes.status, 200);
  assert.deepEqual(callOrder, [accB.accessToken]);
  const sAfterSecond = summarizePoolStats([accA, accB], await readPoolStats({ statsStore: store }));
  assert.equal(sAfterSecond.quotaStats.totalQuota, 3);
  assert.equal(sAfterSecond.quotaStats.totalSuccess, 2);
});

// 第二路（对冲路）要优先去探「从没被派过活」的号，而不是顺着队列拿下一个。
// 线上 121 个号里 55 个 `lastUsedAt` 全为空：额度低（2~5）在额度加权轮转里
// 永远排最后，一次都没上过场。用第二路去探它们，赢了白赚、输了不占第一路预算。
test("the hedge lane explores an unproven account instead of the next one in order", async () => {
  const mk = (n) => ({
    email: `x${n}@example.com`,
    password: "p",
    totp: seed,
    accessToken: jwt(3600, `x${n}@example.com`),
  });
  const accounts = [mk(1), mk(2), mk(3), mk(4)];
  const seen = [];
  const result = await executeWebImageGeneration({
    accounts,
    request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
    reauthenticate: async (a) => a,
    maxTotalMs: 3_000,
    attemptTimeoutMs: 2_500,
    hedgeDelayMs: 100,
    // 只有第 4 个号是「未验证」的：正常顺序它排在最后，第二路应该直接跳过去。
    exploreAccounts: [accounts[3]],
    runWorker: async (payload) => {
      seen.push(payload.access_token);
      await new Promise((r) => setTimeout(r, seen.length === 1 ? 900 : 60));
      return { ok: true, data: [{ b64_json: "AAAA" }] };
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], accounts[0].accessToken, "the first lane keeps the weighted head");
  assert.equal(seen[1], accounts[3].accessToken, "the hedge lane must jump to the explorer");
  assert.equal(result.data.length, 1);
});

// 上游一个字节都不来 = 这个号卡死了，不该等满单次上限才换号。
// 实测正常号的首字节是 2.9~4.5 秒，卡死号永远不来；所以给一个远小于单次上限的
// 判定线，卡死号立刻出局，同样的预算能多试好几个号。
test("an account that never sends an upstream byte is dropped at the hang threshold", async () => {
  const accounts = [1, 2, 3].map((n) => ({
    email: `hang${n}@example.com`,
    password: "p",
    totp: seed,
    accessToken: jwt(3600, `hang${n}@example.com`),
  }));
  const seen = [];
  const results = [];
  const started = Date.now();
  const result = await executeWebImageGeneration({
    accounts,
    request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
    reauthenticate: async (a) => a,
    maxTotalMs: 5_000,
    attemptTimeoutMs: 4_000,
    hangJudgeMs: 100,
    hedgeDelayMs: 10_000, // 关掉对冲，只验证单路的卡死判定
    onAccountResult: (e) => { results.push(e); },
    runWorker: async (payload, opts) => {
      seen.push(payload.access_token);
      if (seen.length === 1) {
        // 卡死：永远不返回、也从不发 first_byte，只等着被 abort。
        await new Promise((_, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          }, { once: true });
        });
      }
      return { ok: true, data: [{ b64_json: "AAAA" }] };
    },
  });
  assert.equal(seen.length, 2, "the hung account must be dropped and the next one tried");
  // 一个字节都没来 = worker_hang（真卡死），和「首字节来了但慢」要分开。
  assert.equal(results[0].errorCode, "worker_hang");
  assert.match(results[0].errorMessage, /没有任何响应/);
  assert.equal(result.data.length, 1);
  assert(Date.now() - started < 2_000, "the hang must not cost the full attempt timeout");
});

test("bridge: 会话标题任务本地作答，不碰号池（含三条反证）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-bridge-title-"));
  process.env.MAGPIE_GPTFREE_IMAGE_DIR = dir;
  process.env.MAGPIE_GPTFREE_HOME = dir;
  process.env.MAGPIE_GPTFREE_PUBLIC_BASE = "https://rk.example.test";
  delete process.env.MAGPIE_GPTFREE_IMAGE_REPLY;
  delete process.env.MAGPIE_GPTFREE_BRIDGE_TITLE_FASTPATH;
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    let calls = 0;
    const forward = async () => {
      calls++;
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: png }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    // 线上真实形状：2KB 以内的 system，要一个 {"isNewTopic","title"} 的 JSON。
    const titleSystem = "Generate a concise, sentence-case title (3-7 words) that captures the main "
      + "topic or goal of this session. Respond with EXACTLY one JSON object and nothing else: "
      + "{\"isNewTopic\": boolean, \"title\": string}";
    const agentSystem = "This conversation is powered by gpt-image-2\n\n" + "x".repeat(40_000);

    // 1) 标题任务：上游一次都不能打
    const plain = await bridgeChatToImage(JSON.stringify({
      model: "gpt-image-2",
      messages: [
        { role: "system", content: titleSystem },
        { role: "user", content: "<session>\nfix login button on mobile\n</session>" },
      ],
    }), {}, { forward });
    assert.equal(calls, 0, "标题任务不许碰号池：碰一次就是一张白烧的图");
    const title = JSON.parse((await plain.json()).choices[0].message.content);
    assert.deepEqual(title, { isNewTopic: true, title: "Fix login button on mobile" });

    // 中文按字截，且不能把 <session> 标签带进标题
    const cjk = await bridgeChatToImage(JSON.stringify({
      model: "gpt-image-2",
      messages: [
        { role: "system", content: titleSystem },
        { role: "user", content: "<session>\n在夏夜，有淡蓝色的星空，海边，流星，烟花，海滩上全是蓝玫瑰和绿色植物\n</session>" },
      ],
    }), {}, { forward });
    const cjkTitle = JSON.parse((await cjk.json()).choices[0].message.content).title;
    assert.equal(calls, 0);
    assert(!cjkTitle.includes("<session>"));
    assert(cjkTitle.startsWith("在夏夜"));
    assert(cjkTitle.length <= 18, "中文标题按字截，别给半句话");

    // 流式也是同一个 JSON，一帧发完
    const streamed = await bridgeChatToImage(JSON.stringify({
      model: "gpt-image-2", stream: true,
      messages: [
        { role: "system", content: titleSystem },
        { role: "user", content: "<session>\nfix login button on mobile\n</session>" },
      ],
    }), {}, { forward });
    assert.match(streamed.headers.get("content-type"), /text\/event-stream/);
    const deltas = (await streamed.text()).split("\n\n")
      .filter((chunk) => chunk.startsWith("data: ") && !chunk.includes("[DONE]"))
      .map((chunk) => JSON.parse(chunk.slice(6)).choices[0].delta.content)
      .filter((text) => typeof text === "string");
    assert.equal(deltas.length, 1);
    assert.equal(calls, 0);
    assert.deepEqual(JSON.parse(deltas[0]), { isNewTopic: true, title: "Fix login button on mobile" });

    // 反证 A：system 短、但不像标题任务 → 照常生图（否则就是把真画图也拦了）
    await bridgeChatToImage(JSON.stringify({
      model: "gpt-image-2",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "a red apple" },
      ],
    }), {}, { forward });
    assert.equal(calls, 1, "短 system 不等于标题任务");

    // 反证 B：agent 主回合（43KB system + tools）→ 照常生图
    await bridgeChatToImage(JSON.stringify({
      model: "gpt-image-2",
      tools: [{ type: "function", function: { name: "Read" } }],
      messages: [
        { role: "system", content: agentSystem },
        { role: "user", content: "a red apple" },
      ],
    }), {}, { forward });
    assert.equal(calls, 2, "带 tools 的 agent 回合必须照常生图");

    // 反证 C：带图（改图）就算 system 像标题任务，也不能跳过
    await bridgeChatToImage(JSON.stringify({
      model: "gpt-image-2",
      messages: [
        { role: "system", content: titleSystem },
        {
          role: "user",
          content: [
            { type: "text", text: "把背景换成蓝色" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
          ],
        },
      ],
    }), {}, { forward });
    assert.equal(calls, 3, "带图的请求是改图，不能走标题快路");
  } finally {
    delete process.env.MAGPIE_GPTFREE_IMAGE_DIR;
    delete process.env.MAGPIE_GPTFREE_HOME;
    delete process.env.MAGPIE_GPTFREE_PUBLIC_BASE;
    await rm(dir, { recursive: true, force: true });
  }
});
