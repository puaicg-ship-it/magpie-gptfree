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
  // Restore Magpie's per-account local-pool slots automatically after
  // restarting. A corrupt vault must not make the GUI inaccessible.
  try {
    await connection.sync();
  } catch {
    await ctx.client.app.log({
      body: { service: "gptfree", level: "warn",
        message: "Could not restore local account-pool state; inspect GUI pool storage" },
    }).catch(() => {});
  }
  return {};
};

/**
 * Separate, multi-account access-token pool mode.
 * Every admitted vault account is synchronized to its own Magpie Providers
 * account row, allowing individual selection, preferred routing, and failover.
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
      // Multi-account management stays enabled so every pooled account gets its
      // own toggleable row in Magpie Providers.
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
