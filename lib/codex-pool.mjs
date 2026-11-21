/**
 * Standalone temporary access-token pool for ChatGPT's Codex backend.
 * This does NOT modify Magpie's native Codex accounts, and does not
 * pretend that access-only tokens have a refresh token.
 *
 * An access token is only admitted after OpenAI's own /codex/models endpoint
 * returns a non-empty model list. JWT exp is just a preflight hint.
 */
import { randomBytes } from "node:crypto";
import { accessTokenState } from "./credentials.mjs";
import { accountSlotTag } from "./pool-connection.mjs";
import { listPool, upsertPool } from "./pool-vault.mjs";
import { loginHTTPAccount } from "./dsh-http-auth.mjs";
import { refreshCodexToken } from "./web-oauth.mjs";
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
import { appendImageErrorLog } from "./image-error-log.mjs";
import { batchRankMap } from "./batch-registry.mjs";
import { accountInflight } from "./account-inflight.mjs";
import { accountWeight, deriveTextQuota, poolMedianTtfb } from "./pool-weight.mjs";
import { DEFAULT_POOL_POLICY, readPoolPolicy, resolveImageAttemptTimeout } from "./pool-policy.mjs";
import { noteInflight, recordRequest } from "./request-log.mjs";
import { recordPoolEvent } from "./pool-events.mjs";
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

/**
 * 判断 refresh_token 是不是**真的废了**，而不是这次网络不顺。
 *
 * 只有上游明确回 invalid_grant（token 被吊销/过期/已被轮换掉）才算废。其余情况
 * —— 超时、连不上、代理报错、5xx —— 都当作临时故障，抛出去让上层重试，
 * 绝不能顺手把账号降级成「需要人工重新授权」。
 */
function isRefreshTokenDead(err) {
  if (!err) return false;
  if (err.oauthError === "invalid_grant") return true;
  // 兼容没有挂 oauthError 的实现：只在 400/401 且文案明确提到 invalid_grant 时才认。
  const status = Number(err.status);
  return (status === 400 || status === 401) &&
    /invalid_grant/i.test(String(err.message || ""));
}

export async function renewAccount(account, {
  authenticate = loginHTTPAccount, verify = verifyAccessToken, save = upsertPool, proxy = "",
  refresh = refreshCodexToken,
} = {}) {
  const prior = pendingAuth.get(account.email);
  if (prior) return prior;
  // 续期统一串行：refresh 和 DSH HTTP 登录都打上游，并发重登只会让上游更容易限流。
  const task = authQueue.then(async () => {
    // 1. refresh_token 优先。一次 HTTPS 就够，不用 Python、不碰密码。
    if (account.refreshToken) {
      try {
        const tok = await refresh({ refreshToken: account.refreshToken, proxy });
        if (!tok?.accessToken) throw new Error("刷新 OAuth 令牌未返回新的 access_token");
        // 必须走 verify，不能省：discoverPoolModels 靠注入的 verify 顺手把模型列表
        // 捞回来（见本文件 discoverPoolModels）。跳过一次验证，模型发现就静默失效。
        // 代价是一次上游请求，仍远低于原来的 Python 重登。
        const verified = await verify(tok.accessToken, { expectedEmail: account.email });
        if (!verified.accepted) {
          const rejected = new Error("刷新得到的 token 未通过模型访问验证");
          rejected.tokenRejected = true;
          throw rejected;
        }
        const record = {
          ...account,
          accessToken: tok.accessToken,
          // 轮换：上游可能下发新的 refresh_token，必须立刻写回，否则下次就失效。
          refreshToken: tok.refreshToken || account.refreshToken,
        };
        await save(record);
        return record;
      } catch (err) {
        // 分三种，处理方式完全不同：
        //   a) refresh_token 本身废了 → 有密码就降级，没有就只能人工重新授权；
        //   b) refresh 成功但 token 干不了活 → 有密码再试密码路径；
        //   c) 网络/上游临时故障 → 直接抛，别拿更贵、更招限流的密码登录去硬撞。
        const dead = isRefreshTokenDead(err);
        if (!dead && !err?.tokenRejected) throw err;
        if (!account.password) {
          if (dead)
            throw new Error("refresh_token 已失效且没有保存密码，需要重新网页授权（reauth_required）");
          throw err;
        }
        // 有密码：落到下面的密码兜底路径，且不把这次失败记成账号失效。
      }
    }

    // 2. 密码兜底（老路径）。Same standalone DSH HTTP path for initial login and
    // token expiry/401. No browser/GUI popup is started by automatic reauthentication.
    if (!account.password)
      throw new Error("该账号没有可用的 refresh_token 或密码，需要重新导入或网页授权（reauth_required）");
    const { tokens } = await authenticate(account, proxy ? { proxy } : undefined);
    const verified = await verify(tokens.access, { expectedEmail: account.email });
    if (!verified.accepted)
      throw new Error("HTTP 登录返回的 Platform Token 不能用于当前 Magpie 模型接口");
    const record = {
      ...account,
      accessToken: tokens.access,
      // 密码登录顺带也会返回 refresh_token（见 dsh-http-auth 的 normalizeWorkerResult）。
      // 以前这里丢掉它，导致每个号每次过期都得再跑一遍 Python —— 现在存下来。
      refreshToken: tokens.refresh || account.refreshToken || "",
    };
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
// `attempt_aborted`：我们主动不等了（另一路已出图 / 整单到预算），不是这个号的错。
const REQUEST_FAULT_CODES = new Set([
  "content_policy_violation", "invalid_image", "upstream_bad_request", "attempt_aborted",
]);

// 权重、分级、批次排名都搬到了 lib/pool-weight.mjs。
// 这里只留调度：分桶、轮转、首选号软化、对冲延迟。

/** 批次新鲜度开关（0.10.1 起的独立 env，没进 policy：它和「分级/画像」不是一类东西）。 */
function batchRecencyEnabled() {
  const raw = String(process.env.MAGPIE_GPTFREE_BATCH_RECENCY ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/**
 * 文本链路的冷却：账本里的 `textLimitedUntil`。
 *
 * 进程内的 Map 在 chatgpt-web-text 里还有一份，那边负责「同一进程内刚被打回 429」；
 * 这里读账本是为了跨重启 —— 宿主每小时热更新一次，只靠内存等于没有冷却。
 */
function textCoolingDown(email, stats, nowMs) {
  const tag = typeof email === "string" ? accountSlotTag(email) : "";
  const until = Date.parse((tag && stats?.accounts?.[tag]?.textLimitedUntil) || "");
  return Number.isFinite(until) && until > nowMs;
}

/**
 * 分桶。**image 和 text 用的是两套判据**，这是刻意的：
 *
 * - image：限流、冷却、四条判死规则全都适用。
 * - text：只有「重新登录都过不去」（auth）和「人工标记」算死。图片的额度耗尽、
 *   冷却、never、stale 都不该把号从文本链路踢掉 —— 画不了图不代表答不了话。
 *   文本自己的信号只有 `textLimitedUntil`（429 冷却）。
 *
 * 这个分桶解决的问题：额度耗尽但有文本额度的号，以前在文本链路上会被当成
 * 「可用但权重 0.05」排到最后，等于白白浪费掉那部分文本额度。
 */
function bucketOf(account, stats, { mode, nowMs }) {
  const email = account?.email;
  if (mode === "text") {
    const why = accountDeadReason(email, stats, { nowMs });
    if (why === "auth" || why === "marked") return "dead";
    return textCoolingDown(email, stats, nowMs) ? "blocked" : "usable";
  }
  if (isAccountDead(email, stats, { nowMs })) return "dead";
  const down = isAccountRateLimited(email, stats, { nowMs }) ||
    isAccountCoolingDown(email, stats, { nowMs });
  return down ? "blocked" : "usable";
}

/** 批次排名表：只有一个批次时不返回（给所有人乘同一个常数对 WRR 比例没有影响）。 */
function batchRanksFor(accounts) {
  if (!batchRecencyEnabled()) return null;
  const ranks = batchRankMap(accounts);
  return ranks.size >= 2 ? ranks : null;
}

function weightOptions(accounts, stats, {
  mode, policy, batchRanks = null, nowMs, inflightOf = null,
}) {
  return {
    mode,
    policy,
    batchRanks,
    // 延迟乘子要一个基准：号池里所有有样本的号的首字节中位数。
    poolMedianTtfbMs: policy.latencyWeightEnabled ? poolMedianTtfb(accounts, stats) : null,
    nowMs,
    // 单号并发闸只作用于生图：文本的并发由 worker 自己控，而且文本请求很轻，
    // 同一时刻两个对话打一个号不会像生图那样把上游打爆。
    // `inflightOf` 可以外部注入（测试用），默认查进程级的全局计数。
    inflightOf: mode === "image"
      ? (inflightOf || ((account) => accountInflight(account?.email)))
      : null,
    perAccountInflight: mode === "image" ? policy.perAccountImageInflight : 0,
  };
}

function weightedOrder(accounts, stats, credit = rotationCredit, options = {}) {
  if (accounts.length < 2) return accounts.slice();
  const weights = accounts.map((a) => accountWeight(a, stats, options));
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

function movePreferredFirst(list, preferredSlot, stats, options = null) {
  if (!preferredSlot) return list;
  const hit = list.findIndex((a) => typeof a?.email === "string" && accountSlotTag(a.email) === preferredSlot);
  if (hit <= 0) return list;
  const primary = list[hit];
  if (stats && options) {
    const maxWeight = Math.max(...list.map((a) => accountWeight(a, stats, options)));
    if (accountWeight(primary, stats, options) < maxWeight * PREFERRED_MIN_RATIO) return list;
  }
  return [primary, ...list.slice(0, hit), ...list.slice(hit + 1)];
}

export function selectPoolOrder({
  accounts,
  preferredSlot = "",
  stats = null,
  rotate = true,
  nowMs = Date.now(),
  // image（默认）| text。两者分桶判据不同，见 bucketOf。
  mode = "image",
  // 调度策略。调用方从 pool-policy 读一次传进来；不传就是默认策略，
  // 而默认策略下的权重和 0.10.x 逐位一致。
  policy = DEFAULT_POOL_POLICY,
  // 轮转账本。图片和文本各用一份，否则文本请求会吃掉图片的轮转权重，
  // 把「按剩余额度分配」算歪。
  credit = rotationCredit,
  // 单号在飞计数的查询函数。默认查进程级全局计数；测试可以注入。
  inflightOf = null,
} = {}) {
  if (!Array.isArray(accounts) || !accounts.length) return [];
  const usable = [];
  const blocked = [];
  const dead = [];
  for (const account of accounts) {
    const bucket = bucketOf(account, stats, { mode, nowMs });
    if (bucket === "dead") dead.push(account);
    else if (bucket === "blocked") blocked.push(account);
    else usable.push(account);
  }

  // 批次排名只算一次：weightedOrder 和 movePreferredFirst 用的是同一份，
  // 否则首选号的门槛判断会和实际权重对不上。
  const batchRanks = rotate ? batchRanksFor(usable) : null;
  const options = weightOptions(usable, stats, { mode, policy, batchRanks, nowMs, inflightOf });

  // 轮转策略只决定「首选号还算不算数」，权重体系（额度/tier/EWMA/延迟/卡死）不动：
  //   quotaFirst / preferred 会 pin 首选号，roundRobin 不 pin（起点靠轮转账本铺开）。
  // preferred 与 quotaFirst 的差别是**要不要过权重门槛**：preferred 无条件第一。
  const rotation = policy?.rotation || DEFAULT_POOL_POLICY.rotation;
  const pinPreferred = rotation.strategy !== "roundRobin" && rotation.respectPreferredSlot !== false;
  const gateStats = rotation.strategy === "preferred" ? null : stats;
  const gateOptions = rotation.strategy === "preferred" ? null : options;

  const weighted = rotate ? weightedOrder(usable, stats, credit, options) : usable.slice();
  const ordered = pinPreferred
    ? movePreferredFirst(weighted, preferredSlot, rotate ? gateStats : null, rotate ? gateOptions : null)
    : weighted;
  // 兜底队列里首选号仍然排第一，但它只在可用号全部失败时才会被用到；判死的号
  // 排在最后面，只有池子里一个能用的都没有时才会被撞上。
  return [
    ...ordered,
    ...movePreferredFirst(blocked.slice(), preferredSlot, null, null),
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
/**
 * 额度快照超过这个时长就当过期。免费号的额度是**每天**重置的，一天不刷新，
 * 按额度加权轮转就会拿着昨天的数字分活 —— 一个今天已经打空的号权重还挂在
 * 20，会被反复派活然后反复超时。6 小时是个折中：一天至少刷到 4 次。
 */
export const STALE_QUOTA_MS = 6 * 60 * 60 * 1000;

export function accountsNeedingQuotaRefresh(accounts, stats, {
  nowMs = Date.now(),
  limit = 1,
  probeGapMs = QUIET_PROBE_GAP_MS,
  probedAt = lastQuotaProbe,
  staleAfterMs = 0,
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
    if (isAccountDead(email, stats, { nowMs })) continue;
    if (nowMs - (probedAt.get(email) || 0) < probeGapMs) continue;

    const exhausted = entry.imageQuota === 0;
    const checkedMs = Date.parse(entry.quotaCheckedAt || "");
    const stale = staleAfterMs > 0 &&
      (!Number.isFinite(checkedMs) || nowMs - checkedMs >= staleAfterMs);
    // 两种要复检的号：额度已经打到 0 的（等上游重置），和快照太旧的。
    if (!exhausted && !stale) continue;

    if (exhausted) {
      const resetMs = Date.parse(entry.limitedUntil || entry.restoreAt || "");
      // 重置时间还没到就别浪费一次请求；不知道重置时间（本地刚把额度打到 0）就探一次问清楚。
      if (Number.isFinite(resetMs) && resetMs > nowMs) continue;
      // 重置时间过后已经查过一次、结果还是查不出额度（典型是 token 被上游 401）：
      // 别每十分钟再问一遍，等人工重新导入凭据、或者下一个重置周期。
      if (entry.quotaError && Number.isFinite(checkedMs) &&
          Number.isFinite(resetMs) && checkedMs >= resetMs) continue;
    }
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
  staleAfterMs = 0,
  ...probeOpts
} = {}) {
  const picked = accountsNeedingQuotaRefresh(accounts, stats, {
    nowMs, limit, probeGapMs, probedAt, staleAfterMs,
  });
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

let sweepTimer = null;
let sweepKickoff = null;

/**
 * 账号状态巡检：定时挑几个「快照过期 / 额度归零且已过重置时间」的号去问一次额度。
 *
 * 为什么需要定时器：复检原来只在「有生图请求进来」时顺手做一次，而且只挑额度为 0
 * 的号。池子闲着的时候快照就一直是旧的，而额度加权轮转完全依赖这份快照 ——
 * 拿着过期的额度分活，等于盲选。定时器每 10 分钟问 2 个号，121 个号一天能轮完
 * 好几遍，成本是每 10 分钟 2 次轻量请求（只查额度，不登录、不触发 MFA）。
 *
 * 参数默认值等于 `DEFAULT_POOL_POLICY.sweep`；生产走 `applySweepPolicy`，
 * 从策略文件读，面板改完立刻重排（见 gui-service 的 /api/policy）。
 */
export function startQuotaSweep({
  intervalMs = 10 * 60 * 1000,
  limit = 2,
  read = listPool,
  proxy = "",
  staleAfterMs = STALE_QUOTA_MS,
} = {}) {
  if (sweepTimer) return sweepTimer;
  const tick = async () => {
    const startedAt = Date.now();
    try {
      const accounts = await read();
      if (!Array.isArray(accounts) || !accounts.length) return;
      const stats = await readPoolStats({ statsFile: defaultStatsFile() }).catch(() => null);
      if (!stats) return;
      const results = await refreshExpiredQuotas(accounts, stats, { limit, proxy, staleAfterMs });
      if (!results.length) return;
      const recovered = results.filter((r) => Number(r?.quota) > 0).length;
      recordPoolEvent("sweep.run", {
        count: results.length,
        limit,
        ms: Date.now() - startedAt,
        ok: true,
        ...(recovered ? { reason: `${recovered} 个号恢复了额度` } : {}),
      });
    } catch (error) {
      // 巡检失败不能影响插件本身，下一跳再试；但要在事件里留一条，别静默。
      recordPoolEvent("sweep.error", {
        ok: false,
        ms: Date.now() - startedAt,
        reason: String(error?.message || error).slice(0, 48),
      });
    }
  };
  sweepTimer = setInterval(tick, Math.max(60_000, intervalMs));
  sweepTimer.unref?.();
  // 启动 30 秒后先跑一次，别让刚重启的宿主空等一个周期。
  sweepKickoff = setTimeout(tick, 30_000);
  sweepKickoff.unref?.();
  return sweepTimer;
}

/**
 * 按策略重排巡检：先停掉旧的，再按新参数起。
 *
 * 只改 interval 时也必须重建 —— setInterval 的周期定死在创建那一刻，
 * 不重建的话面板上改了要等下次进程重启才生效，属于「改了不生效」的典型。
 */
export function applySweepPolicy(policy) {
  const sweep = policy?.sweep || DEFAULT_POOL_POLICY.sweep;
  stopQuotaSweep();
  if (!sweep.enabled) return null;
  return startQuotaSweep({
    intervalMs: sweep.intervalMinutes * 60_000,
    limit: sweep.limit,
    staleAfterMs: sweep.staleAfterMinutes * 60_000,
  });
}

export function stopQuotaSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  if (sweepKickoff) clearTimeout(sweepKickoff);
  sweepTimer = null;
  sweepKickoff = null;
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

/**
 * 对冲（hedging）第二路的起步延迟：按**头号**的可信度决定，而不是拍一个固定值。
 *
 * 线上实测（0.9.0 首测，121 个号）：成功的出图要 39 秒，而池子里有 36 个号
 * 连续失败 ≥2 次、一半的号从没出过图，头号经常是「卡满 40 秒什么都不返回」。
 * 原来的固定 25 秒起步，第二路到预算末尾只跑了 30 秒 —— 比正常出图还短，
 * 于是 `attempted` 永远停在 1，对冲等于摆设。
 *
 * 所以：
 *   - 头号 24 小时内成功过 → 它大概率只是慢，晚点对冲（30 秒），别白烧一个号的额度；
 *   - 头号没验证过 / 久未成功 → 早点对冲（12 秒），把 43 秒留给第二路，让它真能出图；
 *   - **有未验证号要探**（`hasExplore`）→ 一律 12 秒。第二路现在专门去探新号，
 *     必须给它留够一次完整的单次预算（40 秒），否则探索永远是「预算不够」的假失败。
 */
const PROVEN_WINDOW_MS = 24 * 60 * 60 * 1000;

export function hedgeDelayForHead(ordered, stats, {
  nowMs = Date.now(),
  hasExplore = false,
  policy = DEFAULT_POOL_POLICY,
} = {}) {
  // 两个延迟进 policy 是为了「线上对冲太晚/太早」时能改配置，不用发版。
  if (hasExplore) return policy.hedgeUnprovenMs;
  const head = Array.isArray(ordered) ? ordered[0] : null;
  const tag = typeof head?.email === "string" ? accountSlotTag(head.email) : "";
  const rec = tag ? stats?.accounts?.[tag] : null;
  const lastSuccess = rec?.lastSuccessAt ? Date.parse(rec.lastSuccessAt) : NaN;
  const proven = Number.isFinite(lastSuccess) && nowMs - lastSuccess < PROVEN_WINDOW_MS;
  return proven ? policy.hedgeProvenMs : policy.hedgeUnprovenMs;
}

/**
 * 「从没被派过活」的号：没成功过、也几乎没失败过，但额度快照是有的（巡检探过）。
 *
 * 为什么要专门挑它们：`accountWeight` 是 `imageQuota / (1+2×连续失败)`，额度 25 的号
 * 权重是额度 5 的 5 倍，smooth WRR 就按 5:1 分活。实测 121 个号里 55 个 `lastUsedAt`
 * 全为空 —— 它们额度低（2~5），永远排在队尾，一次都没上过场；而被反复使用的
 * 11 个高额度号（额度 10~25）已经被上游限流。这不是「号不行」，是「没轮到」。
 *
 * 它们的 planType / hasImageLimit 和已验证的 55 个号完全一致，没有理由认为不能用。
 * 线上实测：上线后未验证号 55 → 28，出过图的号 55 → 61，还探到一个额度只有 2、
 * 20.9 秒就出图的号（比原来那批 35~51 秒的快得多）。
 *
 * 两个边界：
 *   - **额度 0 的号不探**：肯定出不了图，白烧一个 lane 的 40 秒。
 *   - **给两次机会**（`EXPLORE_ATTEMPTS`）：一次 40 秒超时可能是首次调用要预热、
 *     或者正好赶上上游抖动。只给一次的话，实测有 23 个号「失败一次就永久出局」，
 *     而它们可能只是慢了一点点。
 */
const EXPLORE_ATTEMPTS = 2;

export function unexploredAccounts(ordered, stats) {
  if (!Array.isArray(ordered) || !ordered.length || !stats?.accounts) return [];
  return ordered.filter((account) => {
    const tag = typeof account?.email === "string" ? accountSlotTag(account.email) : "";
    const rec = tag ? stats.accounts[tag] : null;
    // 连额度都没探过的号不拿来赌：token 可能根本无效，试了也是白烧一个 lane。
    if (!rec) return false;
    if ((rec.successCalls || 0) > 0) return false;
    if ((rec.failCalls || 0) >= EXPLORE_ATTEMPTS) return false;
    return !(typeof rec.imageQuota === "number" && rec.imageQuota <= 0);
  });
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
  if (status === 504 || code === "worker_timeout" || code === "worker_hang" || code === "worker_slow" || code === "timeout") {
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
    // 上游 limits 全量（可能含非 image_gen 的 feature）。Python 用下划线
    // `reset_at`，账本统一驼峰 `resetAt`。
    const limits = Array.isArray(res.limits)
      ? res.limits.map((item) => ({
          feature: item?.feature,
          remaining: item?.remaining,
          ...(item?.reset_at ? { resetAt: item.reset_at } : {}),
        }))
      : null;
    // 文本额度：按 policy.textQuotaFeatures 从 limits 派生。默认空 → 返回 null
    // → 账本保留旧值，文本链路继续等权，和 0.10.x 一样。
    const { policy } = await readPoolPolicy().catch(() => ({ policy: DEFAULT_POOL_POLICY }));
    const textQuota = deriveTextQuota(limits, policy.textQuotaFeatures);
    await recordQuotaCheck({
      email: account.email,
      quota: imageQuota,
      restoreAt,
      hasImageLimit,
      planType,
      limits,
      ...(textQuota || {}),
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
    // 策略每次请求读一次（小文件，和 readPoolStats 同一量级）。这样改配置立即生效，
    // 不用重启宿主 —— 线上出问题时能一条 env 关掉某个乘子。
    const { policy } = await readPoolPolicy().catch(() => ({ policy: DEFAULT_POOL_POLICY }));
    // 额度加权轮转 + 熔断（见 selectPoolOrder）。额度耗尽和冷却中的号排到最后兜底。
    const ordered = selectPoolOrder({ accounts, preferredSlot, stats, rotate: true, policy });

    // 顺手把「额度打到 0、重置时间已过」的号复检一下：不登录、不阻塞本次请求。
    // 池子会因此自己长回来，不用人工一个个点「检测额度」。
    if (stats) {
      void refreshExpiredQuotas(accounts, stats, { proxy, ...resolvedStats }).catch(() => {});
    }

    // 一次请求的汇总要跟单账号记录串起来：同一个 requestId + 试了几个号 +
    // 池子里还剩几个没轮到。池子 20 个号、预算只够试几个时，「没轮到」和
    // 「试了失败」必须分得开，否则会把预算耗尽误读成「全部号都挂了」。
    const requestStartedAt = Date.now();
    const requestId = randomBytes(4).toString("hex");
    let attempted = 0;
    noteInflight(1);

    try {
      // 第二路（对冲路）优先去探「从没被派过活」的号，见 unexploredAccounts。
      const explore = unexploredAccounts(ordered, stats);
      const result = await executeWebImageGeneration({
        accounts: ordered,
        request: parsedReq,
        signal: init?.signal,
        reauthenticate,
        ...(runWorker ? { runWorker } : {}),
        proxy,
        // 有探索任务就必须早起步，否则第二路拿不到一次完整的单次预算。
        hedgeDelayMs: hedgeDelayForHead(ordered, stats, { hasExplore: explore.length > 0, policy }),
        // 单号并发闸：同一个号同时只让这么多个 worker 打。0 = 不限制。
        perAccountInflight: policy.perAccountImageInflight,
        // 按模型给单次预算：gpt-image-2.6 实测正常 21–37 秒、尾部超 55 秒，
        // 用默认的 55 秒会把「慢」误判成「卡死」。
        attemptTimeoutMs: resolveImageAttemptTimeout(policy, parsedReq.model),
        // 头号在推流时还要不要起探索路。默认 false：那等于复制一个会成功的请求。
        allowExploreWhileProgressing: policy.exploreWhileProgressing === true,
        exploreAccounts: explore,
        onAccountResult: async (evt) => {
          attempted += 1;
          const code = String(evt.errorCode || "");
          // 请求日志与账本存储无关：即使没有 stats 文件也要记 ring（面板实时流靠它）。
          recordRequest({
            kind: "image",
            requestId,
            email: evt.account?.email,
            ok: evt.success === true,
            code,
            status: evt.httpStatus,
            upstreamStatus: evt.upstreamStatus ?? null,
            ms: evt.ms,
            ttfbMs: evt.ttfbMs,
            attempt: attempted,
            model: parsedReq.model,
            n: parsedReq.n,
            reason: evt.success === true ? "ok" : "failover",
          });
          if (!resolvedStats.statsStore && !resolvedStats.statsFile) return;
          // 账本每个号只留最后一次失败的原文，第二次失败就把第一次盖掉了。
          // 这里另存一份只追加的错误日志，翻得出历史 —— 排查「上游只回了文字」
          // 这类问题时，上游那句话本身就是全部线索。
          // 只在真正落盘（statsFile 存在）时记：内存账本多是测试，不该往 home 里写。
          if (resolvedStats.statsFile && evt.success !== true && code) {
            // 等它写完：一次失败多几毫秒无所谓，但「日志里一定有这条」很重要。
            await appendImageErrorLog({
              email: evt.account?.email,
              requestId,
              code,
              status: evt.httpStatus,
              upstreamStatus: evt.upstreamStatus,
              message: evt.errorMessage || "",
            });
          }
          return recordImageCall({
            email: evt.account?.email,
            success: evt.success === true,
            count: evt.count || 1,
            rateLimited: evt.rateLimited === true,
            retryAfter: evt.retryAfter ?? null,
            error: code,
            errorMessage: evt.errorMessage || "",
            upstreamStatus: evt.upstreamStatus ?? null,
            // 提示词被拒/图片格式不对是请求的错，不该记到账号头上。
            accountFault: !REQUEST_FAULT_CODES.has(code),
            // 重新登录都过不去，是最硬的失效信号。
            authFault: code === "unauthorized",
            // 观测：耗时与首字节画像（0.10.0 只落账本，不参与排序）。
            ms: evt.ms ?? null,
            ttfbMs: evt.ttfbMs ?? null,
          }, resolvedStats);
        },
      });
      recordRequest({
        kind: "image",
        requestId,
        ok: true,
        status: 200,
        ms: Date.now() - requestStartedAt,
        attempt: attempted,
        model: parsedReq.model,
        n: parsedReq.n,
        reason: "ok",
      });
      return jsonResponse(result, 200);
    } catch (err) {
      const code = String(err?.code || (err?.name === "AbortError" ? "client_aborted" : "request_failed"));
      recordRequest({
        kind: "image",
        requestId,
        ok: false,
        code,
        status: Number(err?.status) || undefined,
        ms: Date.now() - requestStartedAt,
        attempt: attempted,
        model: parsedReq.model,
        n: parsedReq.n,
        reason: err?.name === "AbortError" ? "abort" : "budget",
      });
      // 整单失败：记一条汇总。客户端掐断也记 —— 「为什么没出图」同样是问题。
      if (resolvedStats.statsFile) {
        await appendImageErrorLog({
          kind: "request",
          requestId,
          code,
          status: Number(err?.status) || undefined,
          attempted,
          poolSize: ordered.length,
          skipped: Math.max(0, ordered.length - attempted),
          ms: Date.now() - requestStartedAt,
          message: String(err?.message || ""),
        });
      }
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
    } finally {
      noteInflight(-1);
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
    // 请求日志：文本链路以前完全没有逐次记录，这里补上（面板实时流靠它）。
    recordRequest({
      kind: "text",
      email: account?.email || "",
      ok: outcome.ok === true,
      code: outcome.ok === true ? "" : (outcome.code || ""),
      ms: outcome.ms,
      reason: outcome.ok === true ? "ok" : "failover",
    });
    void recordTextCall({
      email: account?.email || "",
      success: outcome.ok === true,
      error: outcome.ok === true ? "" : (outcome.code || ""),
      rateLimited: outcome.rateLimited === true,
      retryAfter: outcome.retryAfter ?? null,
      ms: outcome.ms ?? null,
    }, textStatsTarget).catch(() => {});
  };
  const textPool = textPoolAccounts(accounts, textStats);
  const { policy: textPolicy } = await readPoolPolicy().catch(() => ({ policy: DEFAULT_POOL_POLICY }));
  const ordered = selectPoolOrder({
    accounts: textPool,
    preferredSlot,
    rotate: true,
    credit: textRotationCredit,
    // 文本链路现在也看账本了，但**只看文本自己的信号**：textQuota 定权重、
    // textLimitedUntil 定冷却。图片的额度和熔断一概不读（见 bucketOf）。
    stats: textStats,
    mode: "text",
    policy: textPolicy,
  });
  const webTextAccounts = ordered.filter((a) => isWebOnlyToken(a?.accessToken));

  if (typeof webTextRunner === "function") {
    return executeWebTextGeneration(
      init?.body,
      webTextAccounts.length ? webTextAccounts : ordered,
      { reauthenticate, signal: init?.signal, worker: webTextRunner, proxy, onAttempt: recordText, textStats },
    );
  }

  const codexAccounts = ordered.filter((a) => !isWebOnlyToken(a?.accessToken));
  if (!codexAccounts.length) {
    return executeWebTextGeneration(init?.body, ordered, {
      reauthenticate,
      signal: init?.signal,
      proxy,
      // 兜底分支也要记账，否则纯 Web 号池的文本请求在统计里永远不出现。
      onAttempt: recordText,
      textStats,
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
        { reauthenticate, signal: init?.signal, proxy, onAttempt: recordText, textStats },
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
              { reauthenticate, signal: init?.signal, proxy, onAttempt: recordText, textStats },
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
      onAttempt: recordText,
      textStats,
    });
  }
  return new Response('{"error":{"message":"所有 GPTFree号池 账号均不可用；请检查后台 HTTP 登录、目标模型授权及账号权限。"}}', {
    status: 503, headers: { "content-type": "application/json" },
  });
}
