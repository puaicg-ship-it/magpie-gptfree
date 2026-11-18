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
import { isImageModelId } from "./chatgpt-web-image.mjs";
import { readImageReplyMode } from "./reply-settings.mjs";
import { saveImage, sniffExt } from "./image-store.mjs";

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
// 上游单次只出一张，n>1 要并发多打几次。0.9.0 起 auth.maxConcurrency 是**整个
// 号池**的上限（4），而这里每张图还会再起最多 2 条 lane —— 所以这张图内并发压到
// 2：最坏情况 4 个请求 × 2 张 × 2 lane 会铺出 16 个 python worker，没必要。
const MAX_CONCURRENCY = 2;
const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;

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

/**
 * 「这是一次会话标题任务，不是画图」——判定器。
 *
 * 为什么需要它：模型判不了。2026-11-18 线上抓到的事实是，同一个会话里
 *   - 会话标题请求：system 2KB（"Generate a concise, sentence-case title…"，
 *     要一个 {"isNewTopic":…,"title":…} 的 JSON），模型字段 gpt-image2.6；
 *   - agent 主回合：system 38–43KB + tools 17–26KB，模型字段同样是 gpt-image2.6。
 * 桥只按 `isImageModelId(model)` 判，于是标题请求也去真生图：23 秒、一个账号额度、
 * 一张没有任何客户端会来取的图（nginx 里查不到那次 /img/）。当天 30 张落盘只有
 * 11 张被取用，六成是这么白烧的。
 *
 * 所以只能看**请求形态**。三条同时成立才算标题任务，宁可漏判也不误判：
 *   1. 没有 tools / functions —— agent 回合一定带，真画图请求也常带；
 *   2. 首条 system 存在且很短（< 4096）—— agent 回合的 system 是 38KB 起；
 *   3. system 里同时出现 "title" 和 "isNewTopic" / "sentence-case" / "JSON object"。
 * 带图的请求直接排除（那是改图，不能跳过）。
 */
const TITLE_SYSTEM_MAX = 4096;
const TITLE_SIGNATURES = [/isNewTopic/i, /sentence-?case/i, /json object/i];

function firstSystemText(messages) {
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (!msg || msg.role !== "system") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n");
    }
    return "";
  }
  return "";
}

function isTitleTask(parsed, turn) {
  if (process.env.MAGPIE_GPTFREE_BRIDGE_TITLE_FASTPATH === "0") return false;
  if (turn.images.length) return false;
  if (Array.isArray(parsed.tools) && parsed.tools.length) return false;
  if (Array.isArray(parsed.functions) && parsed.functions.length) return false;
  const system = firstSystemText(parsed.messages);
  if (!system || system.length > TITLE_SYSTEM_MAX) return false;
  if (!/title/i.test(system)) return false;
  return TITLE_SIGNATURES.some((re) => re.test(system));
}

/**
 * 本地凑一个标题，不再花一次生图。
 *
 * 规则和模型被要求的一样：3–7 个词、sentence case。中文按字截，西文按词截。
 * 截断宁可短一点 —— 标题被截短没人会注意，截出半句话才难看。
 */
function deriveTitle(text) {
  const body = String(text || "")
    .replace(/<\/?session>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!body) return "新会话";
  const cjk = (body.match(/[\u3400-\u9fff\u3040-\u30ff]/g) || []).length;
  if (cjk >= 4) {
    const cut = body.slice(0, 18).replace(/[，。、；：,.;:!?！？"'”’）)]+$/, "").trim();
    return cut || "新会话";
  }
  const words = body.split(/\s+/).slice(0, 6).join(" ").replace(/[.,;:!?"'”’]+$/, "");
  if (!words) return "新会话";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** 标题任务的回应：客户端要的是一整个 JSON 对象，别的什么都不要加。 */
function titleResponse(parsed, model, title) {
  const content = JSON.stringify({ isNewTopic: true, title });
  if (parsed.stream) return sseResponse(content, model);
  return json(completionPayload(content, model), 200);
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

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

/** 注释帧：SSE 规范里以 `:` 开头的行客户端会忽略，只用来表示「连接还活着」。 */
const KEEPALIVE_FRAME = ": keepalive\n\n";
// 5 秒是折中：够密（客户端 10–15 秒的空闲超时都能被续上），又不至于把日志刷满。
// 个别客户端更急就调 env，不用改代码。**每次调用现读**，不要在模块加载时算死 ——
// 那样测试改 env 不生效，只能测到「第一帧」而测不到「持续发」。
function keepaliveMs() {
  const raw = Number(process.env.MAGPIE_GPTFREE_SSE_KEEPALIVE_MS);
  return Number.isFinite(raw) && raw >= 20 ? Math.round(raw) : 5_000;
}

function newCompletionId() {
  return "chatcmpl-" + randomBytes(12).toString("hex");
}

/**
 * 流的第一帧：只带 `role`，不带内容。OpenAI 自己也是这么开的头。
 *
 * 为什么必须有：客户端解析 SSE 时等的是 **`data:` 帧**，不是注释帧。以前我们
 * 在出图前只发 `: keepalive`，对客户端来说等于「28 秒里什么都没来」——
 * 实测它 5 秒左右就重发了一次请求，于是一次点击生成了两张图、烧了两份额度。
 */
function sseRoleFrame(model, id) {
  const frame = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(frame)}\n\n`;
}

function sseFrames(content, model, id = newCompletionId()) {
  const base = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

function sseResponse(content, model) {
  return new Response(sseFrames(content, model), { status: 200, headers: SSE_HEADERS });
}

/**
 * 流式返回：**立刻**建好响应，生成过程中每 5 秒发一条注释帧。
 *
 * 为什么必须这样：出图要 20–35 秒，而在此之前我们一个字节都不发。实测客户端
 * 在 26 秒左右就放弃了 —— 它随后既没渲染图片、也没来取图（nginx 里查不到那次
 * 的 /img/ 请求），但我们的响应其实是完整发出去的。长连接上「长时间零字节」
 * 会被很多 HTTP 客户端当成死连接。
 *
 * 失败时不能再改 HTTP 状态（已经发出去了），所以按 OpenAI 的惯例发一条
 * `data: {"error": ...}` 再收尾。附带的好处：网关不会再把一次 150 秒的失败
 * 重试一遍（那是 2 分 32 秒的来源）。
 */
function streamingSse(run, model) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (text) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      const id = newCompletionId();
      // 先发 role 帧（客户端据此认为「模型开始回复了」），再发注释帧续命。
      send(sseRoleFrame(model, id));
      send(KEEPALIVE_FRAME);
      const timer = setInterval(() => send(KEEPALIVE_FRAME), keepaliveMs());
      timer.unref?.();
      try {
        const content = await run();
        // 用同一个 id 收尾，客户端按 id 归组时不会分裂成两条消息。
        send(sseFrames(content, model, id));
      } catch (err) {
        const payload = err?.bridgePayload || {
          error: {
            message: String(err?.message || "图片生成失败"),
            type: "server_error",
            ...(err?.code ? { code: String(err.code) } : {}),
          },
        };
        send(`data: ${JSON.stringify(payload)}\n\n`);
        send("data: [DONE]\n\n");
      } finally {
        clearInterval(timer);
        closed = true;
        try { controller.close(); } catch {}
      }
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
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

  // 会话标题不是画图：直接本地回 JSON，不碰号池。见 isTitleTask 的注释。
  if (isTitleTask(parsed, turn)) {
    const title = deriveTitle(turn.prompt);
    console.error("[chat-image-bridge] title task answered locally, no generation: %s", title);
    return titleResponse(parsed, model, title);
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

  /**
   * 跑完 n 张图并拼出正文。失败抛一个带 `bridgeStatus` / `bridgePayload` 的错误，
   * 让调用方决定是回 JSON（非流式，能改状态码）还是回流（状态码已经发出去了）。
   */
  const generate = async () => {
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
          const saved = await saveImage(item.b64_json, publicBase());
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
      // 打一遍，一次失败就被拖成两倍时长，客户端连错误都看不到。这类失败重试也
      // 救不回来（号池里没号能出图），所以对外报成不可重试的 4xx。
      const status = failure.code === "request_timeout" ? 400 : (failure.status || 502);
      throw Object.assign(new Error(message), {
        code: failure.code || "",
        bridgeStatus: status,
        bridgePayload: {
          error: {
            message,
            type: "invalid_request_error",
            ...(failure.code ? { code: failure.code } : {}),
          },
        },
      });
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
    return mode === "markdown"
      ? links.map((u) => `![image](${u})`).join("\n")
      : mode === "url"
        ? links.join("\n")
        : links.map((u) => `![image](${u})\n${u}`).join("\n\n");
  };

  // 流式：立刻返回响应 + 定期 keepalive，见 streamingSse 的注释。
  if (parsed.stream) return streamingSse(generate, model);

  try {
    const content = await generate();
    return json(completionPayload(content, model), 200);
  } catch (err) {
    if (err?.bridgePayload) return json(err.bridgePayload, err.bridgeStatus || 502);
    throw err;
  }
}
