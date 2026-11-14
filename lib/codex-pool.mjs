/**
 * Standalone temporary access-token pool for ChatGPT's Codex backend.
 * This does NOT modify Magpie's native Codex accounts, and does not
 * pretend that access-only tokens have a refresh token.
 *
 * An access token is only admitted after OpenAI's own /codex/models endpoint
 * returns a non-empty model list. JWT exp is just a preflight hint.
 */
import { accessTokenState } from "./credentials.mjs";
import { accountSlotTag } from "./pool-connection.mjs";
import { listPool, upsertPool } from "./pool-vault.mjs";
import { loginHTTPAccount } from "./dsh-http-auth.mjs";
import {
  buildWebTextModelCatalog,
  executeWebTextGeneration,
} from "./chatgpt-web-text.mjs";
import {
  ImageHttpError,
  buildImageModelCatalog,
  checkWebImageQuota,
  executeWebImageGeneration,
  isImageModelId,
  parseImageRequest,
} from "./chatgpt-web-image.mjs";
import {
  defaultStatsFile,
  accountDeadReason,
  isAccountCoolingDown,
  isAccountDead,
  isAccountRateLimited,
  readPoolStats,
  recordImageCall,
  recordQuotaCheck,
  recordTextCall,
  sanitizeStatsMessage,
} from "./pool-stats.mjs";

import { bridgeChatToImage } from "./chat-image-bridge.mjs";

export const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
export const CODEX_VERSION = "0.164.0";
const MODEL_URL = CODEX_BASE + "/models?client_version=" + encodeURIComponent(CODEX_VERSION);
const MODEL_ID = /^[a-zA-Z0-9._:-]{1,128}$/;
const modelPrompts = new Map();
const pendingAuth = new Map();
let nextIndex = 0;
let authQueue = Promise.resolve();

function accessClaims(token) {
  try {
    const payload = String(token).split(".")[1];
    if (!payload || payload.length > 65536) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch { return {}; }
}

function getAccountID(token) {
  const c = accessClaims(token);
  return c?.["https://api.openai.com/auth"]?.chatgpt_account_id ||
    c?.chatgpt_account_id || "";
}

export function isWebOnlyToken(token) {
  const claims = accessClaims(token);
  if (!claims) return false;
  if (getAccountID(token)) return false;
  return String(claims.client_id || "") === "app_2SKx67EdpoN0G6j64rFvigXD"
    || Boolean(claims["https://api.openai.com/auth"] || claims["https://api.openai.com/profile"]);
}

export function isCodexToken(token) {
  return !isWebOnlyToken(token);
}

function upstreamHeaders(token, accountID, streaming) {
  const h = new Headers({
    Authorization: "Bearer " + token,
    originator: "magpie_gptfree",
    "User-Agent": `MagpieGPTFree/${CODEX_VERSION}`,
    version: CODEX_VERSION,
    "OpenAI-Beta": "responses=experimental",
    Accept: streaming ? "text/event-stream" : "application/json",
  });
  if (accountID) h.set("chatgpt-account-id", accountID);
  if (streaming) h.set("Content-Type", "application/json");
  return h;
}

export function parseCodexCatalog(payload) {
  if (!Array.isArray(payload?.models)) throw new Error("Codex models response is invalid");
  const models = {};
  for (const item of payload.models.slice(0, 256)) {
    const id = item?.slug;
    if (typeof id !== "string" || !MODEL_ID.test(id) ||
        (item.visibility && item.visibility !== "list")) continue;
    const title = typeof item.display_name === "string" ? item.display_name : id;
    const prompt = item?.model_messages?.instructions_template || item?.base_instructions;
    if (typeof prompt === "string" && prompt.length <= 150000) modelPrompts.set(id, prompt);
    models[id] = {
      id, name: title,
      api: { id, url: CODEX_BASE, npm: "@ai-sdk/openai" },
      provider: { npm: "@ai-sdk/openai" },
      tool_call: true,
      limit: { context: Number(item.context_window) || 200000, output: 32000 },
    };
  }
  if (!Object.keys(models).length) throw new Error("Codex did not provide usable models");
  return models;
}

export async function verifyAccessToken(token, { fetcher = fetch, signal, expectedEmail = "" } = {}) {
  if (accessTokenState(token).state !== "unexpired_unverified")
    return { accepted: false, reason: "expired_or_unverified" };
  const claims = accessClaims(token);
  const who = String(claims.email || "").trim().toLowerCase();
  if (who && expectedEmail && who !== expectedEmail.trim().toLowerCase())
    return { accepted: false, reason: "identity_mismatch" };
  const h = upstreamHeaders(token, getAccountID(token), false);
  let response;
  try {
    response = await fetcher(MODEL_URL, {
      headers: h, method: "GET", redirect: "error",
      signal: signal || AbortSignal.timeout(15000),
    });
  } catch {
    return { accepted: false, reason: "network_error" };
  }
  if (!response.ok) return { accepted: false, reason: "status_" + response.status };
  try {
    const models = parseCodexCatalog(await response.json());
    return { accepted: true, models };
  } catch {
    return { accepted: false, reason: "invalid_catalog" };
  }
}

export function prepareCodexBody(raw) {
  let b;
  try { b = typeof raw === "string" ? JSON.parse(raw) : structuredClone(raw); }
  catch { throw new Error("Cannot decode Responses request body"); }
  if (!b || typeof b !== "object" || Array.isArray(b))
    throw new Error("Responses request body is not an object");
  for (const key of [
    "max_output_tokens", "max_completion_tokens", "temperature", "top_p",
    "previous_response_id", "user", "safety_identifier", "prompt_cache_options",
  ]) delete b[key];
  if (!["priority", "ultrafast"].includes(b.service_tier)) delete b.service_tier;
  if (typeof b.input === "string")
    b.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: b.input }] }];
  if (!Array.isArray(b.input)) b.input = [];
  b.input = b.input.filter((item) => item?.type !== "item_reference").map((item) => {
    if (!item || typeof item !== "object") return item;
    const copy = { ...item };
    delete copy.id;
    if (["message", "reasoning"].includes(copy.type)) delete copy.status;
    if (copy.role === "system") copy.role = "developer";
    return copy;
  });
  const own = typeof b.instructions === "string" ? b.instructions.trim() : "";
  const standard = modelPrompts.get(b.model);
  if (standard && own && standard !== own) {
    b.input.unshift({
      type: "message", role: "developer",
      content: [{ type: "input_text", text: own }],
    });
    b.instructions = standard;
  } else if (standard) b.instructions = standard;
  b.store = false;
  b.stream = true;
  b.tool_choice = "auto";
  if (b.parallel_tool_calls === undefined) b.parallel_tool_calls = true;
  if (!b.text) b.text = { verbosity: "medium" };
  if (b.reasoning?.effort === "ultra") b.reasoning.effort = "max";
  if (b.reasoning?.effort !== "none") {
    if (b.reasoning && !b.reasoning.summary) b.reasoning.summary = "auto";
    if (!Array.isArray(b.include)) b.include = [];
    if (!b.include.includes("reasoning.encrypted_content"))
      b.include.push("reasoning.encrypted_content");
  }
  return JSON.stringify(b);
}

export async function renewAccount(account, {
  authenticate = loginHTTPAccount, verify = verifyAccessToken, save = upsertPool, proxy = "",
} = {}) {
  const prior = pendingAuth.get(account.email);
  if (prior) return prior;
  // DSH HTTP login uses isolated workers; serialize renewals to avoid a surge
  // of simultaneous reauthorization attempts.
  const task = authQueue.then(async () => {
    // Same standalone DSH HTTP path for initial login and token expiry/401.
    // No browser/GUI popup is started by automatic reauthentication.
    const { tokens } = await authenticate(account, proxy ? { proxy } : undefined);
    const verified = await verify(tokens.access, { expectedEmail: account.email });
    if (!verified.accepted)
      throw new Error("HTTP 登录返回的 Platform Token 不能用于当前 Magpie 模型接口");
    const record = { ...account, accessToken: tokens.access };
    await save(record);
    return record;
  });
  authQueue = task.catch(() => {});
  pendingAuth.set(account.email, task);
  try { return await task; }
  finally { pendingAuth.delete(account.email); }
}

async function candidate(account, { reauthenticate = renewAccount } = {}) {
  if (accessTokenState(account.accessToken).state === "unexpired_unverified")
    return account;
  return reauthenticate(account);
}

function orderAccountsForSlot(accounts, preferredSlot = "", rotate = false) {
  if (!Array.isArray(accounts) || !accounts.length) return [];
  if (typeof preferredSlot === "string" && preferredSlot) {
    const hit = accounts.findIndex((a) => typeof a?.email === "string" && accountSlotTag(a.email) === preferredSlot);
    if (hit >= 0) {
      const primary = accounts[hit];
      const others = accounts.filter((_, i) => i !== hit);
      if (rotate && others.length > 1) {
        const start = nextIndex++ % others.length;
        return [primary, ...others.slice(start), ...others.slice(0, start)];
      }
      return [primary, ...others];
    }
  }
  if (!rotate) return accounts.slice();
  const start = nextIndex++ % accounts.length;
  return [...accounts.slice(start), ...accounts.slice(0, start)];
}

/**
 * 选号：额度加权轮转 + 熔断降级。
 *
 * 上游只有「轮流」和「把额度为 0 的排到最后」两件事，问题在于额度为 0 之外的
 * 号也未必能用：失败不改额度，快照上挂着 25 的号可能已经彻底打不通，于是每次
 * 请求都按顺序挨个打过去，每个耗 5-10 秒才失败，把客户端拖到 59 秒超时。
 *
 * 这里做三件事：
 *  1. 熔断：连续失败到阈值（见 pool-stats 的 FAIL_COOLDOWN_THRESHOLD）的号进冷却，
 *     和额度耗尽的号一样排到最后，只当兜底。
 *  2. 加权轮转：可用号按「剩余额度 ÷（1 + 2×连续失败）」做 smooth weighted
 *     round-robin，剩得多的多承担、剩得少的少承担，额度相同就是纯平均。
 *  3. 首选软化：magpie 传来的 preferredSlot 仍然优先，但它额度明显低于别人时
 *     让位给加权顺序，否则首选号会被一直薅到空。
 */
const PREFERRED_MIN_RATIO = 0.5;
const rotationCredit = new Map();
// 文本链路单独一份轮转账本：文本请求不该吃掉图片按剩余额度分配的权重。
const textRotationCredit = new Map();

/** 这些错误码是请求本身的错（提示词被拒、图片格式不对），不该影响账号健康。 */
const REQUEST_FAULT_CODES = new Set(["content_policy_violation", "invalid_image", "upstream_bad_request"]);

function accountWeight(account, stats) {
  const tag = typeof account?.email === "string" ? accountSlotTag(account.email) : "";
  const rec = tag ? stats?.accounts?.[tag] : null;
  const quota = rec ? rec.imageQuota : null;
  const base = typeof quota === "number" && quota > 0 ? quota : quota === 0 ? 0.05 : 1;
  // 用「连续失败」而不是历史总失败数来降权：一次成功就清零，不会把曾经失手过的
  // 号永久压在队尾。另外，「一次都没成功过、却失败过很多次」的号（额度快照还挂
  // 着旧值的那种）从一开始就降权，不必等它再失败三次才进冷却。
  const neverWorked = (rec?.successCalls || 0) === 0 && (rec?.failCalls || 0) >= 5;
  const streak = (rec?.consecutiveFails || 0) + (neverWorked ? 2 : 0);
  return Math.max(0.05, base / (1 + 2 * streak));
}

function weightedOrder(accounts, stats, credit = rotationCredit) {
  if (accounts.length < 2) return accounts.slice();
  const weights = accounts.map((a) => accountWeight(a, stats));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) return accounts.slice();
  if (credit.size > 512) credit.clear();
  const credits = accounts.map((acc, i) => {
    const tag = accountSlotTag(acc.email);
    const next = (credit.get(tag) || 0) + weights[i];
    credit.set(tag, next);
    return next;
  });
  const order = accounts.map((_, i) => i).sort((a, b) => credits[b] - credits[a]);
  // smooth WRR：只给被选中的那个扣掉总权重，其余累计到下一轮，跨请求就能按权重分。
  const first = order[0];
  credit.set(accountSlotTag(accounts[first].email), credits[first] - total);
  return order.map((i) => accounts[i]);
}

function movePreferredFirst(list, preferredSlot, stats) {
  if (!preferredSlot) return list;
  const hit = list.findIndex((a) => typeof a?.email === "string" && accountSlotTag(a.email) === preferredSlot);
  if (hit <= 0) return list;
  const primary = list[hit];
  if (stats) {
    const maxWeight = Math.max(...list.map((a) => accountWeight(a, stats)));
    if (accountWeight(primary, stats) < maxWeight * PREFERRED_MIN_RATIO) return list;
  }
  return [primary, ...list.slice(0, hit), ...list.slice(hit + 1)];
}

export function selectPoolOrder({
  accounts,
  preferredSlot = "",
  stats = null,
  rotate = true,
  nowMs = Date.now(),
  // 轮转账本。图片和文本各用一份，否则文本请求会吃掉图片的轮转权重，
  // 把「按剩余额度分配」算歪。
  credit = rotationCredit,
} = {}) {
  if (!Array.isArray(accounts) || !accounts.length) return [];
  const usable = [];
  const blocked = [];
  const dead = [];
  for (const account of accounts) {
    const email = account?.email;
    if (isAccountDead(email, stats, { nowMs })) {
      dead.push(account);
      continue;
    }
    const down = isAccountRateLimited(email, stats, { nowMs }) ||
      isAccountCoolingDown(email, stats, { nowMs });
    (down ? blocked : usable).push(account);
  }

  const ordered = rotate
    ? movePreferredFirst(weightedOrder(usable, stats, credit), preferredSlot, stats)
    : movePreferredFirst(usable.slice(), preferredSlot, null);
  // 兜底队列里首选号仍然排第一，但它只在可用号全部失败时才会被用到；判死的号
  // 排在最后面，只有池子里一个能用的都没有时才会被撞上。
  return [
    ...ordered,
    ...movePreferredFirst(blocked.slice(), preferredSlot, null),
    ...dead,
  ];
}

/**
 * 文本链路可用的账号。
 *
 * 只排除「重新登录都过不去」的号（`auth` / `marked`）—— 这类号文本也一样废。
 * 图片的熔断、额度耗尽、甚至「从没出过图」（`never`）都不适用于文本：文本和
 * 生图是两条独立的上游能力，一个号出不了图不代表它答不了话。
 */
export function textPoolAccounts(accounts, stats) {
  if (!Array.isArray(accounts) || !accounts.length) return [];
  if (!stats?.accounts) return accounts;
  const kept = accounts.filter((account) => {
    const why = accountDeadReason(account?.email, stats);
    return why !== "auth" && why !== "marked";
  });
  // 全被判死了就退回原列表：宁可试一下，也别直接报"没有可用账号"。
  return kept.length ? kept : accounts;
}

/**
 * 额度归零的号，等上游重置时间过了就该复检一次。
 *
 * 不这么做的后果：本地额度只会在"成功 -1"时减少，打到 0 之后就永远挂着 0，
 * 上游 24 小时重置了也没人知道，得人工点一次「检测额度」才回到队列 —— 号池会
 * 越用越少。这里只挑 **token 还有效** 的号，探测时禁用重新登录，绝不触发 MFA。
 */
const lastQuotaProbe = new Map();
const QUIET_PROBE_GAP_MS = 10 * 60 * 1000;
const QUIET_PROBE_MAX_ENTRIES = 512;

export function accountsNeedingQuotaRefresh(accounts, stats, {
  nowMs = Date.now(),
  limit = 1,
  probeGapMs = QUIET_PROBE_GAP_MS,
  probedAt = lastQuotaProbe,
} = {}) {
  if (!Array.isArray(accounts) || !accounts.length || !stats?.accounts) return [];
  const picked = [];
  for (const account of accounts) {
    if (picked.length >= limit) break;
    const email = account?.email;
    if (typeof email !== "string") continue;
    // token 已经过期的号要重新登录才能问额度，那就不是"顺手"了，交给人工。
    if (accessTokenState(account.accessToken).state !== "unexpired_unverified") continue;
    const entry = stats.accounts[accountSlotTag(email)];
    if (!entry) continue;
    if (entry.imageQuota !== 0) continue;
    if (isAccountDead(email, stats, { nowMs })) continue;
    if (nowMs - (probedAt.get(email) || 0) < probeGapMs) continue;
    const resetMs = Date.parse(entry.limitedUntil || entry.restoreAt || "");
    // 重置时间还没到就别浪费一次请求；不知道重置时间（本地刚把额度打到 0）就探一次问清楚。
    if (Number.isFinite(resetMs) && resetMs > nowMs) continue;
    // 重置时间过后已经查过一次、结果还是查不出额度（典型是 token 被上游 401）：
    // 别每十分钟再问一遍，等人工重新导入凭据、或者下一个重置周期。
    const checkedMs = Date.parse(entry.quotaCheckedAt || "");
    if (entry.quotaError && Number.isFinite(checkedMs) &&
        Number.isFinite(resetMs) && checkedMs >= resetMs) continue;
    picked.push(account);
  }
  return picked;
}

/**
 * 后台复检：串行、只探不登录、失败静默。调用方一般直接丢掉返回值。
 */
export async function refreshExpiredQuotas(accounts, stats, {
  nowMs = Date.now(),
  limit = 1,
  probe = probeAccountImageQuota,
  probeGapMs = QUIET_PROBE_GAP_MS,
  probedAt = lastQuotaProbe,
  ...probeOpts
} = {}) {
  const picked = accountsNeedingQuotaRefresh(accounts, stats, { nowMs, limit, probeGapMs, probedAt });
  if (!picked.length) return [];
  if (probedAt.size > QUIET_PROBE_MAX_ENTRIES) probedAt.clear();
  const results = [];
  for (const account of picked) {
    probedAt.set(account.email, nowMs);
    try {
      results.push(await probe(account, { ...probeOpts, reauthenticate: null, silent: true }));
    } catch {
      // 后台复检失败就算了，十分钟后再试
    }
  }
  return results;
}

function mergeDiscoveredModels(models, token) {
  return {
    ...(isWebOnlyToken(token) ? buildWebTextModelCatalog(CODEX_BASE) : {}),
    ...(models || {}),
    ...buildImageModelCatalog(CODEX_BASE),
  };
}

export async function discoverPoolModels({
  read = listPool, fetcher = fetch, reauthenticate = renewAccount, preferredSlot = "",
} = {}) {
  const accounts = orderAccountsForSlot(await read(), preferredSlot, false);
  if (!accounts.length) return {};
  let fallbackWebOnly = false;
  for (const account of accounts) {
    if (accessTokenState(account.accessToken).state !== "unexpired_unverified")
      continue;
    const probe = await verifyAccessToken(account.accessToken, { fetcher });
    if (probe.accepted) return mergeDiscoveredModels(probe.models, account.accessToken);
    if (isWebOnlyToken(account.accessToken) && probe.status !== 401) {
      fallbackWebOnly = true;
    }
  }
  for (const account of accounts) {
    try {
      if (reauthenticate === renewAccount) {
        let models = null;
        let acceptedToken = "";
        await renewAccount(account, {
          verify: async (token, opts) => {
            const res = await verifyAccessToken(token, { ...opts, fetcher });
            if (res.accepted) {
              models = res.models;
              acceptedToken = token;
            }
            return res;
          },
        });
        if (models) return mergeDiscoveredModels(models, acceptedToken);
      } else {
        const renewed = await reauthenticate(account);
        if (renewed?.accessToken) {
          const probe = await verifyAccessToken(renewed.accessToken, { fetcher });
          if (probe.accepted) return mergeDiscoveredModels(probe.models, renewed.accessToken);
          if (isWebOnlyToken(renewed.accessToken) && probe.status !== 401) {
            fallbackWebOnly = true;
          }
        }
      }
    } catch {
      // Try the next pooled account before giving up on discovery.
    }
  }
  if (fallbackWebOnly) {
    return { ...buildWebTextModelCatalog(CODEX_BASE), ...buildImageModelCatalog(CODEX_BASE) };
  }
  return {};
}

function friendlyRefreshReason(err) {
  const message = String(err?.message || "");
  const known = /DSH HTTP|Platform Token|没有返回可用|未找到可用 Python|HTTP 登录|认证后端|不能用于当前 Magpie/.test(message);
  return known ? sanitizeStatsMessage(message, 180) :
    "检测或刷新授权失败；请检查账号、TOTP、网络或代理";
}

function friendlyQuotaError(res) {
  const status = Number(res?.http_status || 502);
  const code = String(res?.error_code || "");
  if (status === 401 || code === "unauthorized") {
    return "网页鉴权 401（Token 无 chatgpt.com 网页权限或已失效）";
  }
  if (status === 403 || code === "forbidden") {
    return "Cloudflare / 网页端拒绝访问 (403)，请尝试配置或更换代理";
  }
  if (status === 504 || code === "worker_timeout" || code === "timeout") {
    return "查询生图额度超时，请检查网络或 HTTP(S) 代理";
  }
  if (code === "dependencies_missing" || code === "worker_start_failed") {
    return "Python 生图 Worker 环境不可用";
  }
  return sanitizeStatsMessage(res?.error) || "查询生图额度失败，请检查网络或代理";
}

export async function probeAccountImageQuota(account, {
  proxy = "",
  timezoneOffsetMin = -480,
  runWorker,
  reauthenticate = renewAccount,
  statsFile,
  statsStore,
  signal,
  // 后台顺手复检用：失败不写 quotaError，免得把一个好好的号显示成"查询失败"。
  silent = false,
} = {}) {
  const targetStats = {
    ...(statsFile !== undefined ? { statsFile } : {}),
    ...(statsStore !== undefined ? { statsStore } : {}),
  };
  if (!account || typeof account.email !== "string" || !account.email.includes("@")) {
    return {
      ok: false,
      imageQuota: null,
      restoreAt: null,
      hasImageLimit: null,
      planType: null,
      rateLimited: false,
      error: "账号记录无效",
      httpStatus: 400,
      errorCode: "invalid_account",
      renewed: false,
      account,
    };
  }

  let current = account;
  let renewed = false;
  if (accessTokenState(current?.accessToken).state !== "unexpired_unverified") {
    if (typeof reauthenticate === "function") {
      try {
        current = await reauthenticate(current, { proxy });
        renewed = true;
      } catch (err) {
        const msg = friendlyRefreshReason(err);
        if (!silent) await recordQuotaCheck({ email: account.email, error: msg }, targetStats);
        return {
          ok: false,
          imageQuota: null,
          restoreAt: null,
          hasImageLimit: null,
          planType: null,
          rateLimited: false,
          error: msg,
          httpStatus: 401,
          errorCode: "unauthorized",
          renewed: false,
          account,
        };
      }
    } else {
      const msg = "Token 已过期或缺失，需要重新授权";
      // 这条不是"网络抖动"，是账号状态本身，后台复检也要记下来 —— 否则界面上
      // 看不出这个号需要重新导入。
      await recordQuotaCheck({ email: account.email, error: msg }, targetStats);
      return {
        ok: false,
        imageQuota: null,
        restoreAt: null,
        hasImageLimit: null,
        planType: null,
        rateLimited: false,
        error: msg,
        httpStatus: 401,
        errorCode: "unauthorized",
        renewed: false,
        account,
      };
    }
  }

  let res = await checkWebImageQuota({
    accessToken: current.accessToken,
    proxy,
    timezoneOffsetMin,
    signal,
    ...(runWorker ? { runWorker } : {}),
  });

  if (res?.ok !== true && Number(res?.http_status) === 401 && typeof reauthenticate === "function") {
    try {
      const updated = await reauthenticate(current, { proxy });
      if (updated?.accessToken) {
        current = updated;
        renewed = true;
        res = await checkWebImageQuota({
          accessToken: current.accessToken,
          proxy,
          timezoneOffsetMin,
          signal,
          ...(runWorker ? { runWorker } : {}),
        });
      }
    } catch (err) {
      const msg = friendlyRefreshReason(err);
      if (!silent) await recordQuotaCheck({ email: account.email, error: msg }, targetStats);
      return {
        ok: false,
        imageQuota: null,
        restoreAt: null,
        hasImageLimit: null,
        planType: null,
        rateLimited: false,
        error: msg,
        httpStatus: 401,
        errorCode: "unauthorized",
        renewed,
        account: current,
      };
    }
  }

  if (res?.ok === true) {
    const imageQuota = Math.max(0, Math.trunc(Number(res.quota ?? 0) || 0));
    const restoreAt = res.restore_at || null;
    const hasImageLimit = typeof res.has_image_limit === "boolean" ? res.has_image_limit : null;
    const planType = res.plan_type || null;
    await recordQuotaCheck({
      email: account.email,
      quota: imageQuota,
      restoreAt,
      hasImageLimit,
      planType,
    }, targetStats);
    return {
      ok: true,
      imageQuota,
      restoreAt,
      hasImageLimit,
      planType,
      rateLimited: imageQuota === 0,
      error: null,
      httpStatus: 200,
      errorCode: "",
      renewed,
      account: current,
    };
  }

  if (Number(res?.http_status) === 429 || res?.error_code === "rate_limited") {
    const updatedStats = await recordQuotaCheck({
      email: account.email,
      rateLimited: true,
      retryAfter: res?.retry_after ?? null,
      restoreAt: res?.restore_at ?? null,
    }, targetStats);
    const slotRec = updatedStats?.accounts?.[accountSlotTag(account.email)];
    return {
      ok: true,
      imageQuota: 0,
      restoreAt: slotRec?.limitedUntil || slotRec?.restoreAt || res?.restore_at || null,
      hasImageLimit: true,
      planType: slotRec?.planType || null,
      rateLimited: true,
      error: null,
      httpStatus: 429,
      errorCode: "rate_limited",
      renewed,
      account: current,
    };
  }

  const errMsg = friendlyQuotaError(res);
  // 401 说明这个 token 已经不能用了，是要人工重新导入的状态，后台复检也要记；
  // 超时 / worker 起不来这类抖动静默跳过，下一轮再试。
  const authFailure = Number(res?.http_status) === 401 ||
    String(res?.error_code || "").includes("unauthorized");
  if (!silent || authFailure) {
    await recordQuotaCheck({ email: account.email, error: errMsg }, targetStats);
  }
  return {
    ok: false,
    imageQuota: null,
    restoreAt: null,
    hasImageLimit: null,
    planType: null,
    rateLimited: false,
    error: errMsg,
    httpStatus: Number(res?.http_status || 502),
    errorCode: String(res?.error_code || "quota_check_failed"),
    renewed,
    account: current,
  };
}

export async function refreshPoolAccount(account, {
  fetcher = fetch, verify = verifyAccessToken, reauthenticate = renewAccount,
  proxy = "", forceRenew = false,
  includeQuota = false, quotaOnly = false, timezoneOffsetMin = -480,
  runWorker, statsFile, statsStore, signal,
} = {}) {
  if (!account || typeof account.email !== "string")
    return { ok: false, status: "failed", renewed: false, reason: "账号记录无效" };

  if (!includeQuota && !quotaOnly) {
    try {
      if (!forceRenew && accessTokenState(account.accessToken).state === "unexpired_unverified") {
        const probe = await verify(account.accessToken, { fetcher, expectedEmail: account.email });
        if (probe.accepted) {
          return {
            ok: true,
            status: "valid",
            renewed: false,
            tokenState: "unexpired_unverified",
            modelCount: Object.keys(probe.models || {}).length,
          };
        }
      }
      const updated = await reauthenticate(account, { proxy });
      return {
        ok: true,
        status: "renewed",
        renewed: true,
        tokenState: accessTokenState(updated?.accessToken || "").state,
      };
    } catch (err) {
      return { ok: false, status: "failed", renewed: false, reason: friendlyRefreshReason(err) };
    }
  }

  const resolvedStats = (statsFile !== undefined || statsStore !== undefined)
    ? {
        ...(statsFile !== undefined ? { statsFile } : {}),
        ...(statsStore !== undefined ? { statsStore } : {}),
      }
    : (verify === verifyAccessToken && reauthenticate === renewAccount
      ? { statsFile: defaultStatsFile() }
      : { statsFile: null });

  if (quotaOnly) {
    let targetAccount = account;
    let forcedRenew = false;
    try {
      if (forceRenew && typeof reauthenticate === "function") {
        targetAccount = await reauthenticate(account, { proxy });
        forcedRenew = true;
      }
      const quotaProbe = await probeAccountImageQuota(targetAccount, {
        proxy,
        timezoneOffsetMin,
        runWorker,
        reauthenticate,
        ...resolvedStats,
        signal,
      });
      const wasRenewed = forcedRenew || quotaProbe.renewed;
      const tokenState = accessTokenState(quotaProbe.account?.accessToken || targetAccount?.accessToken || "").state;
      if (quotaProbe.ok) {
        return {
          ok: true,
          status: wasRenewed ? "renewed" : "valid",
          renewed: wasRenewed,
          tokenState,
          quotaOk: true,
          imageQuota: quotaProbe.imageQuota,
          quotaResetAt: quotaProbe.restoreAt,
          hasImageLimit: quotaProbe.hasImageLimit,
          planType: quotaProbe.planType,
          quotaError: null,
        };
      }
      return {
        ok: false,
        status: "failed",
        renewed: wasRenewed,
        tokenState,
        reason: quotaProbe.error || "生图额度查询失败",
        quotaOk: false,
        imageQuota: null,
        quotaResetAt: null,
        hasImageLimit: null,
        planType: null,
        quotaError: quotaProbe.error || "生图额度查询失败",
      };
    } catch (err) {
      return {
        ok: false,
        status: "failed",
        renewed: false,
        reason: friendlyRefreshReason(err),
        quotaOk: false,
        quotaError: friendlyRefreshReason(err),
      };
    }
  }

  let baseResult;
  let currentAccount = account;
  try {
    let acceptedLive = false;
    if (!forceRenew && accessTokenState(account.accessToken).state === "unexpired_unverified") {
      const probe = await verify(account.accessToken, { fetcher, expectedEmail: account.email });
      if (probe.accepted) {
        acceptedLive = true;
        baseResult = {
          ok: true,
          status: "valid",
          renewed: false,
          tokenState: "unexpired_unverified",
          modelCount: Object.keys(probe.models || {}).length,
        };
      }
    }
    if (!acceptedLive) {
      currentAccount = await reauthenticate(account, { proxy });
      baseResult = {
        ok: true,
        status: "renewed",
        renewed: true,
        tokenState: accessTokenState(currentAccount?.accessToken || "").state,
      };
    }
  } catch (err) {
    return { ok: false, status: "failed", renewed: false, reason: friendlyRefreshReason(err) };
  }

  const quotaProbe = await probeAccountImageQuota(currentAccount, {
    proxy,
    timezoneOffsetMin,
    runWorker,
    reauthenticate,
    ...resolvedStats,
    signal,
  });
  return {
    ...baseResult,
    renewed: Boolean(baseResult.renewed || quotaProbe.renewed),
    status: quotaProbe.renewed ? "renewed" : baseResult.status,
    tokenState: accessTokenState(quotaProbe.account?.accessToken || currentAccount?.accessToken || "").state,
    quotaOk: quotaProbe.ok,
    imageQuota: quotaProbe.imageQuota,
    quotaResetAt: quotaProbe.restoreAt,
    hasImageLimit: quotaProbe.hasImageLimit,
    planType: quotaProbe.planType,
    quotaError: quotaProbe.error || null,
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handleChatProbe(rawBody, init, ctx) {
  let model = "";
  try {
    const text = rawBody instanceof Uint8Array ? Buffer.from(rawBody).toString("utf8") :
      rawBody instanceof ArrayBuffer ? Buffer.from(rawBody).toString("utf8") :
      String(rawBody || "");
    const parsed = text ? JSON.parse(text) : {};
    model = String(parsed?.model || "").trim();
  } catch {}
  if (isImageModelId(model)) {
    return bridgeChatToImage(rawBody, init, ctx);
  }
  return jsonResponse({
    error: {
      message: "Codex models on this provider require /v1/responses instead of /v1/chat/completions.",
      type: "invalid_request_error",
    },
  }, 400);
}

export async function poolFetch(input, init, {
  read = listPool, fetcher = fetch, reauthenticate = renewAccount, preferredSlot = "",
  runWorker, webTextRunner, proxy = "", statsFile, statsStore,
} = {}) {
  let dest;
  try { dest = new URL(String(input)); }
  catch { throw new Error("Invalid Magpie request URL"); }
  if (dest.origin !== "https://chatgpt.com" || dest.username || dest.password || dest.hash)
    throw new Error("GPTFree plugin only forwards Codex /responses and /images endpoints");

  if (dest.pathname === "/backend-api/codex/chat/completions") {
    // 本地补丁：图片模型转走 /images/generations 或 /images/edits（见 lib/chat-image-bridge.mjs）
    return handleChatProbe(init?.body, init, {
      forward: (endpoint, body) => poolFetch(
        new URL("/backend-api/codex" + endpoint, "https://chatgpt.com"),
        {
          method: "POST",
          body,
          headers: new Headers({ "content-type": "application/json" }),
          signal: init?.signal,
        },
        { read, fetcher, reauthenticate, preferredSlot, runWorker, webTextRunner, proxy, statsFile, statsStore },
      ),
    });
  }

  if (dest.pathname === "/backend-api/codex/images/generations" ||
      dest.pathname === "/backend-api/codex/images/edits") {
    let parsedReq;
    try {
      parsedReq = await parseImageRequest(dest.pathname, init?.body, init?.headers);
    } catch (err) {
      if (err instanceof ImageHttpError) {
        return jsonResponse({
          error: {
            message: err.message,
            type: "invalid_request_error",
            ...(err.code ? { code: err.code } : {}),
          },
        }, err.status);
      }
      return jsonResponse({ error: { message: "Invalid image request", type: "invalid_request_error" } }, 400);
    }

    const accounts = await read();
    if (!accounts.length) {
      return jsonResponse({ error: { message: "GPTFree pool is empty; import accounts first" } }, 503);
    }

    const resolvedStats = (statsFile !== undefined || statsStore !== undefined)
      ? {
          ...(statsFile !== undefined ? { statsFile } : {}),
          ...(statsStore !== undefined ? { statsStore } : {}),
        }
      : (read === listPool ? { statsFile: defaultStatsFile() } : { statsFile: null });

    const stats = await readPoolStats(resolvedStats).catch(() => null);
    // 额度加权轮转 + 熔断（见 selectPoolOrder）。额度耗尽和冷却中的号排到最后兜底。
    const ordered = selectPoolOrder({ accounts, preferredSlot, stats, rotate: true });

    // 顺手把「额度打到 0、重置时间已过」的号复检一下：不登录、不阻塞本次请求。
    // 池子会因此自己长回来，不用人工一个个点「检测额度」。
    if (stats) {
      void refreshExpiredQuotas(accounts, stats, { proxy, ...resolvedStats }).catch(() => {});
    }

    try {
      const result = await executeWebImageGeneration({
        accounts: ordered,
        request: parsedReq,
        signal: init?.signal,
        reauthenticate,
        ...(runWorker ? { runWorker } : {}),
        proxy,
        onAccountResult: (evt) => {
          if (!resolvedStats.statsStore && !resolvedStats.statsFile) return;
          const code = String(evt.errorCode || "");
          return recordImageCall({
            email: evt.account?.email,
            success: evt.success === true,
            count: evt.count || 1,
            rateLimited: evt.rateLimited === true,
            retryAfter: evt.retryAfter ?? null,
            error: code,
            // 提示词被拒/图片格式不对是请求的错，不该记到账号头上。
            accountFault: !REQUEST_FAULT_CODES.has(code),
            // 重新登录都过不去，是最硬的失效信号。
            authFault: code === "unauthorized",
          }, resolvedStats);
        },
      });
      return jsonResponse(result, 200);
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      if (err instanceof ImageHttpError) {
        return jsonResponse({
          error: {
            message: err.message,
            type: err.status === 400 ? "invalid_request_error" : "server_error",
            ...(err.code ? { code: err.code } : {}),
          },
        }, err.status);
      }
      return jsonResponse({ error: { message: "Image generation failed", type: "server_error" } }, 503);
    }
  }

  if (dest.pathname !== "/backend-api/codex/responses")
    throw new Error("GPTFree plugin only forwards Codex /responses and /images endpoints");
  let rawParsed;
  try {
    rawParsed = JSON.parse(String(init?.body || "{}"));
    if (!rawParsed || typeof rawParsed !== "object" || Array.isArray(rawParsed)) {
      throw new Error("invalid body");
    }
  } catch {
    return new Response('{"error":{"message":"Invalid Responses request"}}', {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
  const accounts = await read();
  if (!accounts.length) return new Response('{"error":{"message":"GPTFree pool is empty; import accounts first"}}', {
    status: 503, headers: { "content-type": "application/json" },
  });
  // 文本走同一套轮转，但只排除「重新登录都过不去」的号（auth / marked）：
  // 图片打不通不代表文本不行 —— 一个生图被限流、甚至从没成功出过图的号，文本
  // 往往还是好的。所以这里不把图片的熔断状态套到文本上，也不按图片额度加权。
  const textStatsTarget = (statsFile !== undefined || statsStore !== undefined)
    ? {
        ...(statsFile !== undefined ? { statsFile } : {}),
        ...(statsStore !== undefined ? { statsStore } : {}),
      }
    : (read === listPool ? { statsFile: defaultStatsFile() } : { statsFile: null });
  const textStats = await readPoolStats(textStatsTarget).catch(() => null);
  // 文本也要记账，否则统计页只看得见生图流量。这里只写文本自己的计数，
  // 不碰额度/熔断/判死 —— 那三个是生图的概念。
  const recordText = (account, outcome = {}) => {
    void recordTextCall({
      email: account?.email || "",
      success: outcome.ok === true,
      error: outcome.ok === true ? "" : (outcome.code || ""),
    }, textStatsTarget).catch(() => {});
  };
  const textPool = textPoolAccounts(accounts, textStats);
  const ordered = selectPoolOrder({
    accounts: textPool,
    preferredSlot,
    rotate: true,
    credit: textRotationCredit,
  });
  const webTextAccounts = ordered.filter((a) => isWebOnlyToken(a?.accessToken));

  if (typeof webTextRunner === "function") {
    return executeWebTextGeneration(
      init?.body,
      webTextAccounts.length ? webTextAccounts : ordered,
      { reauthenticate, signal: init?.signal, worker: webTextRunner, proxy, onAttempt: recordText },
    );
  }

  const codexAccounts = ordered.filter((a) => !isWebOnlyToken(a?.accessToken));
  if (!codexAccounts.length) {
    return executeWebTextGeneration(init?.body, ordered, {
      reauthenticate,
      signal: init?.signal,
      proxy,
    });
  }

  let body;
  try { body = prepareCodexBody(init?.body); }
  catch { return new Response('{"error":{"message":"Invalid Responses request"}}', { status: 400, headers: { "content-type": "application/json" } }); }

  for (let idx = 0; idx < codexAccounts.length; idx++) {
    const original = codexAccounts[idx];
    let account;
    try { account = await candidate(original, { reauthenticate }); }
    catch { continue; }
    if (isWebOnlyToken(account.accessToken)) {
      return executeWebTextGeneration(
        init?.body,
        [account, ...codexAccounts.slice(idx + 1), ...webTextAccounts],
        { reauthenticate, signal: init?.signal, proxy, onAttempt: recordText },
      );
    }
    // 这个号两轮都没成，记账时要知道是哪种失败：401 是登录失效，429 是限流，
    // 5xx 是上游抖动，网络异常没有状态码。
    let failCode = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = upstreamHeaders(account.accessToken, getAccountID(account.accessToken), true);
      const key = rawParsed?.prompt_cache_key;
      if (typeof key === "string" && key.length < 256) {
        headers.set("session-id", key);
        headers.set("thread-id", key);
      }
      let r;
      try {
        r = await fetcher(CODEX_BASE + "/responses", {
          method: "POST", body, headers, redirect: "error", signal: init?.signal,
        });
      } catch { failCode = "upstream_error"; break; }
      if (r.ok) { recordText(account, { ok: true }); return r; }
      failCode = r.status === 401 ? "unauthorized"
        : r.status === 429 ? "rate_limited"
        : "upstream_error";
      if (r.status === 401 && attempt === 0) {
        try {
          account = await reauthenticate(account);
          if (isWebOnlyToken(account.accessToken)) {
            return executeWebTextGeneration(
              init?.body,
              [account, ...codexAccounts.slice(idx + 1), ...webTextAccounts],
              { reauthenticate, signal: init?.signal, proxy, onAttempt: recordText },
            );
          }
          continue;
        }
        catch { failCode = "reauth_failed"; break; }
      }
      if (![401, 429, 500, 502, 503, 504].includes(r.status)) {
        // 4xx 里除了 401/429 都是请求本身的问题（提示词、参数），不算账号的错，
        // 所以不记账，免得把好号的成功率拖下去。
        return r;
      }
      break;
    }
    recordText(account, { ok: false, code: failCode || "upstream_error" });
  }
  if (webTextAccounts.length) {
    return executeWebTextGeneration(init?.body, webTextAccounts, {
      reauthenticate,
      signal: init?.signal,
      proxy,
    });
  }
  return new Response('{"error":{"message":"所有 GPT号池 账号均不可用；请检查后台 HTTP 登录、目标模型授权及账号权限。"}}', {
    status: 503, headers: { "content-type": "application/json" },
  });
}
