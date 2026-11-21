/**
 * refresh_token 续期 + 浏览器 OAuth 落库的行为约定。
 *
 * 这里守的是 0.12.10 最容易出事的三条线：
 *   1. refresh_token 轮换后必须写回，否则下次续期必挂；
 *   2. refresh 失败要分清「token 废了」和「网络抽风」，前者能降级、后者不能乱试；
 *   3. 判死只认 reauth_required，不认 invalid_grant —— 有密码的号不该被误杀。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPool, upsertPool } from "../lib/pool-vault.mjs";
import { parseAccounts } from "../lib/credentials.mjs";
import { renewAccount } from "../lib/codex-pool.mjs";
import { runBatch } from "../lib/importer.mjs";
import {
  AUTH_FAIL_LIMIT, accountDeadReason, createInMemoryStatsStore, recordQuotaCheck,
} from "../lib/pool-stats.mjs";

const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const jwt = (delta, email = "a@example.com") => [
  Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url"),
  Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + delta,
    email,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct123" },
  })).toString("base64url"),
  "signature",
].join(".");

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "gptfree-refresh-"));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

// ── vault ────────────────────────────────────────────────────────────────────

test("vault 持久化 refresh_token，重新导入空值时不会把它抹掉", async () => {
  await withRoot(async (root) => {
    const base = {
      email: "keep@example.com", password: "p", totp: seed,
      accessToken: jwt(3600), refreshToken: "rt_first",
    };
    await upsertPool(base, { root });
    // 重新导入同一个邮箱，但这次没有带 refresh_token（TXT 里本来就可能没有）。
    await upsertPool({ ...base, accessToken: jwt(7200), refreshToken: "" }, { root });
    const [row] = await listPool({ root });
    assert.equal(row.refreshToken, "rt_first", "空值不该覆盖已有 refresh_token");
    assert.equal(row.password, "p", "空值同样不该覆盖已有密码");
  });
});

test("旧记录没有 refreshToken 字段时读出来是空串，而不是 undefined", async () => {
  await withRoot(async (root) => {
    await upsertPool({
      email: "old@example.com", password: "p", totp: seed, accessToken: jwt(3600),
    }, { root });
    const [row] = await listPool({ root });
    assert.equal(row.refreshToken, "");
  });
});

test("浏览器 OAuth 账号没有密码也能入池", async () => {
  await withRoot(async (root) => {
    await upsertPool({
      email: "oauth@example.com", password: "", totp: "",
      accessToken: jwt(3600), refreshToken: "rt_oauth",
    }, { root });
    const [row] = await listPool({ root });
    assert.equal(row.password, "");
    assert.equal(row.refreshToken, "rt_oauth");
  });
});

// ── TXT 解析 ─────────────────────────────────────────────────────────────────

test("TXT 第五列是 refresh_token 时把值带出来，不再只留一个布尔", () => {
  const raw = `a@example.com----p1----${seed}----${jwt(3600)}----rt_from_txt`;
  const { accounts } = parseAccounts(raw);
  assert.equal(accounts[0].hasRefreshToken, true);
  assert.equal(accounts[0].refreshToken, "rt_from_txt");
});

test("TXT 反向顺序（第四列 refresh、第五列 access）也能识别", () => {
  const raw = `a@example.com----p1----${seed}----rt_reversed----${jwt(3600)}`;
  const { accounts } = parseAccounts(raw);
  assert.equal(accounts[0].refreshToken, "rt_reversed");
});

test("导入未过期的 access_token 时把 refresh_token 一起落库", async () => {
  const saved = [];
  const raw = `t@example.com----p----${seed}----${jwt(3600)}----rt_imported`;
  const result = await runBatch({
    file: "virtual.txt", consent: true, read: async () => raw,
    login: () => { throw new Error("不该重登：token 还没过期"); },
    verifyToken: async () => ({ accepted: true }),
    savePool: async (record) => saved.push(record),
    checkQuota: null,
  });
  assert.equal(result.added, 1);
  assert.equal(saved[0].refreshToken, "rt_imported");
});

// ── renewAccount ─────────────────────────────────────────────────────────────

test("续期优先用 refresh_token，并把轮换后的新值写回", async () => {
  const saved = [];
  let logins = 0;
  const account = {
    email: "r@example.com", password: "should-not-be-used", totp: seed,
    accessToken: jwt(-10), refreshToken: "rt_old",
  };
  const renewed = await renewAccount(account, {
    refresh: async ({ refreshToken }) => {
      assert.equal(refreshToken, "rt_old");
      return { accessToken: jwt(3600), refreshToken: "rt_new" };
    },
    authenticate: async () => { logins++; return { tokens: { access: jwt(3600) } }; },
    verify: async () => ({ accepted: true }),
    save: async (record) => saved.push(record),
  });
  assert.equal(logins, 0, "有 refresh_token 就不该碰密码登录");
  assert.equal(renewed.refreshToken, "rt_new");
  assert.equal(saved[0].refreshToken, "rt_new", "轮换后的新值必须落库");
});

test("refresh 返回 invalid_grant 但有密码：静默降级走密码登录", async () => {
  const saved = [];
  let logins = 0;
  const account = {
    email: "fallback@example.com", password: "p", totp: seed,
    accessToken: jwt(-10), refreshToken: "rt_dead",
  };
  const renewed = await renewAccount(account, {
    refresh: async () => {
      const err = new Error("OAuth 令牌换取失败 (400)：invalid_grant");
      err.status = 400;
      err.oauthError = "invalid_grant";
      throw err;
    },
    authenticate: async () => { logins++; return { tokens: { access: jwt(3600), refresh: "rt_fresh" } }; },
    verify: async () => ({ accepted: true }),
    save: async (record) => saved.push(record),
  });
  assert.equal(logins, 1);
  assert.equal(renewed.refreshToken, "rt_fresh", "密码登录顺带给的新 refresh_token 也要存");
});

test("refresh 失效且没有密码：抛 reauth_required，交给判死逻辑", async () => {
  const account = {
    email: "oauth-only@example.com", password: "", totp: "",
    accessToken: jwt(-10), refreshToken: "rt_dead",
  };
  await assert.rejects(
    renewAccount(account, {
      refresh: async () => {
        const err = new Error("OAuth 令牌换取失败 (400)：invalid_grant");
        err.status = 400;
        err.oauthError = "invalid_grant";
        throw err;
      },
      authenticate: async () => { throw new Error("没有密码不该走到这里"); },
      verify: async () => ({ accepted: true }),
      save: async () => {},
    }),
    /reauth_required/,
  );
});

test("refresh 遇到网络错误：直接抛出，绝不拿密码登录去硬撞", async () => {
  let logins = 0;
  const account = {
    email: "flaky@example.com", password: "p", totp: seed,
    accessToken: jwt(-10), refreshToken: "rt_ok",
  };
  await assert.rejects(
    renewAccount(account, {
      refresh: async () => { throw new Error("fetch failed: ECONNRESET"); },
      authenticate: async () => { logins++; return { tokens: { access: jwt(3600) } }; },
      verify: async () => ({ accepted: true }),
      save: async () => {},
    }),
    /ECONNRESET/,
  );
  assert.equal(logins, 0, "网络故障时多跑一次重登只会放大限流风险");
});

test("refresh 成功但 token 通不过验证：有密码就再试密码路径", async () => {
  let logins = 0;
  const account = {
    email: "rejected@example.com", password: "p", totp: seed,
    accessToken: jwt(-10), refreshToken: "rt_ok",
  };
  const renewed = await renewAccount(account, {
    refresh: async () => ({ accessToken: jwt(3600), refreshToken: "rt_ok2" }),
    verify: async (token) => ({ accepted: token === "password-token" }),
    authenticate: async () => { logins++; return { tokens: { access: "password-token" } }; },
    save: async () => {},
  });
  assert.equal(logins, 1);
  assert.equal(renewed.accessToken, "password-token");
});

test("没有 refresh_token 的号仍走原来的密码登录路径", async () => {
  let logins = 0;
  const account = {
    email: "legacy@example.com", password: "p", totp: seed,
    accessToken: jwt(-10), refreshToken: "",
  };
  const renewed = await renewAccount(account, {
    refresh: async () => { throw new Error("不该调用 refresh"); },
    authenticate: async () => { logins++; return { tokens: { access: jwt(3600) } }; },
    verify: async () => ({ accepted: true }),
    save: async () => {},
  });
  assert.equal(logins, 1);
  assert.ok(renewed.accessToken);
});

// ── 判死语义 ─────────────────────────────────────────────────────────────────

test("reauth_required 计入 authFails 并最终判死", async () => {
  const store = createInMemoryStatsStore();
  const email = "dead@example.com";
  for (let i = 0; i < AUTH_FAIL_LIMIT; i++) {
    await recordQuotaCheck(
      { email, error: "refresh_token 已失效且没有保存密码，需要重新网页授权（reauth_required）" },
      { statsStore: store },
    );
  }
  assert.equal(accountDeadReason(email, store.state), "auth");
});

test("单独的 invalid_grant 不算判死：那只是中间过程，不是账号结局", async () => {
  const store = createInMemoryStatsStore();
  const email = "still-alive@example.com";
  for (let i = 0; i < AUTH_FAIL_LIMIT + 2; i++) {
    await recordQuotaCheck(
      { email, error: "OAuth 令牌换取失败 (400)：invalid_grant" },
      { statsStore: store },
    );
  }
  assert.equal(accountDeadReason(email, store.state), "");
});
