/**
 * 本地补丁（不是上游代码）：把 chat/completions 上的图片模型请求桥接到 images 端点。
 *
 * 背景：magpie-gptfree 只允许图片模型走 /v1/images/generations 或 /v1/images/edits，
 * 对 /v1/chat/completions 一律 400：
 *   "This image model does not support /v1/chat/completions; use ... instead."
 *
 * 但大多数聊天客户端（WorkBuddy、Cherry Studio、LobeChat …）只会说 chat/completions，
 * 于是「选一个图片模型，然后让它画张图」必然失败。
 *
 * 这个文件把最后一条 user 消息抽出来：
 *   - 纯文本                → /images/generations
 *   - 带图（image_url part） → /images/edits（改图）
 * 生成结果包成 chat.completion 返回，正文默认是「内联图 + 紧跟一行裸地址」（一行一个
 * 地址，多图组间空一行）；图片落在 /config/images（宿主机 /var/www/magpie-images），
 * 由 nginx 的 /img/ 对外提供。
 *
 * 为什么正文里还要带一行裸地址：客户端「复制」复制的是正文文本，只给 markdown 的话
 * 粘到微信/文档里是一行源码；而图片是框架自己画的、没有「拷贝图像」，位图进不了剪贴板。
 * 服务端能改的只有这段文本，所以两样都给：图负责渲染，地址负责复制转发。
 * 形态在面板「回复格式」里选（持久化到 ~/.magpie-gptfree/settings.json），
 * 环境变量 MAGPIE_GPTFREE_IMAGE_REPLY 优先，用来强制覆盖。
 *
 * 由 /root/fix-gptfree-chat-image.sh 安装；插件升级覆盖 lib/ 后重跑一次即可。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isImageModelId } from "./chatgpt-web-image.mjs";
import { readImageReplyMode } from "./reply-settings.mjs";

// 默认落在容器的 /config/images（宿主机 /var/www/magpie-images，由 nginx 的
// /img/ 对外）。测试和本机跑的时候用 MAGPIE_GPTFREE_IMAGE_DIR 指到别处。
function imageDir() {
  return process.env.MAGPIE_GPTFREE_IMAGE_DIR || "/config/images";
}
// 图片对外地址的前缀。留空就回相对路径（/img/xxx.png），由调用方的页面自己解析。
// 需要绝对地址时用 MAGPIE_GPTFREE_PUBLIC_BASE 指定，比如 https://你的域名 ——
// 这样代码里不绑任何具体主机。每次现读，改环境变量不用重启模块。
function publicBase() {
  return (process.env.MAGPIE_GPTFREE_PUBLIC_BASE || "").replace(/\/+$/, "");
}
// 正文形态：both（默认，内联图 + 紧跟一行裸地址）| url（只要地址）| markdown（只要内联图）。
// both 是「看着有图、同时能拿到地址」：客户端没有「拷贝图像」，光有图拿不到位图；
// 光有地址又要多点一次才看得见。代价是复制拿到两行，第一行是 markdown 字面量 ——
// 需要干净地址时单独选中第二行复制即可。
//
// 值从 reply-settings 读：面板里选（存 ~/.magpie-gptfree/settings.json，重启还在），
// 环境变量 MAGPIE_GPTFREE_IMAGE_REPLY 优先，用来强制覆盖。
async function replyMode() {
  return (await readImageReplyMode()).mode;
}
const DEBUG = process.env.MAGPIE_GPTFREE_CHAT_IMAGE_DEBUG === "1";

const MAX_IMAGES = 4;
// 上游单次只出一张，n>1 要并发多打几次。并发上限和 index.mjs 的 auth.maxConcurrency
// 对齐：再多 magpie 会拒，排队反而更稳。
const MAX_CONCURRENCY = 2;
const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const RETENTION_MS = 7 * 24 * 3600 * 1000;
const PRUNE_INTERVAL_MS = 3600 * 1000;

let lastPruneAt = 0;

function bodyText(rawBody) {
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody).toString("utf8");
  if (rawBody instanceof ArrayBuffer) return Buffer.from(rawBody).toString("utf8");
  return String(rawBody || "");
}

/** 从最后一条 user 消息里取文本和图片。 */
function readLastUserTurn(messages) {
  if (!Array.isArray(messages)) return { prompt: "", images: [] };
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      return { prompt: msg.content.trim(), images: [] };
    }
    if (!Array.isArray(msg.content)) continue;
    const texts = [];
    const images = [];
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      if (typeof part.text === "string" && part.text.trim()) {
        texts.push(part.text.trim());
      } else if (part.type === "image_url") {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        if (typeof url === "string" && url) images.push(url);
      } else if (part.type === "input_image" && typeof part.image_url === "string") {
        images.push(part.image_url);
      }
    }
    return { prompt: texts.join("\n").trim(), images: images.slice(0, MAX_IMAGES) };
  }
  return { prompt: "", images: [] };
}

/** 远端图片转 data URL（插件只收 base64，不收 http 链接）。 */
async function inlineImage(url) {
  if (/^data:image\//i.test(url)) return url;
  if (!/^https?:\/\//i.test(url)) return "";
  try {
    const controller = typeof AbortSignal !== "undefined" && AbortSignal.timeout
      ? AbortSignal.timeout(15000)
      : undefined;
    const res = await fetch(url, controller ? { signal: controller } : {});
    if (!res.ok) return "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_REMOTE_IMAGE_BYTES) return "";
    const mime = String(res.headers.get("content-type") || "image/png").split(";")[0].trim();
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return "";
  }
}

function sniffExt(b64) {
  if (b64.startsWith("iVBORw0KGgo")) return "png";
  if (b64.startsWith("/9j/")) return "jpg";
  if (b64.startsWith("UklGR")) return "webp";
  if (b64.startsWith("R0lGOD")) return "gif";
  return "png";
}

async function pruneOldImages() {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  try {
    for (const name of await readdir(imageDir())) {
      const path = join(imageDir(), name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > RETENTION_MS) await unlink(path);
      } catch {}
    }
  } catch {}
}

async function persistImage(b64) {
  const name = `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}.${sniffExt(b64)}`;
  await mkdir(imageDir(), { recursive: true });
  await writeFile(join(imageDir(), name), Buffer.from(b64, "base64"), { mode: 0o644 });
  pruneOldImages().catch(() => {});
  const base = publicBase();
  return { name, url: base ? `${base}/img/${name}` : `/img/${name}` };
}

function completionPayload(content, model) {
  return {
    id: "chatcmpl-" + randomBytes(12).toString("hex"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sseResponse(content, model) {
  const base = {
    id: "chatcmpl-" + randomBytes(12).toString("hex"),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function bridgeChatToImage(rawBody, init, ctx) {
  let parsed = {};
  try {
    parsed = JSON.parse(bodyText(rawBody) || "{}") || {};
  } catch {
    return json({ error: { message: "Invalid chat request body", type: "invalid_request_error" } }, 400);
  }

  const model = String(parsed.model || "").trim();
  if (!isImageModelId(model)) {
    return json({
      error: {
        message: "Codex models on this provider require /v1/responses instead of /v1/chat/completions.",
        type: "invalid_request_error",
      },
    }, 400);
  }

  const turn = readLastUserTurn(parsed.messages);
  if (!turn.prompt) {
    return json({
      error: { message: "No text prompt found in the last user message", type: "invalid_request_error" },
    }, 400);
  }

  // 带图就改图，纯文本就生图
  const inputImages = [];
  for (const raw of turn.images) {
    const inlined = await inlineImage(raw);
    if (inlined) inputImages.push(inlined);
  }
  const isEdit = inputImages.length > 0;
  const endpoint = isEdit ? "/images/edits" : "/images/generations";

  const n = Number.isFinite(Number(parsed.n)) ? Math.min(Math.max(Number(parsed.n), 1), MAX_IMAGES) : 1;
  const imageBody = {
    model,
    prompt: turn.prompt,
    ...(parsed.size ? { size: String(parsed.size) } : {}),
    ...(parsed.quality ? { quality: String(parsed.quality) } : {}),
    ...(parsed.background ? { background: String(parsed.background) } : {}),
    ...(isEdit ? { images: inputImages } : {}),
  };
  // 上游单次调用只出一张（原生接口的 n 是 magpie 网关在外面循环实现的），
  // 所以 n>1 就并发打 n 次，每次 body 里的 n 固定为 1，免得被上游按 n 重复计数。
  const singleBody = JSON.stringify({ ...imageBody, n: 1 });

  if (DEBUG) {
    console.error("[chat-image-bridge] model=%s kind=%s promptChars=%d images=%d n=%d",
      model, isEdit ? "edit" : "generate", turn.prompt.length, inputImages.length, n);
  }

  const startedAt = Date.now();
  // 并发上限和 index.mjs 的 auth.maxConcurrency 对齐：再多会被 magpie 拒，排队反而稳。
  const attempts = new Array(n);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= n) return;
      try {
        attempts[index] = { ok: true, response: await ctx.forward(endpoint, singleBody) };
      } catch (error) {
        attempts[index] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, MAX_CONCURRENCY) }, worker));

  // 顺序按提交顺序拼接，保证和 links 一致。部分成功也要返回：多图场景下
  // 一张失败不该毁掉整次请求，只在全部失败时才报错。
  const links = [];
  const failures = [];
  for (const attempt of attempts) {
    if (!attempt.ok) {
      failures.push({ status: 502, code: "", message: `图片生成失败：${attempt.error?.message || attempt.error}` });
      continue;
    }
    const upstream = attempt.response;
    let payload = null;
    try {
      payload = await upstream.json();
    } catch {}
    if (!upstream.ok || !Array.isArray(payload?.data) || !payload.data.length) {
      failures.push({
        status: upstream.ok ? 502 : upstream.status,
        code: payload?.error?.code || "",
        message: payload?.error?.message || `图片生成失败（HTTP ${upstream.status}）`,
      });
      continue;
    }
    for (const item of payload.data) {
      if (item?.url) {
        links.push(item.url);
        continue;
      }
      if (!item?.b64_json) continue;
      try {
        const saved = await persistImage(item.b64_json);
        links.push(saved.url);
      } catch (err) {
        // 落盘失败就退回内联 data URL，至少客户端能看到图
        console.error("[chat-image-bridge] persist failed: %s", err?.message || err);
        links.push(`data:image/${sniffExt(item.b64_json)};base64,${item.b64_json}`);
      }
    }
  }

  if (!links.length) {
    // 报哪一条：优先「请求的错」（4xx / 预算到点），它信息量最大也最该让客户端看见；
    // 全是 5xx 时才拿第一条。文案和状态映射保持 0.8.9 的样子。
    const failure = failures.find((f) => f.code === "request_timeout" || (f.status >= 400 && f.status < 500)) ||
      failures[0] || {};
    const message = failure.message || "图片生成成功但没拿到图片数据";
    console.error("[chat-image-bridge] %s failed in %dms (%d/%d): %s",
      endpoint, Date.now() - startedAt, failures.length, n, message);
    // 预算到点（504 request_timeout）在 magpie 网关眼里是「可重试的 5xx」，它会再
    // 打一遍，55 秒的失败就被拖成 80 秒，客户端直接放弃、连错误都看不到。这类
    // 失败重试也救不回来（号池里没号能出图），所以对外报成不可重试的 4xx。
    const status = failure.code === "request_timeout" ? 400 : (failure.status || 502);
    return json({ error: { message, type: "invalid_request_error", ...(failure.code ? { code: failure.code } : {}) } }, status);
  }

  if (failures.length) {
    console.error("[chat-image-bridge] %s partial in %dms: %d/%d images, %d failed (%s)",
      endpoint, Date.now() - startedAt, links.length, n, failures.length,
      failures.map((f) => f.message).join(" | "));
  } else {
    console.error("[chat-image-bridge] %s ok in %dms model=%s images=%d",
      endpoint, Date.now() - startedAt, model, links.length);
  }

  // both 时每张图一组（内联图 + 裸地址，两行之间不空行），组与组之间空一行；
  // 顺序与 links 一致。
  const mode = await replyMode();
  const content = mode === "markdown"
    ? links.map((u) => `![image](${u})`).join("\n")
    : mode === "url"
      ? links.join("\n")
      : links.map((u) => `![image](${u})\n${u}`).join("\n\n");
  return parsed.stream ? sseResponse(content, model) : json(completionPayload(content, model), 200);
}
