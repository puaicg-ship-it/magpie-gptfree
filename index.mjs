/**
 * Standalone Magpie GUI and token-pool providers (GPTFree号池).
 * GUI entry runs in the plugin-host and serves its own sandboxed page.
 * Primary import & management live in the left-sidebar page (GPTFree号池).
 */
import { CODEX_BASE, discoverPoolModels, poolFetch, startQuotaSweep } from "./lib/codex-pool.mjs";
import { GUI_PORT, startGuiServer } from "./lib/gui-service.mjs";
import {
  createPoolConnector, isLegacyPoolName, POOL_DISPLAY_NAME, POOL_MARKER, POOL_PROVIDER,
} from "./lib/pool-connection.mjs";
import { nativeImportMethod } from "./lib/provider-native-signin.mjs";

let sharedClient = null;
let sharedConnector = null;
let sharedActiveKey = null;

function ensurePoolConnector(ctx) {
  if (typeof ctx?.magpie?.account === "function") {
    sharedActiveKey = () => String(ctx.magpie.account(POOL_PROVIDER) || "");
  }
  if (typeof ctx?.client?.auth?.set === "function" &&
      typeof ctx?.client?.auth?.remove === "function") {
    if (!sharedConnector || sharedClient !== ctx.client) {
      sharedClient = ctx.client;
      sharedConnector = createPoolConnector(ctx.client, {
        getActiveKey: () => (sharedActiveKey ? sharedActiveKey() : ""),
      });
    }
  }
  return sharedConnector;
}

/**
 * 单端点模式（0.9.0 起）下不再有「Magpie 指定用哪个号」这回事：Magpie 只有一条
 * auth 记录，选号完全由插件内部的额度加权轮换决定。老配置里残留的 poolSlot
 * 会被忽略 —— 否则一个早就死掉的号会被一直钉在第一位。
 */
function slotFromAuth() {
  return "";
}

/**
 * 同步结果必须能从容器日志里看见。`ctx.client.app.log` 写的是 Magpie 自己的
 * 日志面板，`docker logs` 里看不到 —— 0.9.0 首次上线时「记录没写进去」就是
 * 这样静默了十几分钟。
 */
function poolLog(level, message) {
  const line = `[gptfree] ${message}`;
  try {
    if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    // 日志失败不能影响主流程。
  }
}

async function logToHost(ctx, level, message) {
  try {
    await ctx?.client?.app?.log?.({ body: { service: "gptfree", level, message } });
  } catch {
    // 同上。
  }
}

/** 插件宿主先于 Magpie 主进程启动，第一轮写记录可能扑空；退避重试几轮。 */
const POOL_SYNC_RETRY_MS = [5000, 20000, 60000, 180000];
let syncRetrying = false;

async function syncPoolOnce(connection, ctx) {
  try {
    const result = await connection.sync();
    const count = Number(result?.count || 0);
    if (result?.connected === true) {
      poolLog("info", `pool endpoint ready: ${POOL_PROVIDER} · ${count} 个账号`);
      return true;
    }
    poolLog("warn", `pool endpoint absent: vault 里没有可用账号（${count}）`);
    return false;
  } catch (error) {
    const message = `pool endpoint sync failed: ${String(error?.message || error)}`;
    poolLog("warn", message);
    void logToHost(ctx, "warn", message);
    return false;
  }
}

async function schedulePoolSync(connection, ctx) {
  if (await syncPoolOnce(connection, ctx)) return;
  // 两个插件入口都会调这里（GUI 可能因为端口被占而加载失败），退避链只跑一条。
  if (syncRetrying) return;
  syncRetrying = true;
  void (async () => {
    for (const delay of POOL_SYNC_RETRY_MS) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
      });
      if (await syncPoolOnce(connection, ctx)) {
        syncRetrying = false;
        return;
      }
    }
    syncRetrying = false;
    poolLog("warn", `pool endpoint still missing after ${POOL_SYNC_RETRY_MS.length} retries`);
  })();
}

export const GPTFreeGuiPlugin = async (ctx, options) => {
  const raw = options?.port ?? GUI_PORT;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("GPTFree号池 GUI: invalid service port");
  const connection = ensurePoolConnector(ctx) || createPoolConnector(ctx.client);
  try {
    await startGuiServer({ port, onPoolChange: () => connection.sync() });
  } catch (error) {
    // The GUI port is normally held by the previous host, which is still
    // shutting down: a host restart overlaps the two for a moment. The
    // pool's provider side does not need the GUI service, so the plugin
    // keeps loading and its models hook stays registered. Letting this
    // throw failed the whole plugin load, which left the provider with no
    // endpoint at all ("GPTFree号池 has no endpoint configured") until the
    // port was freed by hand.
    const message = "GPTFree号池 GUI service could not start (" +
      String(error?.message || error) + "); the pool provider stays available, " +
      "the sidebar page is unavailable until the port is free";
    try {
      await ctx?.client?.app?.log?.({
        body: { service: "gptfree", level: "warn", message },
      });
    } catch {
      // A log that cannot be written must not stop the plugin from loading.
    }
  }
  // Restore Magpie's single pool endpoint automatically after restarting.
  // A corrupt vault must not make the GUI inaccessible.
  //
  // 这里的重试不是保险丝而是必需品：插件宿主比 Magpie 主进程先起来（线上
  // 实测宿主 12:10:57 就 bind 了 GUI，主进程 12:11:54 才打印 web 地址），
  // 在它还没接管 auth 存储时写记录可能失败。失败一次就永远丢整个号池，所以
  // 退避重试几轮，并把这些结果写进容器日志（app.log 的 warn 不进 stdout）。
  await schedulePoolSync(connection, ctx);
  return {};};

/**
 * Separate, multi-account access-token pool mode.
 *
 * 0.9.0 起是**单端点**：整个号池在 Magpie 里只占一条 Providers 记录
 * （「GPTFree号池 (N 个账号)」），轮换、故障转移、额度加权全部由插件内部完成。
 * 以前是每个号一条记录、让 Magpie 自己挑 —— 但它对我们这些号没有任何额度数据，
 * 只能盲选，实测一次请求能重试到 19 次。
 */
export const GPTFreePoolPlugin = async (ctx = {}) => {
  const connector = ensurePoolConnector(ctx);
  // 账号状态确认：每 10 分钟挑 2 个「额度快照过期」的号问一次额度。
  // 池子闲着的时候快照会一直停在上一次，而选号完全靠这份快照 —— 不巡检就是盲选。
  // 只查额度：不登录、不触发 MFA，失败静默。宿主里只会有一个定时器（有守卫）。
  try {
    startQuotaSweep();
  } catch {
    // 巡检起不来不能挡住插件加载。
  }
  // 单端点记录由 GPTFreeGuiPlugin 负责写（端口被占时那个插件也会走到
  // schedulePoolSync，不会提前 return），这里不重复写：两个入口各持一个
  // connector 时容易互相覆盖，也没有额外收益。
  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      const existing = cfg.provider[POOL_PROVIDER];
      if (!existing) {
        cfg.provider[POOL_PROVIDER] = {
          name: POOL_DISPLAY_NAME,
          npm: "@ai-sdk/openai",
          api: CODEX_BASE,
          models: {},
        };
      } else if (isLegacyPoolName(existing.name)) {
        // 0.8.2 起显示名改成 GPTFree号池。老配置里存的还是旧名字，
        // 而这里原来是 `??=`，永远不会覆盖 —— 升级后界面上会一直显示旧名。
        // 只在我们自己用过的名字上就地刷新，用户手动改过的名字不动。
        existing.name = POOL_DISPLAY_NAME;
      }
    },
    auth: {
      provider: POOL_PROVIDER,
      // 单端点模式下这是**整个号池**的并发上限（以前是每个号 2）。
      // 线上实测同时在飞的生图请求峰值 8、常见 3，取 4 既不排队也不会把
      // 容器里的 python worker 铺满（每个请求最多再起 2 个 lane）。
      maxConcurrency: 4,
      // Native Magpie prompt & file chooser; never opens an external website.
      // 单端点：号池只占一条记录，所以这里开的是「整池并发」而不是每号并发。
      methods: [nativeImportMethod({
        ...(connector ? { server: () => startGuiServer({ port: GUI_PORT, onPoolChange: () => sharedConnector?.sync() }) } : {}),
        syncPool: () => sharedConnector?.sync(),
        claimSlotKey: (slot, key) => sharedConnector?.claimKey(slot, key),
        activeKey: () => (sharedActiveKey ? sharedActiveKey() : ""),
      })],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api") return {};
        const preferredSlot = slotFromAuth(auth);
        return {
          baseURL: CODEX_BASE,
          apiKey: POOL_MARKER,
          fetch: (input, init) => poolFetch(input, init, { preferredSlot }),
        };
      },
    },
    provider: {
      id: POOL_PROVIDER,
      async models(_provider, { auth } = {}) {
        if (auth?.type !== "api") return {};
        return discoverPoolModels({ preferredSlot: slotFromAuth(auth) });
      },
    },
  };
};
