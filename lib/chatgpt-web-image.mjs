/**
 * ChatGPT Web `picture_v2` image generation & editing adapter for Magpie GPTFree.
 *
 * Exposes `gpt-image-2` under Magpie's `@ai-sdk/openai-compatible` plugin model schema
 * (required by host.js / draw.go / TestModels) while keeping Codex text models on
 * `@ai-sdk/openai` (/responses). Dispatches isolated Python worker processes using
 * pooled ChatGPT access tokens with 401 reauthentication and multi-account failover.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accessTokenState } from "./credentials.mjs";
import { accountInflight, noteAccountInflight } from "./account-inflight.mjs";
import { workerPython } from "./dsh-http-auth.mjs";

const PYDIR = join(dirname(fileURLToPath(import.meta.url)), "../python");
export const IMAGE_WORKER = join(PYDIR, "image_worker.py");
export const IMAGE_MODEL_ID = "gpt-image-2";

/**
 * Image models supported through the ChatGPT Web `picture_v2` pipeline.
 * The 2.6 family is the newer generation also used for animated GIF output,
 * mirroring https://github.com/yang0/chatgpt2api-dsh.
 */
export const IMAGE_MODEL_IDS = Object.freeze([
  "gpt-image-2",
  "gpt-image-2.6",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
]);

const IMAGE_MODEL_NAMES = {
  "gpt-image-2": "GPT Image 2",
  "gpt-image-2.6": "GPT Image 2.6",
  "gpt-image-2.6-flare": "GPT Image 2.6 Flare",
  "gpt-image-2.6-sunburst": "GPT Image 2.6 Sunburst",
};

const GIF_CAPABLE_MODELS = new Set([
  "gpt-image-2.6",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
]);

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_INPUT_FILES = 10;
const MAX_INPUT_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_FORMATS = new Set(["", "auto", "png", "webp", "jpeg", "jpg", "gif"]);

export class ImageHttpError extends Error {
  constructor(status, message, code = "") {
    super(message);
    this.name = "ImageHttpError";
    this.status = status;
    this.code = code;
  }
}

function abortError(message = "Image generation aborted") {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export function normalizeImageModelId(modelId) {
  const raw = String(modelId || "").trim();
  if (!raw) return IMAGE_MODEL_ID;
  const lower = raw.toLowerCase();
  const hit = IMAGE_MODEL_IDS.find((id) => id === lower);
  if (hit) return hit;
  // Accept plan-prefixed aliases such as `plus-gpt-image-2.6`.
  const suffix = IMAGE_MODEL_IDS.find((id) => lower.endsWith("-" + id));
  return suffix || "";
}

export function isImageModelId(modelId) {
  // An explicitly empty model is not an image model (it defaults to a text model
  // request in the caller); only real ids or plan-prefixed aliases match.
  if (!String(modelId || "").trim()) return false;
  return normalizeImageModelId(modelId) !== "";
}

export function supportsGifOutput(modelId) {
  return GIF_CAPABLE_MODELS.has(normalizeImageModelId(modelId));
}

export function buildImageModelCatalog(baseURL = "https://chatgpt.com/backend-api/codex") {
  const catalog = {};
  for (const id of IMAGE_MODEL_IDS) {
    const gif = GIF_CAPABLE_MODELS.has(id);
    catalog[id] = {
      id,
      name: IMAGE_MODEL_NAMES[id],
      api: {
        id,
        url: baseURL,
        npm: "@ai-sdk/openai-compatible",
      },
      provider: {
        npm: "@ai-sdk/openai-compatible",
      },
      attachment: true,
      tool_call: false,
      temperature: false,
      limit: { context: 32000, output: 4096 },
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: true,
        toolcall: false,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: false, image: true, audio: false, video: false, pdf: false },
        ...(gif ? { animated: true } : {}),
      },
    };
  }
  return catalog;
}

function headerValue(headers, targetName) {
  if (!headers) return "";
  const needle = targetName.toLowerCase();
  if (typeof headers.get === "function") {
    return String(headers.get(targetName) || headers.get(needle) || "").trim();
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && String(pair[0] || "").toLowerCase() === needle) {
        return String(pair[1] || "").trim();
      }
    }
    return "";
  }
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === needle) return String(v || "").trim();
    }
  }
  return "";
}

function parseN(raw) {
  if (raw === undefined || raw === null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    throw new ImageHttpError(400, "n must be an integer between 1 and 4", "invalid_request");
  }
  return n;
}

function normalizeOutputFormat(raw) {
  const fmt = String(raw || "").trim().toLowerCase();
  if (!ALLOWED_FORMATS.has(fmt)) {
    throw new ImageHttpError(400, "Unsupported image output_format", "invalid_request");
  }
  return fmt;
}

function parseFrameCount(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 2 || n > 120) {
    throw new ImageHttpError(400, "frame_count must be an integer between 2 and 120", "invalid_request");
  }
  return n;
}

function parseFrameDuration(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 20 || n > 5000) {
    throw new ImageHttpError(400, "frame_duration_ms must be between 20 and 5000", "invalid_request");
  }
  return Math.trunc(n);
}

async function extractFormBlobs(form, keys) {
  const items = [];
  for (const key of keys) {
    for (const entry of form.getAll(key)) {
      if (!entry) continue;
      if (typeof entry !== "string" && typeof entry.arrayBuffer === "function") {
        const size = Number(entry.size || 0);
        if (size <= 0) {
          throw new ImageHttpError(400, `Uploaded file in "${key}" is empty`, "invalid_image");
        }
        if (size > MAX_INPUT_FILE_BYTES) {
          throw new ImageHttpError(400, `Uploaded file in "${key}" exceeds 10MB limit`, "invalid_image");
        }
        const buf = Buffer.from(await entry.arrayBuffer());
        if (!buf.length) {
          throw new ImageHttpError(400, `Uploaded file in "${key}" is empty`, "invalid_image");
        }
        items.push({
          b64: buf.toString("base64"),
          mime_type: String(entry.type || "").trim().toLowerCase(),
          filename: String(entry.name || "image.png").trim() || "image.png",
        });
      }
    }
  }
  return items;
}

function decodeJsonImageItem(entry, index) {
  let raw = "";
  let filename = `image_${index}.png`;
  let mimeType = "";
  if (typeof entry === "string") {
    raw = entry.trim();
  } else if (entry && typeof entry === "object") {
    filename = String(entry.filename || entry.file_name || filename).trim() || filename;
    mimeType = String(entry.mime_type || entry.mimeType || "").trim().toLowerCase();
    const candidate = entry.b64_json || entry.base64 || entry.image_url || entry.url;
    if (candidate && typeof candidate === "object") {
      raw = String(candidate.url || candidate.image_url || "").trim();
      mimeType = mimeType || String(candidate.mime_type || candidate.mimeType || "").trim().toLowerCase();
    } else if (typeof candidate === "string") {
      raw = candidate.trim();
    }
  } else {
    throw new ImageHttpError(400, "image entry must be a base64 string or object", "invalid_image");
  }

  if (!raw) throw new ImageHttpError(400, "image entry must include image data", "invalid_image");
  if (/^https?:\/\//i.test(raw)) {
    throw new ImageHttpError(400, "Remote image URLs are not supported; supply base64 or multipart file", "invalid_image");
  }

  const dataUrl = /^data:([^;]+);base64,([\s\S]*)$/i.exec(raw);
  let b64 = raw;
  if (dataUrl) {
    mimeType = mimeType || dataUrl[1].trim().toLowerCase();
    b64 = dataUrl[2].trim();
  }
  if (!b64) throw new ImageHttpError(400, "image file is empty", "invalid_image");

  let decoded;
  try {
    decoded = Buffer.from(b64, "base64");
  } catch {
    throw new ImageHttpError(400, "Invalid base64 image payload", "invalid_image");
  }
  if (!decoded.length) throw new ImageHttpError(400, "image file is empty", "invalid_image");
  if (decoded.length > MAX_INPUT_FILE_BYTES) {
    throw new ImageHttpError(400, "image file exceeds 10MB limit", "invalid_image");
  }
  return { b64: decoded.toString("base64"), mime_type: mimeType, filename };
}

function normalizeJsonImageList(rawValue, fieldName) {
  if (rawValue === undefined || rawValue === null) return [];
  const list = Array.isArray(rawValue) ? rawValue : [rawValue];
  if (list.length > MAX_INPUT_FILES) {
    throw new ImageHttpError(400, `${fieldName} supports at most ${MAX_INPUT_FILES} files`, "invalid_request");
  }
  return list.map((item, idx) => decodeJsonImageItem(item, idx + 1));
}

function parseJsonBody(rawBody) {
  if (rawBody && typeof rawBody === "object" && !(rawBody instanceof Uint8Array) && !ArrayBuffer.isView(rawBody) && !(rawBody instanceof ArrayBuffer)) {
    return rawBody;
  }
  const text = rawBody instanceof Uint8Array ? Buffer.from(rawBody).toString("utf8") :
    rawBody instanceof ArrayBuffer ? Buffer.from(rawBody).toString("utf8") :
    String(rawBody || "");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImageHttpError(400, "Invalid JSON image request body", "invalid_request");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ImageHttpError(400, "Image request body must be a JSON object", "invalid_request");
  }
  return parsed;
}

export async function parseImageRequest(pathname, rawBody, headers) {
  const isEdit = pathname.endsWith("/images/edits");
  const contentType = headerValue(headers, "content-type");

  if (isEdit && (rawBody instanceof FormData || /^multipart\/form-data\b/i.test(contentType))) {
    let form;
    if (rawBody instanceof FormData) {
      form = rawBody;
    } else {
      try {
        form = await new Response(rawBody, { headers: { "content-type": contentType } }).formData();
      } catch {
        throw new ImageHttpError(400, "Cannot parse multipart/form-data image edit request", "invalid_request");
      }
    }
    const textField = (k) => {
      const v = form.get(k);
      return typeof v === "string" ? v.trim() : "";
    };
    const prompt = textField("prompt");
    if (!prompt) throw new ImageHttpError(400, "prompt is required", "invalid_request");
    const requestedModel = textField("model");
    const model = normalizeImageModelId(requestedModel);
    if (!model) {
      throw new ImageHttpError(400, `Unsupported image model: ${requestedModel}`, "model_not_found");
    }
    const outputFormat = normalizeOutputFormat(textField("output_format"));
    if (outputFormat === "gif" && !supportsGifOutput(model)) {
      throw new ImageHttpError(400, "GIF 动图需要 gpt-image-2.6 系列模型", "invalid_request");
    }
    const images = await extractFormBlobs(form, ["image", "image[]"]);
    const markupImages = await extractFormBlobs(form, ["markup", "markup[]"]);
    const masks = await extractFormBlobs(form, ["mask", "mask[]"]);
    const combinedImages = [...images, ...markupImages];
    if (!combinedImages.length) {
      throw new ImageHttpError(400, "image file is required", "invalid_image");
    }
    if (combinedImages.length > MAX_INPUT_FILES) {
      throw new ImageHttpError(400, `images supports at most ${MAX_INPUT_FILES} files`, "invalid_request");
    }
    if (masks.length > MAX_INPUT_FILES) {
      throw new ImageHttpError(400, `masks supports at most ${MAX_INPUT_FILES} files`, "invalid_request");
    }
    return {
      model,
      prompt,
      n: parseN(textField("n")),
      size: textField("size"),
      quality: textField("quality") || "auto",
      background: textField("background") || "auto",
      output_format: outputFormat,
      frame_count: parseFrameCount(textField("frame_count")),
      frame_duration_ms: parseFrameDuration(textField("frame_duration_ms")),
      images: combinedImages,
      masks,
    };
  }

  const b = parseJsonBody(rawBody);
  const prompt = String(b.prompt || "").trim();
  if (!prompt) throw new ImageHttpError(400, "prompt is required", "invalid_request");
  const requestedModel = String(b.model || IMAGE_MODEL_ID).trim();
  const model = normalizeImageModelId(requestedModel);
  if (!model) {
    throw new ImageHttpError(400, `Unsupported image model: ${requestedModel}`, "model_not_found");
  }
  const outputFormat = normalizeOutputFormat(b.output_format);
  if (outputFormat === "gif" && !supportsGifOutput(model)) {
    throw new ImageHttpError(400, "GIF 动图需要 gpt-image-2.6 系列模型", "invalid_request");
  }

  let images = [];
  let masks = [];
  if (isEdit) {
    images = normalizeJsonImageList(b.images !== undefined ? b.images : b.image, "images");
    const markupImages = normalizeJsonImageList(b.markup, "markup");
    images = [...images, ...markupImages];
    if (!images.length) {
      throw new ImageHttpError(400, "image is required for edits", "invalid_image");
    }
    if (images.length > MAX_INPUT_FILES) {
      throw new ImageHttpError(400, `images supports at most ${MAX_INPUT_FILES} files`, "invalid_request");
    }
    masks = normalizeJsonImageList(b.masks !== undefined ? b.masks : b.mask, "mask");
  }

  return {
    model,
    prompt,
    n: parseN(b.n),
    size: String(b.size || "").trim(),
    quality: String(b.quality || "auto").trim() || "auto",
    background: String(b.background || "auto").trim() || "auto",
    output_format: outputFormat,
    frame_count: parseFrameCount(b.frame_count),
    frame_duration_ms: parseFrameDuration(b.frame_duration_ms),
    images,
    masks,
  };
}

/**
 * Python worker 往 stderr 写的进度标记。目前只有一种：`first_byte` —— 上游第一
 * 个 SSE 数据包到了。这是「这个号还活着」的唯一可靠信号：卡死的号一个字节都不
 * 会来，而慢号只是来得晚。有了它，node 侧不用等满整个单次上限才敢换号。
 */
const WORKER_PROGRESS_PREFIX = "##PROGRESS ";

export async function runWebImageWorker(payload, {
  python = workerPython,
  signal,
  timeout = 240_000,
  workerPath = IMAGE_WORKER,
  onProgress = null,
} = {}) {
  if (signal?.aborted) throw abortError();
  const command = await python();
  const serialized = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const child = spawn(command, [workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });

    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderr = "";
    let ended = false;
    let aborted = false;

    const cleanup = () => {
      clearTimeout(timer);
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const finish = (err, output) => {
      if (ended) return;
      ended = true;
      cleanup();
      if (err) reject(err);
      else resolve(output);
    };

    const onAbort = () => {
      aborted = true;
      try { child.kill(); } catch {}
      finish(abortError());
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(null, {
        ok: false,
        http_status: 504,
        error_code: "worker_timeout",
        error: "Image generation worker timed out",
      });
    }, timeout);
    timer.unref?.();

    child.once("error", () => {
      finish(null, {
        ok: false,
        http_status: 502,
        error_code: "worker_start_failed",
        error: "Python image worker could not start",
      });
    });

    child.stdout.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buf.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        try { child.kill(); } catch {}
        finish(null, {
          ok: false,
          http_status: 502,
          error_code: "output_too_large",
          error: "Image worker output exceeded maximum size",
        });
        return;
      }
      stdoutChunks.push(buf);
    });

    // stderr 按行处理：`##PROGRESS` 行是进度信号，其余才是真正的错误输出。
    // 进度行绝不能混进 stderr 累积里，否则它会出现在用户看到的错误文案中。
    let stderrBuf = "";
    const drainStderr = (chunk, flush = false) => {
      stderrBuf += chunk;
      let nl;
      while ((nl = stderrBuf.indexOf("\n")) >= 0) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        handleStderrLine(line);
      }
      if (flush && stderrBuf) {
        handleStderrLine(stderrBuf);
        stderrBuf = "";
      }
    };
    const handleStderrLine = (line) => {
      if (line.startsWith(WORKER_PROGRESS_PREFIX)) {
        const kind = line.slice(WORKER_PROGRESS_PREFIX.length).trim();
        if (kind) {
          try { onProgress?.(kind); } catch {}
        }
        return;
      }
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += (line + "\n").slice(0, MAX_STDERR_BYTES - stderr.length);
      }
    };

    child.stderr.on("data", (chunk) => {
      drainStderr(String(chunk));
    });

    child.once("close", (code) => {
      if (ended) return;
      drainStderr("", true);
      if (aborted) {
        finish(abortError());
        return;
      }
      const text = Buffer.concat(stdoutChunks).toString("utf8").trim();
      if (text) {
        try {
          finish(null, JSON.parse(text));
          return;
        } catch {}
      }
      finish(null, {
        ok: false,
        http_status: 502,
        error_code: code === 0 ? "invalid_worker_output" : "worker_crashed",
        error: "Image generation worker did not return valid JSON",
      });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(serialized);
  });
}

function estimateUsage(request, dataItems) {
  const promptTokens = Math.max(1, Math.ceil(String(request.prompt || "").length / 4));
  const imageInputTokens = (request.images?.length || 0) * 512;
  const outputTokens = Math.max(1, dataItems.length) * 1024;
  return {
    input_tokens: promptTokens + imageInputTokens,
    output_tokens: outputTokens,
  };
}

export async function checkWebImageQuota({
  accessToken,
  proxy = "",
  timezoneOffsetMin = -480,
  signal,
  runWorker = runWebImageWorker,
} = {}) {
  if (!accessToken || typeof accessToken !== "string") {
    return {
      ok: false,
      http_status: 401,
      error_code: "unauthorized",
      error: "Missing access_token",
    };
  }
  return runWorker(
    {
      action: "check_image_quota",
      access_token: accessToken,
      proxy: proxy || "",
      timezone_offset_min: timezoneOffsetMin,
    },
    { signal, timeout: 45_000 },
  );
}

/**
 * 一次生图请求的时间预算（0.9.0 重做）。
 *
 * 老配置是「单次 35 秒、整单 55 秒、串行换号」，实测在数学上不可能成功：
 * 第一个号卡满 35 秒后，第二个号只剩 20 秒，而正常出图要 27~32 秒 —— 于是
 * 121 个号的池子每个请求只试到 1 个，线上 `attempted=1 / skipped=120` 就是
 * 这么来的。换号形同虚设，最后全靠 Magpie 在外面盲重试（最高 8~19 次）。
 *
 * 现在改成 **lane（通道）**：
 *   - 一条 lane 按额度加权顺序依次试号，一个号失败就换下一个，直到总预算用完；
 *   - 第一路跑满 HEDGE_DELAY_MS 还没结果时，**再起第二路**（对冲）从队首附近
 *     拿另一个号并行试 —— 卡死的号不再独占整个预算；
 *   - 谁先出图谁赢，其余立刻掐掉。
 *
 * 为什么头程默认 25 秒而不是 40 秒：客户端（WorkBuddy）59 秒就 cancel，40 + 30
 * 一定超；25 秒起步的第二路还能拿到 30 秒。**注意**：真实调用方（codex-pool）
 * 会用 `hedgeDelayForHead()` 覆盖这个默认值 —— 头号没验证过时提早到 12 秒，
 * 否则第二路根本来不及出图（详见该函数的注释）。
 *
 * 全部可用环境变量覆盖（都是毫秒）：
 *   MAGPIE_GPTFREE_MAX_TOTAL_MS     整单封顶，默认 600000（10 分钟）
 *   MAGPIE_GPTFREE_ATTEMPT_TIMEOUT_MS 单次 worker 上限，默认 60000
 *   MAGPIE_GPTFREE_HEDGE_DELAY_MS   第二路起步延迟，默认 25000
 *   MAGPIE_GPTFREE_MAX_LANES        最多几路，默认 2
 *
 * **为什么整单从 55 秒放到 150 秒**：55 秒的依据原来是「客户端 59 秒就 cancel」。
 * 实测推翻了这个前提 —— Magpie 在等待上游期间会自己往 SSE 里写 `: keepalive`
 * （约 2 秒一次），所以流式请求的客户端根本不会超时，会一直等。而 55 秒预算
 * 配 40 秒单次上限，只够试 2 个号（`55÷40≈1.4` 轮 × 2 条 lane），121 个号的池子
 * 等于在拿 2 个号赌。放到 150 秒 + 单次 55 秒能试 5 个号。
 *
 * 非流式客户端（没有 SSE 通道、Magpie 发不了 keepalive）仍会在 59 秒左右断开，
 * 但那时 Magpie 会 abort 我们的请求（日志里的 `client_aborted`），我们立刻收手，
 * 不会白占并发 —— 所以长预算对它们没有副作用，不需要按 stream 分档。
 */
/**
 * 整单封顶 **10 分钟**。
 *
 * 这不是「超时就失败」的主路径 —— 主路径是「所有账号都试完」（`takeNext` 返回 -1
 * 时 lane 自己收工）。10 分钟只是兜底：两百多个号 × 60 秒理论上能试三小时，
 * 但客户端的耐心和上游的资源都不是无限的，所以留一个天花板。
 *
 * 以前这里是 150 秒，配上 75 秒的单次上限，一个请求只能试 2 个号 —— 号池里明明
 * 还有两百个号没用过，却已经报「所有账号都失败」了。
 */
const MAX_TOTAL_MS = envNumber("MAGPIE_GPTFREE_MAX_TOTAL_MS", 600_000);
/**
 * 单次（一个账号）的上限：**60 秒没出图就换号**。
 *
 * 依据：线上成功的出图集中在 21–38 秒，超过 60 秒的样本一次都没成功过。
 * 号池里有两百多个号，等一个慢号等满 60 秒的机会成本，比换一个号试要大得多。
 * 首字节 2.7–5 秒就到，所以「60 秒」几乎总是「慢」而不是「卡」；真卡死由
 * 10 秒的 hangJudge 更早掐掉。
 */
const ATTEMPT_TIMEOUT_MS = envNumber("MAGPIE_GPTFREE_ATTEMPT_TIMEOUT_MS", 60_000);
const HEDGE_DELAY_MS = envNumber("MAGPIE_GPTFREE_HEDGE_DELAY_MS", 25_000);
/**
 * 「这个号已经死了」的判定线：启动后多久还没收到上游第一个数据包。
 *
 * 实测（121 个号的池子，9 次成功请求）首字节时间是 2.9~4.5 秒，而卡死的号
 * 一个字节都不会来。以前只能等满 55 秒的单次上限才敢换号，等于用 55 秒换一个
 * 「这号不行」的结论 —— 150 秒预算只够试 3 个号。
 *
 * 10 秒是实测最大值（4.5 秒）的两倍多，留足抖动余量；卡死号 10 秒就出局，
 * 同样的预算能试十几个号。
 */
const HANG_JUDGE_MS = envNumber("MAGPIE_GPTFREE_HANG_JUDGE_MS", 10_000);
const MAX_LANES = Math.max(1, Math.trunc(envNumber("MAGPIE_GPTFREE_MAX_LANES", 2)));

function envNumber(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * 「这个号现在没额度了」的错误码。它们不是号的硬伤，是限流：该停这个号、
 * 换下一个，而不是按普通失败给它排冷却阶梯。
 *
 * 为什么要按码判而不只看 429：python worker 把 Free 套餐上限识别成
 * `upstream_quota_exceeded` 并回 502（它确实没拿到图），这条路上没有 429。
 * 只认 429 的后果是额度耗尽的号永远不清零额度、冷却完又被选中，
 * 每轮都要白撞一次。worker 自己报的 `rate_limited` 同理。
 */
const RATE_LIMIT_ERROR_CODES = new Set([
  "rate_limited",
  "upstream_rate_limited",
  "upstream_quota_exceeded",
  "quota_exhausted",
]);

/**
 * 额度用完时上游给的是 400 + 一段中文拒绝文案，这种要换号，不能整单放弃。
 *
 * 正则必须收得够紧：以前是 `上限|额度|quota|usage limit|limit reached`，
 * 于是 "image size limit" / "prompt length limit" 这类**请求本身**的 400
 * 也被当成额度用尽，把一个好号白白停一小时。现在只认真正的额度上限文案。
 */
const QUOTA_EXHAUSTED_RE =
  /图像生成请求上限|图像生成上限|图片生成请求上限|已达到\s*free\s*套餐|额度(?:已)?(?:用完|耗尽)|image generation limit|reached your image/i;

function looksLikeQuotaExhausted(message) {
  return QUOTA_EXHAUSTED_RE.test(String(message || ""));
}

/**
 * 文案里常带「上限将在 21小时 后重置」，据此把号标记成限流到那个时间点。
 *
 * 单位要认全：上游有时候说「3天」、有时候说「45分钟」。只认小时的话，
 * 这些文案会解析成 null，号就没有明确的恢复时间，只能等巡检重新问额度。
 */
const RESET_AFTER_RE = /(\d+)\s*(天|小时|分钟|秒|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)/i;
const RESET_UNIT_SECONDS = {
  天: 86400, 小时: 3600, 分钟: 60, 秒: 1,
  day: 86400, days: 86400,
  hour: 3600, hours: 3600, hr: 3600, hrs: 3600,
  minute: 60, minutes: 60, min: 60, mins: 60,
  second: 1, seconds: 1, sec: 1, secs: 1,
};

function quotaRetrySeconds(message) {
  const hit = RESET_AFTER_RE.exec(String(message || ""));
  if (!hit) return null;
  const unit = RESET_UNIT_SECONDS[hit[2].toLowerCase()] ?? RESET_UNIT_SECONDS[hit[2]];
  const amount = Number(hit[1]);
  if (!Number.isFinite(amount) || amount <= 0 || !unit) return null;
  const seconds = amount * unit;
  return seconds <= 24 * 30 * 3600 ? seconds : null;
}

function linkAbort(...signals) {
  const ctrl = new AbortController();
  const forward = () => ctrl.abort();
  for (const sig of signals) {
    if (!sig) continue;
    if (sig.aborted) {
      ctrl.abort();
      break;
    }
    sig.addEventListener("abort", forward, { once: true });
  }
  return ctrl.signal;
}

export async function executeWebImageGeneration({
  accounts,
  request,
  signal,
  reauthenticate,
  runWorker = runWebImageWorker,
  proxy = "",
  workerOptions = {},
  maxTotalMs = MAX_TOTAL_MS,
  attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
  hedgeDelayMs = HEDGE_DELAY_MS,
  maxLanes = MAX_LANES,
  hangJudgeMs = HANG_JUDGE_MS,
  // 「从没被派过活」的号（既没成功也没失败过）。第二路（对冲路）优先从这里取号：
  // 它本来就是赌一把的位置，赌赢了白赚一个可用号，赌输了也不影响第一路。
  // 不传就是纯对冲（老行为）。
  exploreAccounts = [],
  // 单号并发闸：同一个号同时允许几个 worker。0 = 不限制。
  // 默认 0 是为了让直接调用这个函数的测试保持老行为；生产走 codex-pool，
  // 那里从 policy 读，默认 1。
  perAccountInflight = 0,
  // 头号已经在推流时，是否仍允许为「探未验证号」起第二路。
  // 默认 false —— 见 hedgeTimer 里的注释。
  allowExploreWhileProgressing = false,
  // 0.8.x 的「慢失败两次就停」已被 lane 机制取代（见 runGroup）。留着这个参数
  // 只是为了不破坏还在传它的老调用方，值不再生效。
  maxSlowFailovers: _legacyMaxSlowFailovers = undefined,
  onAccountResult = null,
} = {}) {
  if (!Array.isArray(accounts) || !accounts.length) {
    throw new ImageHttpError(503, "GPTFree pool is empty; import accounts first", "pool_empty");
  }
  if (signal?.aborted) throw abortError();

  async function reportResult(payload) {
    if (typeof onAccountResult !== "function") return;
    try {
      await onAccountResult(payload);
    } catch {}
  }

  const startedAt = Date.now();
  const inflightLimit = Math.max(0, Math.round(Number(perAccountInflight) || 0));
  const poolAccounts = accounts.map((a) => ({ ...a }));
  const inflightReauth = new Map();

  // 探索队列：把「未验证号」映射成 poolAccounts 的下标。游标与「已探索」集合放在
  // 这一层（而不是 runGroup 里），因为 n>1 时会有多个 lane 组同时跑，放在组内会
  // 各自从头开始、把同一个新号试 n 遍。
  const exploreIdx = [];
  if (Array.isArray(exploreAccounts) && exploreAccounts.length) {
    const byEmail = new Map();
    poolAccounts.forEach((a, i) => {
      if (typeof a?.email === "string") byEmail.set(a.email, i);
    });
    const seen = new Set();
    for (const item of exploreAccounts) {
      const idx = byEmail.get(item?.email);
      if (idx === undefined || seen.has(idx)) continue;
      seen.add(idx);
      exploreIdx.push(idx);
    }
  }
  let exploreCursor = 0;
  const exploreTaken = new Set();
  function takeExploreIndex() {
    while (exploreCursor < exploreIdx.length) {
      const idx = exploreIdx[exploreCursor];
      exploreCursor += 1;
      if (exploreTaken.has(idx)) continue;
      exploreTaken.add(idx);
      return idx;
    }
    return -1;
  }

  // 硬预算：到点就 abort 掉在飞的 worker、也不再等登录，保证请求一定在客户端的
  // 耐心（59 秒）之内返回，而不是卡在某个账号的重新登录上。
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), Math.max(2_000, maxTotalMs));
  const timeoutError = () => new ImageHttpError(
    504,
    // 这里**不能**写「额度」二字：Magpie 用文案做失败归类
    // （正则含 `quota|balance|credit|余额|额度|套餐…`），一出现「额度」它就把
    // 一次超时标成「额度用尽」挂在界面上，把排查方向带偏过整整一轮。
    `生图超时：${Math.round(maxTotalMs / 1000)} 秒内没有账号返回结果（上游响应慢或账号无响应），已放弃等待`,
    "request_timeout",
  );
  const deadlineHit = () => deadline.signal.aborted && !signal?.aborted;
  const failFast = () => (deadlineHit() ? timeoutError() : abortError());
  const deadlinePromise = new Promise((_, reject) => {
    const onAbort = () => reject(deadlineHit() ? timeoutError() : abortError());
    if (deadline.signal.aborted) onAbort();
    else deadline.signal.addEventListener("abort", onAbort, { once: true });
  });
  deadlinePromise.catch(() => {});

  async function reauthSlot(acctIdx, attemptedToken) {
    const current = poolAccounts[acctIdx];
    if (current?.accessToken && attemptedToken && current.accessToken !== attemptedToken &&
        accessTokenState(current.accessToken).state === "unexpired_unverified") {
      return current;
    }
    const key = current?.email || String(acctIdx);
    if (!inflightReauth.has(key)) {
      const p = Promise.resolve()
        .then(() => reauthenticate(current))
        .then((updated) => {
          if (updated?.accessToken) {
            poolAccounts[acctIdx] = updated;
          }
          return updated;
        })
        .finally(() => {
          inflightReauth.delete(key);
        });
      inflightReauth.set(key, p);
    }
    return inflightReauth.get(key);
  }

  /** 整单共享的「最近一次失败」，用来在全部 lane 都空手而归时给出原因。 */
  let lastError = null;

  /**
   * 试一个号：最多两次 worker 调用（401 时重登一次）。
   *   返回 res → 这个号出图了；
   *   返回 null → 这个号不行，lane 接着试下一个；
   *   抛错 → 整单没救了（请求本身不合法、预算到点、客户端掐断）。
   *
   * `exploring`：这个号是第二路拿来「探能力」的未验证号。它只说明「当前预算下
   * 没试出来」，不等于这个号不能用 —— 所以被压缩后的单次超时不能记到它头上，
   * 否则第一次探索就把新号误判成坏号，探索队列永远长不大。
   */
  async function tryAccount(acctIdx, laneSignal, { exploring = false, onFirstByte = null } = {}) {
    let account = poolAccounts[acctIdx];
    if (accessTokenState(account.accessToken).state !== "unexpired_unverified") {
      try {
        // 重新登录是纯 HTTP（可能很慢，还可能卡在 MFA），同样受预算约束。
        account = await Promise.race([reauthSlot(acctIdx, account.accessToken), deadlinePromise]);
      } catch (err) {
        if (err?.name === "AbortError" || laneSignal?.aborted || deadlineHit()) throw failFast();
        lastError = new ImageHttpError(401, String(err?.message || "Account reauthentication failed").slice(0, 180), "unauthorized");
        await reportResult({
          account,
          success: false,
          httpStatus: 401,
          errorCode: "unauthorized",
          errorMessage: String(err?.message || "Account reauthentication failed"),
          rateLimited: false,
          retryAfter: null,
        });
        return null;
      }
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      if (laneSignal?.aborted) throw failFast();
      const tokenUsed = account.accessToken;
      // 单次尝试的上限按剩余预算收敛：换号越往后，留给单次的越少，
      // 保证「最后一个号」不会把请求拖过客户端的耐心。
      const attemptTimeout = Math.min(
        attemptTimeoutMs,
        Math.max(8_000, maxTotalMs - (Date.now() - startedAt)),
      );
      // 预算把单次上限压短了 —— 这种超时只说明「没时间试完」，不说明号不行。
      const squeezed = attemptTimeout < attemptTimeoutMs;
      // 上游第一个数据包的到达时间：0 表示「一个字节都没来」，这个号是卡死的。
      let firstByteMs = 0;
      // 单独的布尔标记：首字节可能在 0ms 就到了（本地 worker 极快时），
      // 那时 firstByteMs === 0，和「一个字节都没来」分不开 —— 而「有没有来」
      // 决定的是「这个号卡死没卡死」，不能靠一个可能是 0 的时长来判断。
      let firstByteSeen = false;
      const attemptStartedAt = Date.now();
      // 卡死判定：hangJudgeMs 内一个数据包都没来就主动掐掉，不用等满单次上限。
      // 这个 abort 是「我们放弃这个号」，和客户端/预算的 abort 要分开处理。
      const hangAbort = new AbortController();
      const attemptSignal = linkAbort(laneSignal, hangAbort.signal);
      const hangTimer = setTimeout(() => {
        if (!firstByteSeen) hangAbort.abort();
      }, Math.max(1_000, Math.min(hangJudgeMs, attemptTimeout)));
      hangTimer.unref?.();
      let res;
      try {
        // 除了给 worker 传 signal/timeout，外面再和硬预算赛一次：即使 worker
        // 不理会 abort，请求也不会越过预算。
        res = await Promise.race([runWorker(
          {
            action: "generate_image",
            access_token: tokenUsed,
            prompt: request.prompt,
            model: request.model,
            model_id: request.model,
            size: request.size || "",
            quality: request.quality || "auto",
            output_format: request.output_format || "",
            background: request.background || "auto",
            frame_count: request.frame_count,
            frame_duration_ms: request.frame_duration_ms,
            images: request.images || [],
            masks: request.masks || [],
            proxy: proxy || "",
            ...workerOptions,
          },
          {
            signal: attemptSignal,
            timeout: attemptTimeout,
            onProgress: (kind) => {
              if (kind === "first_byte" && !firstByteSeen) {
                firstByteSeen = true;
                firstByteMs = Date.now() - attemptStartedAt;
                clearTimeout(hangTimer);
                // 告诉所在分组「这个号已经在推流了」——对冲靠它决定要不要复制请求。
                if (typeof onFirstByte === "function") {
                  try { onFirstByte(); } catch {}
                }
              }
            },
          },
        ), deadlinePromise]);
      } catch (err) {
        clearTimeout(hangTimer);
        if (err?.name === "AbortError") {
          // 上游 hangJudgeMs 内没动静：判定这个号卡死，换下一个，别占着预算。
          if (hangAbort.signal.aborted && !firstByteSeen) {
            const ms = Date.now() - attemptStartedAt;
            const message = `上游 ${Math.round(ms / 1000)} 秒内没有任何响应（账号被限流或会话失效）`;
            // `worker_hang`：一个字节都没来。这才是「卡死」，才该记进 hangStreak。
            lastError = new ImageHttpError(504, message, "worker_hang");
            await reportResult({
              account,
              success: false,
              httpStatus: 504,
              errorCode: "worker_hang",
              errorMessage: message,
              rateLimited: false,
              retryAfter: null,
              ms: Date.now() - attemptStartedAt,
            });
            return null;
          }
          throw failFast();
        }
        lastError = new ImageHttpError(502, String(err?.message || "Image worker invocation failed").slice(0, 180), "worker_error");
        await reportResult({
          account,
          success: false,
          httpStatus: 502,
          errorCode: "worker_error",
          errorMessage: String(err?.message || "Image worker invocation failed"),
          rateLimited: false,
          retryAfter: null,
          ms: Date.now() - attemptStartedAt,
        });
        return null;
      }

      // 观测：ttfb=0 表示上游一个字节都没来（卡死），>0 才是「慢」。这两个分布
      // 决定「多久没动静就换号」的阈值，先采集一轮再定。
      clearTimeout(hangTimer);
      console.log("[gptfree] attempt ttfb=%dms total=%dms code=%s",
        firstByteMs, Date.now() - attemptStartedAt,
        String(res?.error_code || (res?.ok === true ? "ok" : "unknown")));

      if (res?.ok === true && Array.isArray(res.data) && res.data.length) {
        await reportResult({
          account,
          success: true,
          count: 1,
          httpStatus: 200,
          ms: Date.now() - attemptStartedAt,
          ttfbMs: firstByteMs,
        });
        return res;
      }

      const status = Number(res?.http_status || 502);
      const message = String(res?.error || "Upstream image generation failed").slice(0, 240);
      // 同样是「超时」，含义差很远：
      //   worker_hang = 一个字节都没来 → 这个号真的卡住了，记进 hangStreak；
      //   worker_slow = 首字节来了、只是没在预算内出图 → 模型慢，不是号的错。
      // 混成一个码的后果：慢模型会把池子里的好号一个个隔离掉。
      const rawCode = String(res?.error_code || "upstream_error");
      const code = rawCode === "worker_timeout" && firstByteSeen ? "worker_slow" : rawCode;

      if (status === 400) {
        // 400 有两种：请求本身不合法（提示词/图片格式），和「这个号额度用完了」。
        // 后者必须换号继续，否则池子里只要有一个耗尽的号，整单就永远失败。
        const quotaExhausted = looksLikeQuotaExhausted(message);
        const retryAfter = quotaExhausted ? quotaRetrySeconds(message) : null;
        await reportResult({
          account,
          success: false,
          httpStatus: 400,
          errorCode: quotaExhausted ? "quota_exhausted" : (code || "invalid_request"),
          errorMessage: message,
          // 上游真实状态码（可能是 200：流正常、只是回了文字）。
          upstreamStatus: res?.upstream_status ?? null,
          rateLimited: quotaExhausted,
          retryAfter,
          ms: Date.now() - attemptStartedAt,
          ttfbMs: firstByteMs,
        });
        if (quotaExhausted) {
          lastError = new ImageHttpError(400, message, "quota_exhausted");
          return null;
        }
        throw new ImageHttpError(400, message, code || "invalid_request");
      }

      if (status === 401 && attempt === 0) {
        try {
          account = await Promise.race([reauthSlot(acctIdx, tokenUsed), deadlinePromise]);
          continue;
        } catch (err) {
          if (err?.name === "AbortError" || laneSignal?.aborted || deadlineHit()) throw failFast();
          lastError = new ImageHttpError(401, String(err?.message || message).slice(0, 180), "unauthorized");
          await reportResult({
            account,
            success: false,
            httpStatus: 401,
            errorCode: "unauthorized",
            errorMessage: String(err?.message || message),
            rateLimited: false,
            retryAfter: null,
            ms: Date.now() - attemptStartedAt,
            ttfbMs: firstByteMs,
          });
          return null;
        }
      }

      lastError = new ImageHttpError(status, message, code);
      // 探索路上的「预算压缩超时」不算这个号的错（见 tryAccount 的 exploring）。
      const squeezeTimeout = exploring && squeezed && code === "worker_timeout";
      // 限流既可能以 429 出现，也可能以「worker 自己认出来的额度码」出现（502 那条路）。
      // retryAfter 上游不给就从文案里抠 —— 拿不到时 pool-stats 会兜底 1 小时。
      const rateLimited = status === 429 || RATE_LIMIT_ERROR_CODES.has(code);
      if (!squeezeTimeout) {
        await reportResult({
          account,
          success: false,
          httpStatus: status,
          errorCode: code,
          errorMessage: message,
          upstreamStatus: res?.upstream_status ?? null,
          rateLimited,
          retryAfter: rateLimited ? (res?.retry_after ?? quotaRetrySeconds(message)) : null,
          ms: Date.now() - attemptStartedAt,
          ttfbMs: firstByteMs,
        });
      }
      if (![401, 403, 429, 500, 502, 503, 504].includes(status)) {
        throw lastError;
      }
      return null;
    }
    return null;
  }

  /**
   * 一个 lane：按顺序领号、试号，直到出图 / 预算用完 / 号试完。
   * lane 之间共享同一个游标和「已试过」集合，所以两路不会撞同一个号。
   */
  async function runGroup(startOffset, parentSignal) {
    const hub = new AbortController();
    const groupSignal = linkAbort(hub.signal, parentSignal, deadline.signal);

    let cursor = startOffset;
    const tried = new Set();
    // 本组头一条 lane 是否已经收到上游首字节。对冲靠它决定要不要复制请求 ——
    // 见下面 hedgeTimer 的注释。
    let headFirstByteAt = 0;
    let winner = null;
    let resolveWin = null;
    const winPromise = new Promise((resolve) => { resolveWin = resolve; });
    const laneErrors = [];
    let fatalError = null;
    let lanesAlive = 0;
    let closed = false;
    let resolveAllDone = null;
    const allDonePromise = new Promise((resolve) => { resolveAllDone = resolve; });

    /**
     * 领下一个号。两轮：
     *
     * 第一轮跳过「在飞已满」的号。`tried` 只保证**同一请求内**两条 lane 不撞号，
     * 但四个并发请求各自的第一条 lane 完全可能挑中同一个号 —— 那个号就被四个
     * worker 同时打，上游看到的是突发流量，直接 429 或卡住。排序里降权挡不住：
     * 四条 lane 各自排序，第一名照样是同一个。
     *
     * 第二轮（全都在飞）挑最闲的那个硬上。池子小的时候剔除等于不出图，
     * 宁可让一个号稍微超载，也不能直接失败。
     */
    function takeNext() {
      // 不限制时走原来的直路，连 Map 都不查。
      if (inflightLimit <= 0) {
        for (let i = 0; i < poolAccounts.length; i++) {
          const idx = cursor % poolAccounts.length;
          cursor += 1;
          if (tried.has(idx)) continue;
          tried.add(idx);
          return idx;
        }
        return -1;
      }
      let fallback = -1;
      let fallbackLoad = Infinity;
      for (let i = 0; i < poolAccounts.length; i++) {
        const idx = cursor % poolAccounts.length;
        cursor += 1;
        if (tried.has(idx)) continue;
        const load = accountInflight(poolAccounts[idx]?.email);
        if (load < inflightLimit) {
          tried.add(idx);
          return idx;
        }
        if (load < fallbackLoad) {
          fallbackLoad = load;
          fallback = idx;
        }
      }
      if (fallback >= 0) {
        tried.add(fallback);
        return fallback;
      }
      return -1;
    }

    /**
     * 第二路（对冲路）优先取「从没被派过活」的号，取完了再退回正常顺序。
     *
     * 为什么放在第二路：额度加权轮转让额度 25 的号权重是额度 5 的 5 倍，实测
     * 121 个号里有 55 个 `lastUsedAt` 全为空 —— 它们额度低（2~5），永远排在队尾，
     * 一次都没上过场；而被反复使用的那批高额度号已经被上游限流。第二路本来就是
     * 「赌一把」的位置，用它去探新号：赢了白赚一个可用号，输了不占第一路的预算。
     *
     * 探索队列的游标和「已取过」集合在 executeWebImageGeneration 那一层，n>1 时
     * 多个 lane 组不会把同一个新号试 n 遍。
     */
    function takeExplore() {
      const idx = takeExploreIndex();
      if (idx < 0) return { idx: -1, exploring: false };
      // 要探的号正好在飞已满 → 让回正常顺序（那边会挑别的号），
      // 别把一次探索塞给一个已经在忙的号，测出来的结果也不可信。
      // 注意 `inflightLimit > 0` 这个前提：0 表示不限制，不能拿 0 去比。
      if (inflightLimit > 0 && accountInflight(poolAccounts[idx]?.email) >= inflightLimit) {
        return { idx: -1, exploring: false };
      }
      // 本组已经试过这个号（第一路先撞上了）→ 退回正常顺序。
      if (tried.has(idx)) return { idx: takeNext(), exploring: false };
      tried.add(idx);
      return { idx, exploring: true };
    }

    async function lane(laneSignal, preferExplore = false) {
      while (!laneSignal.aborted) {
        if (Date.now() - startedAt >= maxTotalMs) return null;
        let pick = preferExplore ? takeExplore() : { idx: -1, exploring: false };
        if (pick.idx < 0) pick = { idx: takeNext(), exploring: false };
        if (pick.idx < 0) return null;
        // 计数必须成对：worker 抛错、被 abort、被预算掐断都要减回来，
        // 否则一次异常就把这个号永久钉死在「满」上，再也选不到。
        const busyEmail = poolAccounts[pick.idx]?.email;
        noteAccountInflight(busyEmail, 1);
        const attemptStartedAt = Date.now();
        let res;
        try {
          res = await tryAccount(pick.idx, laneSignal, {
            exploring: pick.exploring,
            onFirstByte: () => { if (!headFirstByteAt) headFirstByteAt = Date.now(); },
          });
        } catch (err) {
          if (err?.name === "AbortError") {
            // 被放弃的尝试也要留痕：上游那边可能已经在生成了，这笔额度是白烧的。
            // 以前这里直接 throw，日志里完全看不到 —— 等于蒙着眼睛调超时。
            // 记 accountFault=false（见 codex-pool 的 REQUEST_FAULT_CODES），
            // 因为「我们不等了」不是这个号的错。
            await reportResult({
              account: poolAccounts[pick.idx],
              success: false,
              httpStatus: null,
              errorCode: "attempt_aborted",
              errorMessage: "尝试被放弃（另一路已经出图，或整单到了预算上限）",
              rateLimited: false,
              retryAfter: null,
              ms: Date.now() - attemptStartedAt,
            }).catch(() => {});
          }
          throw err;
        } finally {
          noteAccountInflight(busyEmail, -1);
        }
        if (res) return res;
      }
      return null;
    }

    function spawnLane({ preferExplore = false } = {}) {
      if (closed || lanesAlive >= maxLanes) return;
      lanesAlive += 1;
      const laneAbort = new AbortController();
      const laneSignal = linkAbort(laneAbort.signal, groupSignal);
      lane(laneSignal, preferExplore)
        .then((res) => {
          if (res && !winner) {
            winner = res;
            resolveWin(res);
          }
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          laneErrors.push(err);
          // 请求本身的错（提示词被拒、图片格式不对）换号也没用，直接收摊，
          // 别让对冲的第二路白等 25 秒。
          if (err instanceof ImageHttpError && err.status === 400) {
            fatalError = err;
            hub.abort();
          }
        })
        .finally(() => {
          laneAbort.abort();
          lanesAlive -= 1;
          if (lanesAlive === 0 && !closed) {
            closed = true;
            resolveAllDone();
          }
        });
    }

    // 对冲起步点：不早于 hedgeDelayMs，也不晚于预算末尾（晚了就没意义了）。
    // 预算本来就短（测试或极端配置）时不玩对冲，省得第二路刚起步就被砍。
    const hedgeAt = Math.min(hedgeDelayMs, maxTotalMs - 50);
    const hedgeTimer = hedgeAt > 0
      ? setTimeout(() => {
          // **只在头号一个字节都没来时才对冲。**
          //
          // 线上实测：gpt-image-2.6 正常出图要 21–37 秒，而老规则是「30 秒还没结果
          // 就复制一份到别的号上」。于是本来会成功的请求在 30 秒被复制，第一路
          // 35 秒赢了、第二路被掐断 —— 但上游那边已经在生成了，一张图白烧两份额度。
          //
          // 首字节 2.7–5 秒就到了，说明上游在正常推流，只是慢；这种情况等它就行。
          // 真卡死的号由 10 秒的 hangJudge 掐掉、lane 自己换下一个，不需要对冲兜底。
          const progressing = headFirstByteAt > 0;
          // 探索是另一个诉求：去试「从没上过场」的号。它和「复制一个会成功的请求」
          // 不完全等价，所以单独给一个开关（policy.exploreWhileProgressing）。
          const exploreOnly = progressing && allowExploreWhileProgressing && exploreIdx.length > 0;
          if (!winner && !closed && (!progressing || exploreOnly)) {
            spawnLane({ preferExplore: true });
          }
        }, hedgeAt)
      : null;
    hedgeTimer?.unref?.();

    spawnLane();

    try {
      const result = await Promise.race([
        winPromise,
        allDonePromise.then(() => null),
        deadlinePromise,
      ]);
      if (fatalError) throw fatalError;
      if (!result) {
        // 客户端掐断（Magpie 的 499）要原样抛 AbortError：poolFetch 靠它记
        // `client_aborted`，报成 503 会让日志看不出「是我们慢还是用户走了」。
        if (parentSignal?.aborted || signal?.aborted) throw abortError();
        if (deadlineHit()) throw timeoutError();
        if (lastError && lastError.status === 400) throw lastError;
        if (laneErrors.length) throw laneErrors[0];
        throw new ImageHttpError(
          503,
          lastError?.message ? `所有 GPTFree 账号生图失败（最近原因：${lastError.message}）` :
            "所有 GPTFree 账号均不可用于当前生图请求；请检查账号状态或网络代理。",
          lastError?.code || "pool_exhausted",
        );
      }
      return result;
    } finally {
      closed = true;
      clearTimeout(hedgeTimer);
      hub.abort();
    }
  }

  try {
    const count = Math.max(1, Math.min(4, Number(request.n || 1)));
    if (count === 1) {
      const single = await runGroup(0, signal);
      const data = single.data.slice(0, 1);
      return {
        created: Number(single.created) || Math.floor(Date.now() / 1000),
        data,
        usage: estimateUsage(request, data),
      };
    }

    // n>1：每张图一个独立的 lane 组，各自从不同的号起手，互不抢号。
    const groupAbort = new AbortController();
    const forwardAbort = () => groupAbort.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const groupSignal = linkAbort(groupAbort.signal, deadline.signal);

    try {
      const settled = await Promise.all(
        Array.from({ length: count }, (_, idx) => runGroup(idx % accounts.length, groupSignal)),
      );
      const data = [];
      for (const item of settled) {
        if (Array.isArray(item?.data) && item.data.length) {
          data.push(item.data[0]);
        }
      }
      const finalData = data.slice(0, count);
      if (!finalData.length) {
        throw new ImageHttpError(502, "No images were returned by upstream", "no_image_generated");
      }
      return {
        created: Number(settled[0]?.created) || Math.floor(Date.now() / 1000),
        data: finalData,
        usage: estimateUsage(request, finalData),
      };
    } catch (err) {
      groupAbort.abort();
      throw err;
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
    }
  } finally {
    clearTimeout(deadlineTimer);
  }
}
