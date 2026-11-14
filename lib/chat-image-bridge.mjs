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
 * 生成结果包成 chat.completion 返回，正文是 markdown 图片链接；图片落在
 * /config/images（宿主机 /var/www/magpie-images），由 nginx 的 /img/ 对外提供。
 *
 * 由 /root/fix-gptfree-chat-image.sh 安装；插件升级覆盖 lib/ 后重跑一次即可。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isImageModelId } from "./chatgpt-web-image.mjs";

const IMAGE_DIR = "/config/images";
const PUBLIC_BASE = (process.env.MAGPIE_GPTFREE_PUBLIC_BASE || "https://example.com").replace(/\/+$/, "");
const DEBUG = process.env.MAGPIE_GPTFREE_CHAT_IMAGE_DEBUG === "1";

const MAX_IMAGES = 4;
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
    for (const name of await readdir(IMAGE_DIR)) {
      const path = join(IMAGE_DIR, name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > RETENTION_MS) await unlink(path);
      } catch {}
    }
  } catch {}
}

async function persistImage(b64) {
  const name = `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}.${sniffExt(b64)}`;
  await mkdir(IMAGE_DIR, { recursive: true });
  await writeFile(join(IMAGE_DIR, name), Buffer.from(b64, "base64"), { mode: 0o644 });
  pruneOldImages().catch(() => {});
  return { name, url: `${PUBLIC_BASE}/img/${name}` };
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
  const imageBody = JSON.stringify({
    model,
    prompt: turn.prompt,
    n,
    ...(parsed.size ? { size: String(parsed.size) } : {}),
    ...(parsed.quality ? { quality: String(parsed.quality) } : {}),
    ...(parsed.background ? { background: String(parsed.background) } : {}),
    ...(isEdit ? { images: inputImages } : {}),
  });

  if (DEBUG) {
    console.error("[chat-image-bridge] model=%s kind=%s promptChars=%d images=%d",
      model, isEdit ? "edit" : "generate", turn.prompt.length, inputImages.length);
  }

  const startedAt = Date.now();
  let upstream;
  try {
    upstream = await ctx.forward(endpoint, imageBody);
  } catch (err) {
    console.error("[chat-image-bridge] forward failed: %s", err?.message || err);
    return json({ error: { message: `图片生成失败：${err?.message || err}`, type: "server_error" } }, 502);
  }

  let payload = null;
  try {
    payload = await upstream.json();
  } catch {}

  if (!upstream.ok || !Array.isArray(payload?.data) || !payload.data.length) {
    const message = payload?.error?.message || `图片生成失败（HTTP ${upstream.status}）`;
    console.error("[chat-image-bridge] %s failed in %dms: %s", endpoint, Date.now() - startedAt, message);
    return json({ error: { message, type: "invalid_request_error" } }, upstream.ok ? 502 : upstream.status);
  }

  const links = [];
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

  if (!links.length) {
    console.error("[chat-image-bridge] %s returned no usable image", endpoint);
    return json({ error: { message: "图片生成成功但没拿到图片数据", type: "server_error" } }, 502);
  }

  console.error("[chat-image-bridge] %s ok in %dms model=%s images=%d",
    endpoint, Date.now() - startedAt, model, links.length);

  const content = links.map((u) => `![image](${u})`).join("\n");
  return parsed.stream ? sseResponse(content, model) : json(completionPayload(content, model), 200);
}
