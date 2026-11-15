/**
 * Magpie GPTFree GUI backend.
 *
 * Page CSP forbids fetch(); the entry page navigates its own sandboxed
 * frame to this plugin-owned loopback service.  The service serves its
 * own UI and only accepts API calls bearing a one-page random capability.
 *
 * Magpie web tunnels this service under its per-page URL token. Desktop
 * Magpie uses 127.0.0.1; neither path uses plugins.json for secrets.
 */
import { createServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, join, dirname } from "node:path";
import {
  parseAccounts, safeAccountName, validateProxyUrl, MAX_BYTES,
} from "./credentials.mjs";
import { runBatch } from "./importer.mjs";
import { refreshPoolAccount } from "./codex-pool.mjs";
import {
  createInMemoryStatsStore,
  defaultStatsFile,
  readPoolStats,
  removeAccountStats,
  sanitizeStatsMessage,
  summarizePoolStats,
} from "./pool-stats.mjs";
import { listPool, poolDir, removePool } from "./pool-vault.mjs";
import {
  IMAGE_REPLY_MODES,
  readImageReplyMode,
  readImageRetentionDays,
  writeImageReplyMode,
  writeImageRetentionDays,
} from "./reply-settings.mjs";
import {
  MAX_DELETE_PER_REQUEST,
  deleteImages,
  listImageNames,
  listImages,
  mimeOf,
  purgeOlderThanDays,
  resolveImagePath,
} from "./image-store.mjs";

export const GUI_PORT = 37990;
/**
 * The page capability used to live for one hour, in memory only, so every
 * Magpie plugin-host restart (Magpie reloads community plugins roughly hourly)
 * and every long-lived page turned into "GUI session expired". It now lives for
 * a day and is persisted 0600 next to the encrypted vault, so an open page keeps
 * working across a host restart. The token is only a CSRF capability: requests
 * must still come from Magpie's sandboxed frame (Origin: null) to this exact
 * loopback port, and losing the file merely costs one page reload.
 */
const SESSION_LIFETIME = 24 * 60 * 60 * 1000;
const SESSION_FILE = "gui-sessions.json";
const MAX_SESSIONS = 200;
const DRAFT_LIFETIME = 15 * 60 * 1000;
const MAX_POST_BYTES = MAX_BYTES + 8192;
const root = join(dirname(fileURLToPath(import.meta.url)), "../gui");
// 版本号只从 package.json 读一次：页脚和 /api/health 都用它，避免两处对不上。
let cachedVersion = null;
async function packageVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const raw = JSON.parse(await readFile(join(root, "../package.json"), "utf8"));
    cachedVersion = String(raw.version || "").trim() || "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

const now = () => Date.now();
function json(response, status, obj) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(obj));
}
function deny(response, status = 403, reason = "Access denied") {
  json(response, status, { error: reason });
}
function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function setHeaders(response, origin) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (origin === "null") {
    response.setHeader("Access-Control-Allow-Origin", "null");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-GPTFree-Session");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Private-Network", "true");
    response.setHeader("Vary", "Origin");
  }
}
async function bodyJSON(request) {
  if (Number(request.headers["content-length"] || 0) > MAX_POST_BYTES)
    throw Object.assign(new Error("TXT 文件超过 1 MiB"), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_POST_BYTES)
      throw Object.assign(new Error("TXT 文件超过 1 MiB"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求 JSON 无效"), { status: 400 });
  }
}
function publicAccount(a, id, idx) {
  return {
    id, line: a.line ?? idx + 1,
    email: safeAccountName(a.email),
    format: a.kind || "standard",
    has2FA: !!a.totp,
    tokenState: a.kind === "access_token" ? a.tokenState : null,
  };
}
function previewOf(parsed) {
  return {
    count: parsed.accounts.length,
    duplicates: parsed.duplicates,
    errors: parsed.errors.slice(0, 100),
    rows: parsed.accounts.map((a, i) => publicAccount(a, "row-" + i, i)),
  };
}

export function createGuiService({
  parse = parseAccounts, batch = runBatch,
  poolRead = listPool, poolRemove = removePool,
  refreshAccount = refreshPoolAccount,
  onPoolChange = null,
  statsFile, statsStore, runWorker,
  clock = now, port = GUI_PORT, bind = "127.0.0.1",
  sessionFile = undefined,
} = {}) {
  const sessions = new Map();
  // Persisting the capability keeps this page usable after Magpie restarts the
  // plugin host. Tests and embedders that inject their own stores stay
  // in-memory, so no file is written for them.
  const resolvedSessionFile = sessionFile === false ? null :
    sessionFile !== undefined ? sessionFile :
    (poolRead === listPool ? join(poolDir(), SESSION_FILE) : null);
  let sessionsLoaded = false;
  let savingSessions = Promise.resolve();
  let poolChange = onPoolChange;
  const accountIds = new Map();
  const idKey = randomBytes(32);
  let activeJob = null;
  let recentJob = null;
  let pendingDraft = null;
  const resolvedStatsTarget = (statsFile !== undefined || statsStore !== undefined)
    ? {
        ...(statsFile !== undefined ? { statsFile } : {}),
        ...(statsStore !== undefined ? { statsStore } : {}),
      }
    : (poolRead === listPool
      ? { statsFile: defaultStatsFile() }
      : { statsStore: createInMemoryStatsStore() });
  async function buildAccountsSnapshot() {
    const rows = await poolRead();
    const stats = await readPoolStats(resolvedStatsTarget);
    accountIds.clear();
    for (const a of rows) {
      if (typeof a?.email === "string") accountIds.set(who(a.email), a.email);
    }
    const {
      accounts, quotaStats, deadBreakdown, history, today, last7, failBreakdown,
    } = summarizePoolStats(rows, stats, {
      nowMs: clock(),
      resolveId: who,
    });
    let valid = 0;
    let needsRenew = 0;
    for (const a of accounts) {
      if (a.tokenState === "unexpired_unverified") valid++;
      else needsRenew++;
    }
    return {
      total: accounts.length,
      summary: { total: accounts.length, valid, needsRenew },
      quotaStats,
      accounts,
      deadBreakdown,
      history,
      today,
      last7,
      failBreakdown,
    };
  }
  /**
   * Reload the page capabilities written by a previous host process. Only the
   * opaque token and its expiry are stored: no draft, job, account or secret.
   * A missing/corrupt file is not an error; the page just opens a new session.
   */
  async function loadSessions() {
    if (sessionsLoaded || !resolvedSessionFile) {
      sessionsLoaded = true;
      return;
    }
    sessionsLoaded = true;
    let parsed;
    try { parsed = JSON.parse(await readFile(resolvedSessionFile, "utf8")); }
    catch { return; }
    const entries = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const t = clock();
    for (const entry of entries) {
      const id = typeof entry?.id === "string" && /^[0-9a-f]{64}$/.test(entry.id) ? entry.id : "";
      const expires = Number(entry?.expires);
      if (!id || !Number.isFinite(expires) || expires <= t || sessions.has(id)) continue;
      sessions.set(id, { expires, draft: null, job: null });
    }
  }
  function persistSessions() {
    if (!resolvedSessionFile) return Promise.resolve();
    // Serialize writes: several requests may open or refresh a session at once.
    const snapshot = JSON.stringify({
      version: 1,
      sessions: [...sessions.entries()]
        .map(([id, s]) => ({ id, expires: s.expires }))
        .sort((a, b) => b.expires - a.expires)
        .slice(0, MAX_SESSIONS),
    }, null, 2);
    const write = async () => {
      const tmp = `${resolvedSessionFile}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await mkdir(join(resolvedSessionFile, ".."), { recursive: true, mode: 0o700 });
        await writeFile(tmp, snapshot, { mode: 0o600, flag: "wx" });
        await rename(tmp, resolvedSessionFile);
      } catch {
        // An unwritable home only loses cross-restart continuity, never access.
      } finally {
        await rm(tmp, { force: true }).catch(() => {});
      }
    };
    savingSessions = savingSessions.then(write, write);
    return savingSessions;
  }
  function prune() {
    const t = clock();
    if (pendingDraft && pendingDraft.expires <= t) pendingDraft = null;
    let dropped = false;
    for (const [id, s] of sessions) {
      if (s.expires < t) {
        s.job?.controller?.abort();
        sessions.delete(id);
        dropped = true;
      } else if (s.draft && s.draft.expires < t) {
        s.draft = null;
      }
    }
    if (dropped) void persistSessions();
  }
  function stagePendingDraft(source, { filename = "accounts.txt", parsed = null } = {}) {
    let summary = parsed;
    if (!summary) {
      try { summary = parse(source); } catch { summary = { accounts: [], errors: [] }; }
    }
    pendingDraft = {
      source,
      filename: String(filename || "accounts.txt").slice(0, 120),
      validCount: summary?.accounts?.length || 0,
      errorCount: summary?.errors?.length || 0,
      expires: clock() + DRAFT_LIFETIME,
    };
    return pendingDraft;
  }
  function who(email) {
    return createHmac("sha256", idKey).update(email).digest("hex").slice(0, 32);
  }
  function openSession() {
    prune();
    const id = randomBytes(32).toString("hex");
    const s = { expires: clock() + SESSION_LIFETIME, draft: null, job: null };
    sessions.set(id, s);
    void persistSessions();
    return id;
  }
  function session(request) {
    const id = request.headers["x-gptfree-session"];
    if (typeof id !== "string" || id.length !== 64) return null;
    const s = sessions.get(id);
    if (!s || s.expires <= clock()) return null;
    s.expires = clock() + SESSION_LIFETIME;
    return s;
  }
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    setHeaders(res, origin);
    // The import GUI only lives in Magpie's sandboxed plugin frame.
    // Its requests have Origin: null; never trust a regular website.
    const local = "http://127.0.0.1:" + server.address()?.port;
    const allowedOrigin = !origin || origin === "null";
    if (req.headers.host !== new URL(local).host) return deny(res, 403, "Invalid local service host");
    const uri = new URL(req.url || "/", local);
    const route = uri.pathname;
    if (req.method === "OPTIONS") {
      if (!allowedOrigin) return deny(res);
      res.writeHead(204); res.end(); return;
    }
    if (!allowedOrigin) return deny(res);
    if (route === "/ui" && req.method === "GET") {
      // Never expose a provider-login ticket URL: native Providers uses
      // the OS file picker instead of navigating to a browser.
      if (uri.searchParams.has("ticket"))
        return deny(res, 410, "浏览器导入入口已废弃，请在 Magpie 内选择文件");
      const id = openSession();
      const source = await readFile(join(root, "dashboard.html"), "utf8");
      const html = source.replace("__GPTFREE_SESSION__", id)
        .replace("__GPTFREE_ENTRY_MODE__", "sidebar")
        .replace("__GPTFREE_VERSION__", await packageVersion());
      // A sandboxed page has an opaque origin. Safari/WebKit does not
      // reliably resolve 'self' from one, so explicitly name the loopback
      // server as well. Magpie web expands 'self' to its protected page
      // service proxy URL in its own response policy.
      const local = "http://127.0.0.1:" + server.address().port;
      res.setHeader("Content-Security-Policy",
        "default-src 'none'; script-src 'self' " + local + "; " +
        "style-src 'self' " + local + " 'unsafe-inline'; " +
        "connect-src 'self' " + local + "; img-src 'self' " + local + " data:; " +
        "font-src 'self' " + local + "; base-uri 'none'; object-src 'none'; form-action 'none'");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (route === "/assets/app.js" || route === "/assets/style.css") {
      if (req.method !== "GET") return deny(res, 405, "Method not allowed");
      const file = route === "/assets/app.js" ? "app.js" : "style.css";
      res.writeHead(200, {
        "Content-Type": file.endsWith(".js") ?
          "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
      });
      res.end(await readFile(join(root, file)));
      return;
    }
    if (!route.startsWith("/api/")) return deny(res, 404, "Not found");
    // 只读健康检查，给 cron / 面板用：不需要 GUI 会话，只回聚合数字（没有邮箱、
    // 没有凭据）。端口 37990 没有发布到宿主机（只有 3425/3430 是 127.0.0.1 映射），
    // 所以只有容器内部能访问；哪天要对外暴露，请在前面挂一层 nginx 加白名单。
    // 缩略图必须走同源：面板的 CSP 是 `img-src 'self' <local> data:`，直接引用
    // 外网的 /img/ 会被浏览器拦掉。这里只把文件读出来透传，不做缩放 —— 不引入
    // 缩图服务。和 /api/health 一样不要求 GUI 会话：`<img>` 发不了自定义头。
    // 端口只监听 127.0.0.1，而且同一批图本来就由 nginx 的 /img/ 对外公开。
    if (route === "/api/images/file" && req.method === "GET") {
      const name = uri.searchParams.get("name") || "";
      const full = resolveImagePath(name);
      if (!full) return deny(res, 400, "Invalid image name");
      let data;
      try {
        data = await readFile(full);
      } catch {
        return deny(res, 404, "Image not found");
      }
      res.writeHead(200, {
        "Content-Type": mimeOf(name),
        "Content-Length": data.length,
        "Cache-Control": "private, max-age=300",
      });
      res.end(data);
      return;
    }
    if (route === "/api/health" && req.method === "GET") {
      const rows = await poolRead();
      const stats = await readPoolStats(resolvedStatsTarget);
      const { quotaStats } = summarizePoolStats(rows, stats, { nowMs: clock() });
      const minUsable = envNumber("MAGPIE_GPTFREE_HEALTH_MIN_USABLE", 3);
      const minQuota = envNumber("MAGPIE_GPTFREE_HEALTH_MIN_QUOTA", 50);
      // 池子见底时返回 503，这样 cron 不用解析 body 也能判断。
      const ok = quotaStats.active >= minUsable && quotaStats.totalQuota >= minQuota;
      return json(res, ok ? 200 : 503, {
        ok,
        version: await packageVersion(),
        usable: quotaStats.active,
        limited: quotaStats.limited,
        dead: quotaStats.dead,
        needsRenew: quotaStats.needsRenew,
        unchecked: quotaStats.unchecked,
        total: quotaStats.total,
        totalQuota: quotaStats.totalQuota,
        totalSuccess: quotaStats.totalSuccess,
        totalFail: quotaStats.totalFail,
        thresholds: { minUsable, minQuota },
        updatedAt: quotaStats.updatedAt,
      });
    }
    await loadSessions();
    const s = session(req);
    // A page open across a plugin-host restart resumes with a fresh session
    // instead of dead-ending on an error banner for the rest of the hour.
    if (!s) return deny(res, 403, "GUI session expired; reopen the plugin page");
    if (req.method === "POST" &&
        (!req.headers["content-type"]?.startsWith("application/json") ||
         origin !== "null"))
      return deny(res, 403, "Secure GUI request required");
    try {
      if (route === "/api/draft" && req.method === "GET") {
        prune();
        if (!pendingDraft || pendingDraft.expires <= clock()) {
          pendingDraft = null;
          return json(res, 200, { hasDraft: false });
        }
        const draft = pendingDraft;
        pendingDraft = null;
        return json(res, 200, {
          hasDraft: true,
          filename: draft.filename,
          text: draft.source,
          validCount: draft.validCount,
          errorCount: draft.errorCount,
        });
      }
      if (route === "/api/sync" && req.method === "POST") {
        if (!poolChange) return json(res, 200, { synced: false, connected: false, count: 0 });
        const updated = await poolChange();
        return json(res, 200, {
          synced: true,
          connected: updated?.connected === true,
          count: Number(updated?.count || 0),
        });
      }
      if (route === "/api/preview" && req.method === "POST") {
        if (activeJob?.state === "running") return deny(res, 409, "An import is in progress");
        const data = await bodyJSON(req);
        if (typeof data?.text !== "string") return deny(res, 400, "Choose a TXT file");
        const parsed = parse(data.text);
        const summary = previewOf(parsed);
        s.draft = {
          source: data.text,
          expires: clock() + DRAFT_LIFETIME,
          count: parsed.accounts.length,
          invalid: parsed.errors.length,
        };
        s.job = null;
        return json(res, 200, { ...summary, expiresIn: DRAFT_LIFETIME / 1000 });
      }
      if (route === "/api/start" && req.method === "POST") {
        const data = await bodyJSON(req);
        if (!s.draft || s.draft.expires <= clock())
          return deny(res, 410, "Preview expired: select TXT again");
        const skipInvalid = data?.skipInvalid === true;
        if (!s.draft.count || (s.draft.invalid > 0 && !skipInvalid))
          return deny(res, 422, "Fix TXT validation errors before importing");
        if (data?.consent !== true) return deny(res, 403, "Account ownership confirmation required");
        if ((data?.mode ?? "pool") !== "pool")
          return deny(res, 400, "已移除 Codex CLI 导入模式，请使用 GPTFree号池");
        const proxyCheck = validateProxyUrl(data?.proxy);
        if (proxyCheck.error) return deny(res, 400, proxyCheck.error);
        if (activeJob?.state === "running") return deny(res, 409, "Another import is running");
        const draft = s.draft;
        s.draft = null;
        pendingDraft = null;
        const controller = new AbortController();
        const job = {
          id: randomBytes(16).toString("hex"),
          state: "running", mode: "pool", started: clock(),
          total: draft.count, done: 0, added: 0, reused: 0,
          failed: 0, events: [], eventSeq: 0, controller, result: null,
          providerConnected: null, providerCount: null,
        };
        activeJob = job;
        recentJob = job;
        s.job = job;
        // Respond immediately. Account OAuth and browser work asynchronously.
        queueMicrotask(async () => {
          let syncChain = Promise.resolve();
          try {
            const answer = await batch({
              file: "gui-upload",
              read: async () => draft.source,
              mode: job.mode,
              consent: true,
              skipInvalid,
              proxy: proxyCheck.proxy,
              signal: controller.signal,
              ...(statsStore !== undefined ? { statsStore: resolvedStatsTarget.statsStore } : {}),
              ...(statsFile !== undefined ? { statsFile: resolvedStatsTarget.statsFile } : {}),
              onProgress: (event) => {
                if (job.state !== "running" || controller.signal.aborted) return;
                if (["added", "token_reused", "failed"].includes(event.state)) job.done++;
                if (event.state === "added" || event.state === "token_reused") {
                  job.added++;
                  if (draft.count > 1 && job.added > 1 && poolChange) {
                    syncChain = syncChain.then(() => poolChange()).catch(() => {});
                  }
                }
                if (event.state === "token_reused") job.reused++;
                if (event.state === "failed") job.failed++;
                job.events.push({ ...event, seq: ++job.eventSeq, at: clock() });
                if (job.events.length > 250) job.events.shift();
              },
            });
            await syncChain;
            job.result = {
              total: answer.total,
              added: answer.added, reused: answer.reused,
              failed: answer.failed?.length || 0,
              duplicates: answer.duplicates || 0,
              invalid: answer.invalid?.length || 0,
            };
            job.added = answer.added;
            job.reused = answer.reused;
            job.failed = answer.failed?.length || 0;
            // Successful pool imports must automatically connect all pooled
            // accounts in Magpie Providers.
            if (job.mode === "pool" && answer.added > 0 && poolChange) {
              try {
                const updated = await poolChange();
                job.providerConnected = updated?.connected === true;
                job.providerCount = Number(updated?.count ?? answer.added);
                if (!job.providerConnected)
                  job.message = "账号已导入，但 Magpie 本地号池暂未连接，请检查本地存储状态";
              } catch {
                job.providerConnected = false;
                job.message = "账号已入池，但 Magpie Provider 状态同步失败；请重新打开插件查看";
              }
            }
            job.state = controller.signal.aborted ? "canceled" : "completed";
          } catch {
            await syncChain;
            if (job.added > 0 && poolChange) {
              try {
                const partial = await poolChange();
                job.providerConnected = partial?.connected === true;
                job.providerCount = Number(partial?.count ?? job.added);
              } catch {}
            }
            job.state = controller.signal.aborted ? "canceled" : "error";
            job.message = controller.signal.aborted ?
              "导入已取消" : "导入进程遇到错误；请检查本机 Magpie 与网络/代理配置";
          } finally {
            if (activeJob === job) activeJob = null;
          }
        });
        return json(res, 202, { jobId: job.id, state: "running" });
      }
      if (route === "/api/status" && req.method === "GET") {
        // A new Magpie page session can resume the currently running job.
        // No secrets are in progress events, and the endpoint still requires
        // the page's random capability.
        if (!s.job && activeJob?.state === "running") s.job = activeJob;
        else if (!s.job && recentJob && clock() - recentJob.started < 30 * 60 * 1000)
          s.job = recentJob;
        const job = s.job;
        if (!job) return json(res, 200, { state: "idle" });
        return json(res, 200, {
          id: job.id, state: job.state, mode: job.mode,
          total: job.total, done: job.done, added: job.added,
          reused: job.reused, failed: job.failed,
          result: job.result, message: job.message || "",
          providerConnected: job.providerConnected, providerCount: job.providerCount ?? null,
          events: job.events,
        });
      }
      if (route === "/api/cancel" && req.method === "POST") {
        if (s.job?.state !== "running") return deny(res, 409, "No import in progress");
        s.job.controller.abort();
        return json(res, 200, { cancelRequested: true });
      }
      if (route === "/api/accounts" && req.method === "GET") {
        return json(res, 200, await buildAccountsSnapshot());
      }
      if (route === "/api/stats" && req.method === "GET") {
        const snap = await buildAccountsSnapshot();
        // 回复形态跟统计一起下发，面板就不用为它多发一次请求（整页仍是一条数据流）。
        const imageReply = await readImageReplyMode();
        return json(res, 200, {
          total: snap.total,
          summary: snap.quotaStats,
          quotaStats: snap.quotaStats,
          accounts: snap.accounts,
          deadBreakdown: snap.deadBreakdown,
          history: snap.history,
          today: snap.today,
          last7: snap.last7,
          failBreakdown: snap.failBreakdown,
          imageReply: {
            mode: imageReply.mode,
            source: imageReply.source,
            modes: IMAGE_REPLY_MODES,
            // 环境变量压着文件时，面板上这个下拉是只读的 —— 否则用户改了不生效、还以为坏了。
            locked: imageReply.source === "env",
          },
        });
      }
      if (route === "/api/images" && req.method === "GET") {
        const sort = uri.searchParams.get("sort") === "size" ? "size" : "time";
        const from = uri.searchParams.get("from") || "";
        const to = uri.searchParams.get("to") || "";
        const retention = await readImageRetentionDays();
        const retentionInfo = {
          days: retention.days,
          source: retention.source,
          // env 压着设置文件时面板只读：改了不生效反而让人以为坏了。
          locked: retention.source === "env",
        };
        // namesOnly=1：给「全选当前筛选结果」和「清理早于 N 天」的二次确认取全量
        // （带 size，确认框才能写出准确的总占用），不分页。
        if (uri.searchParams.get("namesOnly") === "1") {
          const items = await listImageNames({ from, to });
          return json(res, 200, {
            total: items.length,
            bytes: items.reduce((sum, item) => sum + item.size, 0),
            items,
            retention: retentionInfo,
          });
        }
        const page = await listImages({
          sort, from, to,
          offset: Number(uri.searchParams.get("offset") || 0),
          limit: Number(uri.searchParams.get("limit") || 20),
        });
        return json(res, 200, { ...page, sort, from, to, retention: retentionInfo });
      }
      if (route === "/api/images/delete" && req.method === "POST") {
        const input = await bodyJSON(req);
        const names = Array.isArray(input?.names) ? input.names : null;
        if (!names) return json(res, 400, { error: "names 必须是数组" });
        if (names.length > MAX_DELETE_PER_REQUEST) {
          return json(res, 400, {
            error: `一次最多删 ${MAX_DELETE_PER_REQUEST} 张，请分批（本次 ${names.length} 张）`,
          });
        }
        const { deleted, failed } = await deleteImages(names);
        return json(res, 200, {
          ok: failed.length === 0,
          deleted: deleted.length,
          failed,
        });
      }
      if (route === "/api/images/purge" && req.method === "POST") {
        const input = await bodyJSON(req);
        const days = Number(input?.olderThanDays);
        if (!Number.isFinite(days) || days < 1 || days > 3650) {
          return json(res, 400, { error: "olderThanDays 要在 1–3650 之间" });
        }
        const { deleted, failed, scanned } = await purgeOlderThanDays(days);
        return json(res, 200, {
          ok: failed.length === 0,
          deleted: deleted.length,
          scanned,
          failed,
        });
      }
      if (route === "/api/settings" && req.method === "POST") {
        const input = await bodyJSON(req);
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          return json(res, 400, { error: "无效的设置请求" });
        }
        try {
          if (input.imageReply !== undefined) await writeImageReplyMode(input.imageReply);
          if (input.imageRetentionDays !== undefined) {
            await writeImageRetentionDays(input.imageRetentionDays);
          }
        } catch (err) {
          return json(res, err?.status === 400 ? 400 : 500, { error: String(err?.message || err) });
        }
        const reply = await readImageReplyMode();
        const retention = await readImageRetentionDays();
        // 环境变量压着时文件写成功了也不生效，得如实说，不能让面板显示成功。
        const overrides = [];
        if (reply.source === "env") {
          overrides.push(`回复格式被环境变量 MAGPIE_GPTFREE_IMAGE_REPLY=${reply.mode} 覆盖`);
        }
        if (retention.source === "env") {
          overrides.push(`保留天数被环境变量 MAGPIE_GPTFREE_IMAGE_RETENTION_DAYS=${retention.days} 覆盖`);
        }
        return json(res, 200, {
          ok: true,
          imageReply: { mode: reply.mode, source: reply.source, locked: reply.source === "env" },
          imageRetention: {
            days: retention.days, source: retention.source, locked: retention.source === "env",
          },
          message: overrides.length ? `已保存，但${overrides.join("；")}` : "设置已保存",
        });
      }
      if (route === "/api/accounts/refresh" && req.method === "POST") {
        if (activeJob?.state === "running")
          return deny(res, 409, "批量导入正在运行，请等待完成后再检测刷新");
        const input = await bodyJSON(req);
        const proxyCheck = validateProxyUrl(input?.proxy);
        if (proxyCheck.error) return deny(res, 400, proxyCheck.error);
        const rows = await poolRead();
        const rowById = new Map();
        for (const r of rows) {
          const id = who(r.email);
          accountIds.set(id, r.email);
          rowById.set(id, r);
        }
        let targets;
        if (input?.all === true) {
          targets = rows;
        } else if (Array.isArray(input?.ids) && input.ids.length) {
          // 表格多选：一次请求里串行检测，避免前端打 N 个并发请求。
          targets = [];
          for (const id of input.ids) {
            const target = rowById.get(id);
            if (target) targets.push(target);
          }
          if (!targets.length) return deny(res, 404, "Account not found; refresh list");
        } else if (typeof input?.id === "string" && input.id) {
          const target = rowById.get(input.id);
          if (!target) return deny(res, 404, "Account not found; refresh list");
          targets = [target];
        } else {
          return deny(res, 400, "请指定要检测刷新的账号");
        }
        const results = [];
        let valid = 0, renewed = 0, failed = 0, quotaChecked = 0, quotaFailed = 0;
        const quotaOnly = input?.quotaOnly === true;
        for (const row of targets) {
          const refreshOpts = {
            proxy: proxyCheck.proxy,
            forceRenew: input?.force === true,
          };
          if (refreshAccount === refreshPoolAccount) {
            refreshOpts.includeQuota = true;
            refreshOpts.quotaOnly = quotaOnly;
            if (resolvedStatsTarget.statsStore) refreshOpts.statsStore = resolvedStatsTarget.statsStore;
            if (resolvedStatsTarget.statsFile !== undefined) refreshOpts.statsFile = resolvedStatsTarget.statsFile;
            if (runWorker) refreshOpts.runWorker = runWorker;
          }
          const outcome = await refreshAccount(row, refreshOpts);
          if (outcome?.status === "valid") valid++;
          else if (outcome?.status === "renewed") renewed++;
          else failed++;
          if (outcome?.quotaOk === true) quotaChecked++;
          else if (outcome?.quotaOk === false) quotaFailed++;
          results.push({
            id: who(row.email),
            email: safeAccountName(row.email),
            ok: outcome?.ok === true,
            status: outcome?.status || "failed",
            renewed: outcome?.renewed === true,
            tokenState: outcome?.tokenState || null,
            reason: outcome?.reason ? String(outcome.reason).slice(0, 180) : "",
            ...(outcome?.quotaOk !== undefined ? { quotaOk: outcome.quotaOk === true } : {}),
            ...(outcome?.imageQuota !== undefined ? { imageQuota: outcome.imageQuota } : {}),
            ...(outcome?.quotaResetAt !== undefined ? { quotaResetAt: outcome.quotaResetAt } : {}),
            ...(outcome?.planType !== undefined ? { planType: outcome.planType } : {}),
            ...(outcome?.quotaError ? { quotaError: sanitizeStatsMessage(outcome.quotaError) } : {}),
          });
        }
        let providerConnected = null;
        if ((renewed > 0 || (valid > 0 && !quotaOnly)) && poolChange) {
          try {
            const sync = await poolChange();
            providerConnected = sync?.connected === true;
          } catch {
            providerConnected = null;
          }
        }
        const snap = await buildAccountsSnapshot();
        return json(res, 200, {
          total: results.length,
          valid, renewed, failed,
          quotaChecked, quotaFailed,
          providerConnected,
          quotaStats: snap.quotaStats,
          accounts: snap.accounts,
          results,
        });
      }
      if (route === "/api/remove" && req.method === "POST") {
        const input = await bodyJSON(req);
        // 支持一次删一个（id）或批量（ids）；界面上的多选走批量。
        const ids = Array.isArray(input?.ids) ? input.ids : [input?.id];
        // 明确传了空数组 = 前端算错了选择集。不能静默当成功，也不能当 404。
        if (Array.isArray(input?.ids) && !ids.length)
          return deny(res, 400, "没有选中任何账号");
        const targets = [];
        for (const id of ids) {
          const email = accountIds.get(id);
          if (email) targets.push({ id, email });
        }
        if (!targets.length) return deny(res, 404, "Account not found; refresh list");
        for (const { id, email } of targets) {
          await poolRemove(email);
          await removeAccountStats(email, resolvedStatsTarget).catch(() => {});
          accountIds.delete(id);
        }
        // Removing the last account must sign out the linked provider too;
        // removing one of several must leave the pool connected.
        let providerConnected = null;
        let connectionError = false;
        if (poolChange) {
          try {
            const sync = await poolChange();
            providerConnected = sync?.connected === true;
          } catch {
            connectionError = true;
          }
        }
        return json(res, 200, {
          removed: true, count: targets.length, providerConnected, connectionError,
        });
      }
      return deny(res, 404, "Not found");
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 422;
      // Never relay raw upstream/FS exceptions: they may expose credentials.
      const message = err?.status ? err.message :
        route === "/api/preview" ? "TXT 校验失败；请检查文件格式、大小和账号数量" :
        "操作失败；请检查账号池文件权限或本地服务";
      json(res, status, { error: message });
    }
  });
  return {
    server, sessions,
    setOnPoolChange(callback) { poolChange = callback; },
    async stageDraft(file) {
      let source;
      try { source = await readFile(file, "utf8"); }
      catch { throw new Error("无法读取选中的 TXT 文件"); }
      const parsed = parse(source);
      const filename = basename(file);
      stagePendingDraft(source, { filename, parsed });
      return {
        filename,
        count: parsed.accounts.length,
        errors: parsed.errors.length,
        firstError: parsed.errors[0] || null,
      };
    },
    /**
     * Providers -> GPTFree calls an OS-native file dialog, then imports in
     * the plugin host. No web page is opened. The progress is visible in
     * the SAME Magpie sidebar GUI, through /api/status.
     *
     * The sign-in returns on FIRST successful account; the rest can keep
     * importing in the background. The hook never returns a credential.
     */
    async startNativeImport(file, { signal, mode = "pool", skipInvalid = false, onFirstAccount = null } = {}) {
      if (mode !== "pool") throw new Error("Providers 入口仅支持独立 Token 号池");
      if (activeJob?.state === "running") throw new Error("已有批量导入任务正在运行，请在左侧菜单「GPTFree号池」页面查看进度");
      // Validate before launching any browser or calling upstream.
      let source;
      try { source = await readFile(file, "utf8"); }
      catch { throw new Error("无法读取选中的 TXT 文件"); }
      const parsed = parse(source);
      const filename = basename(file);
      if (parsed.accounts.length === 0 || (parsed.errors.length > 0 && !skipInvalid)) {
        stagePendingDraft(source, { filename, parsed });
        const firstErr = parsed.errors[0];
        const detail = firstErr ? `（第 ${firstErr.line} 行：${firstErr.reason}）` : "";
        throw new Error(
          parsed.errors.length > 0
            ? `账号 TXT 格式不正确，共 ${parsed.errors.length} 行错误${detail}；已自动暂存到左侧菜单「GPTFree号池」文本框，打开即可编辑或跳过错误行导入`
            : "账号 TXT 格式无效或为空，已预加载到左侧菜单「GPTFree号池」文本框检查"
        );
      }
      pendingDraft = null;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) controller.abort();
      const job = {
        id: randomBytes(16).toString("hex"),
        state: "running", mode: "pool", started: clock(),
        total: parsed.accounts.length, done: 0, added: 0,
        reused: 0, failed: 0, events: [], eventSeq: 0,
        controller, result: null, providerConnected: null, providerCount: null,
      };
      activeJob = job;
      recentJob = job;
      let resolveFirst;
      const first = new Promise(resolve => { resolveFirst = resolve; });
      let settled = false;
      const settleFirst = (result) => {
        if (settled) return;
        settled = true;
        resolveFirst(result);
      };
      queueMicrotask(async () => {
        let syncChain = Promise.resolve();
        try {
          const answer = await batch({
            file, mode: "pool", consent: true, skipInvalid,
            signal: controller.signal, read: async () => source,
            ...(statsStore !== undefined ? { statsStore: resolvedStatsTarget.statsStore } : {}),
            ...(statsFile !== undefined ? { statsFile: resolvedStatsTarget.statsFile } : {}),
            onProgress: (event) => {
              if (job.state !== "running") return;
              if (["added", "token_reused", "failed"].includes(event.state)) job.done++;
              if (["added", "token_reused"].includes(event.state)) {
                job.added++;
                const slotTag = typeof event.slotTag === "string" ? event.slotTag : "";
                const label = typeof event.accountLabel === "string" ? event.accountLabel :
                  typeof event.email === "string" ? event.email : "";
                if (!settled) {
                  try { onFirstAccount?.({ slotTag, label }); } catch {}
                  // The provider can be signed in now; no second login step.
                  settleFirst({ ok: true, slotTag, label });
                } else if (parsed.accounts.length > 1 && poolChange) {
                  syncChain = syncChain.then(() => poolChange()).catch(() => {});
                }
              }
              if (event.state === "token_reused") job.reused++;
              if (event.state === "failed") job.failed++;
              job.events.push({ ...event, seq: ++job.eventSeq, at: clock() });
              if (job.events.length > 250) job.events.shift();
            },
          });
          await syncChain;
          job.result = {
            total: answer.total, added: answer.added, reused: answer.reused,
            failed: answer.failed?.length || 0, duplicates: answer.duplicates || 0,
            invalid: answer.invalid?.length || 0,
          };
          job.added = answer.added;
          job.reused = answer.reused;
          job.failed = answer.failed?.length || 0;
          if (answer.added > 0 && poolChange) {
            try {
              const linked = await poolChange();
              job.providerConnected = linked?.connected === true;
              job.providerCount = Number(linked?.count ?? answer.added);
            } catch { job.providerConnected = false; }
          }
          settleFirst(answer.added ? { ok: true } : {
            ok: false, error: "没有账号成功入池；请在左侧菜单「GPTFree号池」页面查看失败原因",
          });
          job.state = controller.signal.aborted ? "canceled" : "completed";
        } catch {
          await syncChain;
          if (job.added > 0 && poolChange) {
            try {
              const linked = await poolChange();
              job.providerConnected = linked?.connected === true;
              job.providerCount = Number(linked?.count ?? job.added);
            } catch {}
          }
          settleFirst({ ok: false, error: controller.signal.aborted ?
            "批量导入已取消" : "导入失败，请在左侧菜单「GPTFree号池」页面查看详情" });
          job.state = controller.signal.aborted ? "canceled" : "error";
          job.message = controller.signal.aborted ? "已取消" : "账号导入任务失败";
        } finally {
          signal?.removeEventListener("abort", onAbort);
          source = "";
          if (activeJob === job) activeJob = null;
        }
      });
      return { jobId: job.id, first, cancel: () => controller.abort() };
    },
    async listen() {
      // A non-loopback bind would expose password/TOTP import to the LAN.
      if (bind !== "127.0.0.1") throw new Error("GUI service can only bind 127.0.0.1");
      await new Promise((resolve, reject) => {
        const failed = (e) => { server.off("listening", resolve); reject(e); };
        server.once("error", failed);
        server.once("listening", () => { server.off("error", failed); resolve(); });
        server.listen(port, bind);
      });
      return server.address();
    },
    async close() {
      for (const s of sessions.values()) s.job?.controller?.abort();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

let activeService;
/**
 * 起 GUI 服务，端口被占时有限次退避重试。
 *
 * 为什么必须重试：magpie 从面板热更新插件时不重建容器，新 host 起来时旧 host 还在
 * 关，端口会短暂重叠。原来这里只 bind 一次，失败就抛给 index.mjs 打个 warn 了事，
 * 而 magpie 的插件页代理只会去**连接**这个端口、不会重新调用 server() 钩子 ——
 * 于是一次瞬态冲突就变成永久打不开，只能 docker restart 救。
 *
 * 只有 EADDRINUSE 值得重试（权限、端口非法重试一万次也一样），其它错误立即抛。
 * 端口被外部进程长期占用时，退避完还是失败，照旧抛错让 index.mjs 打 warn ——
 * 插件本身不依赖 GUI 端口，模型照常可用。
 */
export async function startGuiServer({
  port = GUI_PORT, onPoolChange = null,
  // 只给测试用：默认 500/1000/2000/3000，合计约 6.5 秒。
  retryDelays = [500, 1000, 2000, 3000],
} = {}) {
  if (activeService) {
    if (onPoolChange) activeService.setOnPoolChange(onPoolChange);
    return activeService;
  }
  const delays = Array.isArray(retryDelays) ? retryDelays : [];
  let lastError = null;
  let attempts = 0;
  for (let round = 0; round <= delays.length; round++) {
    attempts = round + 1;
    // 每次重试都用新的 service：listen() 失败后那个 server 实例不可复用。
    const service = createGuiService({ port, onPoolChange });
    try {
      await service.listen();
      if (round > 0) {
        console.error("[gptfree] GUI service bound 127.0.0.1:%d after %d retries", port, round);
      }
      activeService = service;
      return service;
    } catch (err) {
      lastError = err;
      if (err?.code !== "EADDRINUSE" || round === delays.length) break;
      // 重试过程只在调试开关打开时输出：正常热更新会重试一两次，不该刷屏。
      if (process.env.MAGPIE_GPTFREE_GUI_DEBUG === "1") {
        console.error("[gptfree] GUI port %d busy (EADDRINUSE), retry %d/%d in %dms",
          port, round + 1, delays.length, delays[round]);
      }
      await new Promise((resolve) => setTimeout(resolve, delays[round]));
    }
  }
  const reason = lastError?.code === "EADDRINUSE" ? "port already in use" : "startup failure";
  // 重试次数写进错误文案：index.mjs 的 warn 直接把它带出去，排查时一眼能看出
  // 是「冲突了一会儿」还是「端口一直被别的进程占着」。
  throw new Error("GPTFree号池 GUI service could not bind to 127.0.0.1:" + port + " (" +
    reason + "; tried " + attempts + " time(s)" + (attempts > 1 ? " with backoff" : "") + ")");
}
