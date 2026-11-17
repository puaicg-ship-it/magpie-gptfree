import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accountSlotTag, createPoolConnector, formatPoolAccountLabel,
  POOL_PROVIDER, POOL_MARKER, POOL_DISPLAY_NAME,
} from "../lib/pool-connection.mjs";
import { GPTFreePoolPlugin } from "../index.mjs";

const entry = { email: "example1@example.com", password: "not-stored-owner-password-1", totp: "", accessToken: "sample.token.1" };
const entry2 = { email: "example2@example.com", password: "not-stored-owner-password-2", totp: "", accessToken: "sample.token.2" };
const entry3 = { email: "third@example.com", password: "not-stored-owner-password-3", totp: "", accessToken: "sample.token.3" };

function host() {
  const saved = new Map();
  const scope = new AsyncLocalStorage();
  const resolveKey = (id) => {
    const active = scope.getStore();
    return active && id === active.provider ? active.key : id;
  };
  const client = {
    auth: {
      async set({ path, body }) { saved.set(resolveKey(path.id), body); return { data: true }; },
      async remove({ path }) { saved.delete(resolveKey(path.id)); return { data: true }; },
    },
  };
  const magpie = {
    account(provider) {
      const active = scope.getStore();
      return active && active.provider === provider ? active.key : undefined;
    },
  };
  return { client, magpie, saved, scope };
}

test("empty local pool has no provider sign-in and multi-account oauth is enabled", async () => {
  const h = host();
  h.saved.set(POOL_PROVIDER, { type: "api", key: POOL_MARKER });
  const connect = createPoolConnector(h.client, { poolRead: async () => [] });
  assert.deepEqual(await connect.sync(), { connected: false, count: 0, accounts: [] });
  assert.equal(h.saved.size, 0);
  const plugin = await GPTFreePoolPlugin();
  assert.equal(plugin.auth.single, undefined);
  assert.equal(plugin.auth.methods[0].type, "oauth");
});

test("single endpoint: the whole pool is one Magpie account row carrying the pool label", async () => {
  const h = host();
  let rows = [entry];
  const connect = createPoolConnector(h.client, { poolRead: async () => rows, slotsFile: false });
  const first = await connect.sync();
  assert.equal(first.connected, true);
  assert.equal(first.count, 1);
  assert.equal(h.saved.size, 1);
  assert.equal(h.saved.get(POOL_PROVIDER).key, POOL_MARKER);
  assert.equal(h.saved.get(POOL_PROVIDER).accountId, POOL_DISPLAY_NAME);
  assert.equal(h.saved.get(POOL_PROVIDER).metadata.email, POOL_DISPLAY_NAME);
  // 单端点下没有「钉哪个号」这回事：poolSlot 必须不存在，否则旧逻辑会把
  // 一个早就不行的号永远排在第一。
  assert.equal(h.saved.get(POOL_PROVIDER).metadata.poolSlot, undefined);

  rows = [entry, entry2, entry3];
  const multi = await connect.sync();
  assert.equal(multi.connected, true);
  assert.equal(multi.count, 3);
  // 关键：3 个号仍然是 1 条记录，不再一个号一条。
  assert.equal(h.saved.size, 1);
  assert.equal(h.saved.get(POOL_PROVIDER).accountId, formatPoolAccountLabel(3));
  assert.equal(h.saved.get(POOL_PROVIDER).metadata.poolAccounts, 3);
  assert.deepEqual(multi.accounts, [{ key: POOL_PROVIDER, label: formatPoolAccountLabel(3) }]);

  const dumped = JSON.stringify([...h.saved]);
  for (const item of rows) {
    assert(!dumped.includes(item.email));
    assert(!dumped.includes(item.password));
    assert(!dumped.includes(item.accessToken));
  }

  const plugin = await GPTFreePoolPlugin(h);
  const opts = await plugin.auth.loader(async () => h.saved.get(POOL_PROVIDER));
  assert.equal(opts.apiKey, POOL_MARKER);
});

test("legacy per-account rows are pruned and the pool collapses to one row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-slots-test-"));
  const slotsFile = join(dir, "magpie-slots.json");
  const legacy2 = `${POOL_PROVIDER}#${accountSlotTag(entry2.email)}`;
  try {
    // v1 的槽位表 + Magpie 里已经存在的两条老记录
    await writeFile(slotsFile, JSON.stringify({
      version: 1,
      slots: {
        [accountSlotTag(entry.email)]: POOL_PROVIDER,
        [accountSlotTag(entry2.email)]: legacy2,
      },
    }));
    const h = host();
    h.saved.set(POOL_PROVIDER, { type: "api", key: POOL_MARKER, accountId: "stale label" });
    h.saved.set(legacy2, { type: "api", key: POOL_MARKER, accountId: "stale label 2" });

    const connect = createPoolConnector(h.client, {
      poolRead: async () => [entry, entry2],
      slotsFile,
    });
    await connect.sync();

    assert.equal(h.saved.size, 1);
    assert.equal(h.saved.has(legacy2), false);
    assert.equal(h.saved.get(POOL_PROVIDER).metadata.poolAccounts, 2);

    const parsed = JSON.parse(await readFile(slotsFile, "utf8"));
    assert.equal(parsed.version, 2);
    assert.deepEqual(parsed.legacyKeys, []);
    assert(!JSON.stringify(parsed).includes(entry.email));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a legacy key Magpie is currently signing in under is deferred to the next sync", async () => {
  const legacy = `${POOL_PROVIDER}#custom2`;
  const h = host();
  h.saved.set(legacy, { type: "api", key: POOL_MARKER, accountId: "custom2" });
  const connect = createPoolConnector(h.client, {
    poolRead: async () => [entry],
    slotsFile: false,
    getActiveKey: () => h.magpie.account(POOL_PROVIDER) || "",
  });

  // 正在用 custom2 这条 key 登录时，不能把它自己删掉 —— 会打断这次登录。
  await h.scope.run({ provider: POOL_PROVIDER, key: legacy }, async () => {
    connect.claimKey(entry.email, legacy);
    await connect.sync();
  });
  assert.equal(h.saved.has(legacy), true);
  // 但池子那一条已经在（runOutside 逃开了 keyFor() 的作用域重定向，
  // 否则这次 set 会被写到 custom2 上）。
  assert.equal(h.saved.get(POOL_PROVIDER).metadata.poolAccounts, 1);

  // 离开作用域后下一次 sync 清掉。
  await connect.sync();
  assert.equal(h.saved.has(legacy), false);
  assert.equal(h.saved.size, 1);
});

test("pending legacy keys survive a restart and are cleaned on the next sync", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-slots-test-"));
  const slotsFile = join(dir, "magpie-slots.json");
  const legacy = `${POOL_PROVIDER}#${accountSlotTag(entry3.email)}`;
  try {
    await writeFile(slotsFile, JSON.stringify({ version: 2, legacyKeys: [legacy] }));
    const h = host();
    h.saved.set(legacy, { type: "api", key: POOL_MARKER });
    const connect = createPoolConnector(h.client, { poolRead: async () => [entry], slotsFile });
    const res = await connect.sync();
    assert.equal(res.count, 1);
    assert.equal(h.saved.has(legacy), false);
    assert.equal(h.saved.size, 1);
    const parsed = JSON.parse(await readFile(slotsFile, "utf8"));
    assert.deepEqual(parsed.legacyKeys, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
