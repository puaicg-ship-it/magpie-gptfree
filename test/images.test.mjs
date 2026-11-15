import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiService } from "../lib/gui-service.mjs";
import {
  deleteImages,
  dailyCounts,
  invalidateListCache,
  listImageNames,
  listImages,
  pruneOldImages,
  purgeOlderThanDays,
  resolveImagePath,
  scanImages,
} from "../lib/image-store.mjs";
import {
  DEFAULT_IMAGE_RETENTION_DAYS,
  readImageRetentionDays,
  writeImageRetentionDays,
} from "../lib/reply-settings.mjs";

const DAY = 86400000;

/** 临时目录 + 一批指定时间的假图片。返回 { dir, home, names }。 */
async function fixture(counts) {
  const root = await mkdtemp(join(tmpdir(), "gptfree-images-"));
  const dir = join(root, "images");
  const home = join(root, "home");
  process.env.MAGPIE_GPTFREE_IMAGE_DIR = dir;
  process.env.MAGPIE_GPTFREE_HOME = home;
  await writeFile(join(root, ".keep"), "");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const names = [];
  const now = Date.now();
  for (const { ageDays, size, ext = "png" } of counts) {
    const mtime = now - ageDays * DAY;
    const name = `${mtime.toString(36)}-${String(names.length).padStart(16, "0")}.${ext}`;
    const file = join(dir, name);
    await writeFile(file, Buffer.alloc(size, 1));
    await utimes(file, new Date(mtime), new Date(mtime));
    names.push(name);
  }
  invalidateListCache();
  return { root, dir, home, names };
}

function cleanup(root) {
  delete process.env.MAGPIE_GPTFREE_IMAGE_DIR;
  delete process.env.MAGPIE_GPTFREE_HOME;
  delete process.env.MAGPIE_GPTFREE_IMAGE_RETENTION_DAYS;
  return rm(root, { recursive: true, force: true });
}

test("resolveImagePath only accepts plain image names inside the image dir", () => {
  process.env.MAGPIE_GPTFREE_IMAGE_DIR = "/config/images";
  try {
    assert.equal(resolveImagePath("abc-123.png"), "/config/images/abc-123.png");
    assert.equal(resolveImagePath("a_b.c-1.jpeg"), "/config/images/a_b.c-1.jpeg");
    // 路径穿越、子目录、绝对路径、别的扩展名、空值，一律拒绝。
    for (const bad of [
      "../../etc/passwd", "..%2f..%2fetc/passwd", "/etc/passwd", "sub/a.png",
      "a.png/../../b.png", "a.txt", "a.png\n", "", null, undefined, "a b.png",
    ]) {
      assert.equal(resolveImagePath(bad), "", `应拒绝：${String(bad)}`);
    }
  } finally {
    delete process.env.MAGPIE_GPTFREE_IMAGE_DIR;
  }
});

test("listImages paginates, sorts by size, filters by date, and reports totals", async () => {
  const fx = await fixture([
    { ageDays: 0, size: 100 },
    { ageDays: 1, size: 900 },
    { ageDays: 2, size: 500 },
    { ageDays: 30, size: 700 },
  ]);
  try {
    const page = await listImages({ offset: 0, limit: 2 });
    assert.equal(page.total, 4);
    assert.equal(page.allCount, 4);
    assert.equal(page.totalBytes, 2200);
    assert.equal(page.items.length, 2);
    // 默认按时间倒序：最新的在前。
    assert.equal(page.items[0].name, fx.names[0]);
    assert.equal(page.items[1].name, fx.names[1]);
    assert.ok(page.earliest < page.latest);

    const page2 = await listImages({ offset: 2, limit: 2 });
    assert.equal(page2.items.length, 2);
    assert.notEqual(page2.items[0].name, page.items[0].name);

    const bySize = await listImages({ sort: "size", limit: 4 });
    assert.deepEqual(bySize.items.map((item) => item.size), [900, 700, 500, 100]);

    // 日期筛选：只留近 3 天（YYYY-MM-DD，按本地日期）。
    const from = new Date(Date.now() - 3 * DAY);
    const pad = (n) => String(n).padStart(2, "0");
    const fromKey = `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}`;
    const filtered = await listImages({ from: fromKey, limit: 10 });
    assert.equal(filtered.total, 3);
    assert.equal(filtered.allCount, 4, "总张数还是全部");

    const names = await listImageNames({ from: fromKey });
    assert.equal(names.length, 3);
    assert.equal(names[0].size, 100);
  } finally {
    await cleanup(fx.root);
  }
});

test("dailyCounts buckets by local day and includes today", async () => {
  const now = Date.parse("2026-11-15T18:00:00");
  const daily = dailyCounts([
    { name: "a.png", size: 1, mtime: now },
    { name: "b.png", size: 1, mtime: now - DAY },
    { name: "c.png", size: 1, mtime: now - 13 * DAY },
    { name: "d.png", size: 1, mtime: now - 14 * DAY },
  ], 14, now);
  assert.equal(daily.length, 14);
  assert.equal(daily[13].date, "2026-11-15");
  assert.equal(daily[13].count, 1, "今天的图必须算进来");
  assert.equal(daily[12].count, 1);
  assert.equal(daily[0].date, "2026-11-02");
  assert.equal(daily.reduce((sum, day) => sum + day.count, 0), 3, "窗口外的 14 天前那张不算");
});

test("deleteImages tolerates per-item failures and treats ENOENT as success", async () => {
  const fx = await fixture([
    { ageDays: 0, size: 10 },
    { ageDays: 0, size: 10 },
  ]);
  try {
    const result = await deleteImages([
      fx.names[0],
      fx.names[1],
      "already-gone.png",       // 文件不存在：可能刚被 prune 删了，算成功
      "../../etc/passwd",       // 非法名字：拒绝，但不影响别的
    ]);
    assert.equal(result.deleted.length, 3);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].reason, /不合法/);
    assert.equal((await scanImages({ fresh: true })).length, 0);
    // 文件真的没了
    await assert.rejects(() => stat(join(fx.dir, fx.names[0])));
  } finally {
    await cleanup(fx.root);
  }
});

test("purgeOlderThanDays only removes files past the cutoff and leaves the rest", async () => {
  const fx = await fixture([
    { ageDays: 1, size: 10 },
    { ageDays: 20, size: 10 },
    { ageDays: 40, size: 10 },
  ]);
  try {
    // 早于 10 天：20 天和 40 天那两张走人，1 天前那张留着。
    const result = await purgeOlderThanDays(10);
    assert.equal(result.deleted.length, 2);
    const left = await scanImages({ fresh: true });
    assert.equal(left.length, 1);
    assert.equal(left[0].name, fx.names[0]);
  } finally {
    await cleanup(fx.root);
  }
});

test("pruneOldImages reads the retention setting live and honours the env override", async () => {
  const fx = await fixture([
    { ageDays: 0, size: 10 },
    { ageDays: 5, size: 10 },
    { ageDays: 20, size: 10 },
  ]);
  try {
    // 默认 7 天：只清掉 20 天前那张。
    assert.deepEqual(await readImageRetentionDays(), {
      days: DEFAULT_IMAGE_RETENTION_DAYS, source: "default",
    });
    let pruned = await pruneOldImages({ force: true });
    assert.equal(pruned.deleted, 1);
    assert.equal(pruned.days, 7);

    // 改成 3 天：不用重启，下一次跑就按新值清掉 5 天前那张。
    await writeImageRetentionDays(3);
    assert.deepEqual(await readImageRetentionDays(), { days: 3, source: "settings" });
    pruned = await pruneOldImages({ force: true });
    assert.equal(pruned.deleted, 1);
    assert.equal((await scanImages({ fresh: true })).length, 1);

    // 环境变量压过设置文件。
    process.env.MAGPIE_GPTFREE_IMAGE_RETENTION_DAYS = "90";
    assert.deepEqual(await readImageRetentionDays(), { days: 90, source: "env" });

    // 非法值写不进去，也不会把已有设置改坏。
    await assert.rejects(() => writeImageRetentionDays(0), (err) => err.status === 400);
    await assert.rejects(() => writeImageRetentionDays(91), (err) => err.status === 400);
    await assert.rejects(() => writeImageRetentionDays("abc"), (err) => err.status === 400);
    delete process.env.MAGPIE_GPTFREE_IMAGE_RETENTION_DAYS;
    assert.deepEqual(await readImageRetentionDays(), { days: 3, source: "settings" });

    // 一小时内重复调用直接跳过，不重复扫目录。
    const skipped = await pruneOldImages({ force: false });
    assert.equal(skipped.skipped, true);
  } finally {
    await cleanup(fx.root);
  }
});

test("GUI image API lists, serves thumbnails, deletes and purges", async () => {
  const fx = await fixture([
    { ageDays: 0, size: 12 },
    { ageDays: 1, size: 34 },
    { ageDays: 40, size: 56 },
  ]);
  const service = createGuiService({ port: 0, poolRead: async () => [] });
  const addr = await service.listen();
  const base = "http://127.0.0.1:" + addr.port + "/";
  const page = await (await fetch(base + "ui")).text();
  const token = page.match(/name="gptfree-session" content="([0-9a-f]{64})"/)?.[1];
  const headers = { Origin: "null", "X-GPTFree-Session": token };
  const get = async (path) => {
    const response = await fetch(base + "api/" + path, { headers });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const post = async (path, body) => {
    const response = await fetch(base + "api/" + path, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  try {
    const list = await get("images?offset=0&limit=2");
    assert.equal(list.status, 200);
    assert.equal(list.json.total, 3);
    assert.equal(list.json.allCount, 3);
    assert.equal(list.json.totalBytes, 102);
    assert.equal(list.json.daily.length, 14);
    assert.deepEqual(list.json.retention, { days: 7, source: "default", locked: false });

    const namesOnly = await get("images?namesOnly=1");
    assert.equal(namesOnly.json.items.length, 3);
    assert.equal(namesOnly.json.bytes, 102);

    // 缩略图透传：同源、正确 MIME、正确长度。
    const name = list.json.items[0].name;
    const thumb = await fetch(base + "api/images/file?name=" + encodeURIComponent(name));
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get("content-type"), "image/png");
    assert.equal((await thumb.arrayBuffer()).byteLength, list.json.items[0].size);

    // 路径穿越 / 不存在的文件。
    const traversal = await fetch(base + "api/images/file?name=" + encodeURIComponent("../../etc/passwd"));
    assert.equal(traversal.status, 400);
    assert.equal((await fetch(base + "api/images/file?name=missing.png")).status, 404);

    // 删除两张：第三张和统计数字都要跟着变。
    const removed = await post("images/delete", { names: [list.json.items[0].name, list.json.items[1].name] });
    assert.equal(removed.status, 200);
    assert.equal(removed.json.deleted, 2);
    assert.equal((await fetch(base + "api/images/file?name=" + encodeURIComponent(name))).status, 404);
    const after = await get("images?limit=10");
    assert.equal(after.json.total, 1);
    assert.equal(after.json.totalBytes, 56);

    // 非法输入。
    assert.equal((await post("images/delete", { names: "nope" })).status, 400);
    assert.equal((await post("images/delete", { names: new Array(501).fill("a.png") })).status, 400);
    assert.equal((await post("images/purge", { olderThanDays: 0 })).status, 400);

    // 清理早于 10 天：只剩的那张是 40 天前的。
    const purged = await post("images/purge", { olderThanDays: 10 });
    assert.equal(purged.status, 200);
    assert.equal(purged.json.deleted, 1);
    assert.equal((await get("images?limit=10")).json.total, 0);

    // 保留天数也能从这里改，改完 list 立刻反映。
    const saved = await post("settings", { imageRetentionDays: 14 });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.imageRetention.days, 14);
    assert.equal((await get("images?limit=1")).json.retention.days, 14);
    assert.equal((await post("settings", { imageRetentionDays: 200 })).status, 400);

    // 设置文件和 vault 一样落在 poolDir 里。
    const stored = JSON.parse(await readFile(join(fx.home, "settings.json"), "utf8"));
    assert.equal(stored.imageRetentionDays, 14);
  } finally {
    await service.close();
    await cleanup(fx.root);
  }
});
