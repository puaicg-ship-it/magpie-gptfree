/**
 * Magpie provider connection for the local GPTFree token pool.
 *
 * **单端点模式（0.9.0 起）**：整个号池在 Magpie 里只占**一条** auth 记录
 * （key 就是 `gptfree-pool`），Magpie 看到的账号数是 1，模型名不变。
 *
 * 为什么不再一个号一条记录：
 *   以前每个 vault 账号都注册成 `gptfree-pool#s<hash>`，Magpie 因此看到 121 个
 *   账号，**选号和重试都由它来做**。问题是它对我们这 121 个号**没有任何额度数据**
 *   （quotas.json / quota-history.json 里一条都没有），只能盲选，失败了就串行
 *   重试 —— 线上实测 `tries` 最高到 19，一次 7 分钟的成功就是 8 次 × 55 秒。
 *   而真正知道「哪个号还剩几张、哪个号卡死」的是我们自己的账本。
 *
 * 所以轮换权收回插件内部（见 codex-pool 的 selectPoolOrder + 出图预算的 lane 机制），
 * Magpie 只当一条普通通道用。代价是 Magpie Providers 页从 121 行变 1 行 ——
 * 全量账号状态在插件自己的面板（37990）里看。
 *
 * 迁移：老的多账号记录（`gptfree-pool#s*`）会在每次 sync 时被清掉。清不掉的
 * （正好处在 Magpie 那次登录的 key 作用域里）记进 pendingRemoval，下次再清。
 *
 * Never save owner credentials, JWTs, OAuth refresh tokens, or raw email
 * addresses in Magpie's plugin-auth store or in the slot map file; secrets
 * stay strictly in the encrypted local vault.
 */
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { safeAccountName } from "./credentials.mjs";
import { listPool, poolDir } from "./pool-vault.mjs";

// 插件在 0.8.0 改名为 magpie-gptpool，但这两个 id 故意保持原值：
// provider id 是 Magpie 配置里的 key，也是客户端看到的模型名前缀
// （`gptfree-pool/gpt-image-2`）。改了等于把所有已保存的模型名、脚本里的
// 模型字符串一次性作废，收益却只是名字好看。marker 同理：它是识别「这条
// 记录是不是本插件写的」的标记，改了会让老条目变成孤儿。
export const POOL_PROVIDER = "gptfree-pool";
/** 界面上显示的名字。改名时只改这一处，其余都引用它。 */
export const POOL_DISPLAY_NAME = "GPTFree号池";
/** 我们以前用过的名字：配置里存的如果是这些，加载时就地刷新成新名字。 */
const LEGACY_POOL_NAMES = new Set(["GPT号池", "GPT號池"]);
export function isLegacyPoolName(name) {
  return !name || LEGACY_POOL_NAMES.has(String(name));
}
export const POOL_MARKER = "gptfree-local-pool-v1";
const SLOTS_FILE = "magpie-slots.json";
const SLOT_TAG_RE = /^s[0-9a-f]{10}$/;

export function isPoolRecord(item) {
  return typeof item?.email === "string" && item.email.trim().includes("@") &&
    typeof item?.accessToken === "string" && item.accessToken.length > 0 &&
    typeof item?.password === "string" &&
    typeof item?.totp === "string";
}

export function normalizePoolEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * 账号槽位标签（`s` + sha256 前 10 位）。**只用于账本与日志**，不再代表一条
 * Magpie 账号记录 —— 邮箱明文永远不落盘，这是日志能公开贴出来的前提。
 */
export function accountSlotTag(email) {
  const norm = normalizePoolEmail(email);
  return "s" + createHash("sha256").update(norm).digest("hex").slice(0, 10);
}

export function formatAccountSlotLabel(email) {
  const norm = normalizePoolEmail(email);
  if (!norm || !norm.includes("@")) return POOL_DISPLAY_NAME + " 账号";
  const tag = accountSlotTag(norm);
  return `${safeAccountName(norm)} · ${tag.slice(1, 9)}`;
}

export function countValidPoolAccounts(rows) {
  return Array.isArray(rows) ? rows.filter(isPoolRecord).length : 0;
}

export function poolHasAccounts(rows) {
  return countValidPoolAccounts(rows) > 0;
}

export function formatPoolAccountLabel(count) {
  const n = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  return n > 1 ? `${POOL_DISPLAY_NAME} (${n} 个账号)` : POOL_DISPLAY_NAME;
}

/**
 * 单端点模式下唯一那条 auth 记录。`metadata.poolAccounts` 让面板能显示池子规模，
 * 但**不带 poolSlot** —— 没有槽位可钉，请求进来一律走插件内部的额度加权轮换。
 */
export function buildPoolAuthBody(count) {
  const label = formatPoolAccountLabel(count);
  return {
    type: "api",
    key: POOL_MARKER,
    accountId: label,
    metadata: {
      email: label,
      poolAccounts: Math.max(0, Math.trunc(Number(count) || 0)),
    },
  };
}

/** 老的多账号记录长这样；迁移时一律清掉。 */
export function isLegacySlotKey(key) {
  return typeof key === "string" && key.startsWith(POOL_PROVIDER + "#");
}

/**
 * @deprecated 0.9.0 起单端点，不再给每个号建一条记录。保留导出只是为了让
 * 旧测试/脚本还能构造出「一条合法的 pool auth body」。
 */
export function buildSlotAuthBody(email) {
  const label = formatAccountSlotLabel(email);
  return {
    type: "api",
    key: POOL_MARKER,
    accountId: label,
    metadata: { email: label, poolSlot: accountSlotTag(email) },
  };
}

function isValidPoolAuthKey(key) {
  return typeof key === "string" &&
    (key === POOL_PROVIDER || key.startsWith(POOL_PROVIDER + "#")) &&
    key.length <= 96;
}

/**
 * Synchronize Magpie's plugin auth entries with the encrypted vault.
 *
 * 单端点：只保证 `POOL_PROVIDER` 这一条存在且标签是当前池子规模，其余
 * `gptfree-pool#*` 全部清掉。
 */
export function createPoolConnector(client, {
  poolRead = listPool,
  getActiveKey = null,
  slotsFile = undefined,
} = {}) {
  if (typeof client?.auth?.set !== "function" ||
      typeof client?.auth?.remove !== "function")
    throw new Error("Magpie's host does not support automatic provider registration");

  const resolvedSlotsFile = slotsFile === false ? null :
    slotsFile !== undefined ? slotsFile :
    poolRead === listPool ? join(poolDir(), SLOTS_FILE) : null;

  // Capture an empty AsyncLocalStorage context at connector initialization
  // time so background batch callbacks running after authorize() still call
  // client.auth.set({ path: { id: "gptfree-pool" } }) without Magpie's
  // keyFor() hijacking it to a different account's active sign-in key.
  const outsideScope = typeof AsyncLocalStorage?.snapshot === "function"
    ? AsyncLocalStorage.snapshot()
    : (fn) => fn();

  /** 待清理的老记录（迁移目标）。键是 Magpie 的 auth id，不含任何账号信息。 */
  const legacyKeys = new Set();
  let slotsLoaded = false;
  let queued = Promise.resolve();

  const runOutside = (fn) => outsideScope(fn);

  async function loadSlots() {
    if (slotsLoaded || !resolvedSlotsFile) {
      slotsLoaded = true;
      return;
    }
    slotsLoaded = true;
    try {
      const raw = await readFile(resolvedSlotsFile, "utf8");
      const parsed = JSON.parse(raw);
      // v1 是 { slots: { s<hash>: "gptfree-pool#..." } }，v2 是 { legacyKeys: [...] }。
      const fromSlots = parsed?.slots && typeof parsed.slots === "object"
        ? Object.values(parsed.slots)
        : [];
      const fromList = Array.isArray(parsed?.legacyKeys) ? parsed.legacyKeys : [];
      for (const key of [...fromSlots, ...fromList]) {
        if (isValidPoolAuthKey(key) && isLegacySlotKey(key)) legacyKeys.add(key);
      }
    } catch {
      // Missing or invalid state file: rebuilt cleanly from the vault on sync.
    }
  }

  async function persistSlots() {
    if (!resolvedSlotsFile) return;
    const parent = join(resolvedSlotsFile, "..");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const tmp = `${resolvedSlotsFile}.${randomBytes(6).toString("hex")}.tmp`;
    const payload = JSON.stringify({
      version: 2,
      legacyKeys: [...legacyKeys].sort(),
    }, null, 2);
    try {
      await writeFile(tmp, payload, { mode: 0o600, flag: "wx" });
      await rename(tmp, resolvedSlotsFile);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  const run = async (callerActiveKey = "") => {
    await loadSlots();

    const rows = await poolRead();
    const valid = [];
    const seenSlots = new Set();
    for (const item of Array.isArray(rows) ? rows : []) {
      if (!isPoolRecord(item)) continue;
      const slot = accountSlotTag(item.email);
      if (seenSlots.has(slot)) continue;
      seenSlots.add(slot);
      valid.push(item);
    }

    const activeKey = callerActiveKey ||
      (typeof getActiveKey === "function" ? String(getActiveKey() || "") : "");
    // 正在被 Magpie 用来登录的那条 key 不能删：会把它自己的会话打断。
    const canTouchKey = (key) => !activeKey || activeKey !== key;

    // 先保证单端点那条在（用 runOutside 逃开 keyFor() 的作用域重定向），
    // 再清老记录 —— 顺序不能反，否则中间那一瞬间池子在 Magpie 里是空的。
    if (valid.length > 0 && canTouchKey(POOL_PROVIDER)) {
      await runOutside(() => client.auth.set({
        path: { id: POOL_PROVIDER },
        body: buildPoolAuthBody(valid.length),
      }));
    }

    for (const key of [...legacyKeys]) {
      if (!canTouchKey(key)) continue;
      try {
        await runOutside(() => client.auth.remove({ path: { id: key } }));
      } catch {
        // 删不掉就留到下一轮，不要让一次失败的清理挡住整次 sync。
        continue;
      }
      legacyKeys.delete(key);
    }

    if (valid.length === 0) {
      if (canTouchKey(POOL_PROVIDER)) {
        await runOutside(() => client.auth.remove({ path: { id: POOL_PROVIDER } }));
      }
      await persistSlots();
      return { connected: false, count: 0, accounts: [] };
    }

    await persistSlots();
    const label = formatPoolAccountLabel(valid.length);
    return {
      connected: true,
      count: valid.length,
      accounts: [{ key: POOL_PROVIDER, label }],
    };
  };

  return {
    /**
     * 原生登录流程登录完会拿到一条 Magpie 建的 key。单端点模式下它不该留下，
     * 记进待清理列表，下一次 sync 就没了 —— 留着的话 Magpie 里会多出一行账号。
     */
    claimKey(_emailOrSlot, magpieKey) {
      if (isValidPoolAuthKey(magpieKey) && isLegacySlotKey(magpieKey)) {
        legacyKeys.add(magpieKey);
      }
    },
    sync() {
      const callerActiveKey = typeof getActiveKey === "function"
        ? String(getActiveKey() || "")
        : "";
      const next = queued.then(() => run(callerActiveKey), () => run(callerActiveKey));
      queued = next.catch(() => {});
      return next;
    },
  };
}
