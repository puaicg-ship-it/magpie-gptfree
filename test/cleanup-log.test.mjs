import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLEANUP_LOG_MAX_ENTRIES,
  appendCleanupLog,
  clearCleanupLog,
  cleanupLogFile,
  readCleanupLog,
} from "../lib/cleanup-log.mjs";
import {
  deleteImages,
  invalidateListCache,
  pruneOldImages,
  purgeOlderThanDays,
} from "../lib/image-store.mjs";

const DAY = 86400000;

/** 临时 home（日志落这里）+ 一批指定年龄的假图片。 */
async function fixture(counts = []) {
  const root = await mkdtemp(join(tmpdir(), "gptfree-cleanup-log-"));
  const home = join(root, "home");
  const dir = join(root, "images");
  process.env.MAGPIE_GPTFREE_HOME = home;
  process.env.MAGPIE_GPTFREE_IMAGE_DIR = dir;
  await mkdir(dir, { recursive: true });
  const names = [];
  const now = Date.now();
  for (const { ageDays, size } of counts) {
    const mtime = now - ageDays * DAY;
    const name = `${mtime.toString(36)}-${String(names.length).padStart(16, "0")}.png`;
    const file = join(dir, name);
    await writeFile(file, Buffer.alloc(size, 1));
    await utimes(file, new Date(mtime), new Date(mtime));
    names.push(name);
  }
  invalidateListCache();
  return { root, home, dir, names };
}

function cleanup(root) {
  delete process.env.MAGPIE_GPTFREE_HOME;
  delete process.env.MAGPIE_GPTFREE_IMAGE_DIR;
  delete process.env.MAGPIE_GPTFREE_IMAGE_RETENTION_DAYS;
  delete process.env.MAGPIE_GPTFREE_IMAGE_CLEANUP_WINDOW;
  return rm(root, { recursive: true, force: true });
}

test("清理日志：追加后新的在前，非法字段被归一化", async () => {
  const fx = await fixture();
  try {
    const at = Date.parse("2026-11-16T02:00:00");
    await appendCleanupLog({
      trigger: "auto", deleted: 3, bytes: 1024, days: 7, window: { from: 2, to: 6 },
    }, { nowMs: at });
    await appendCleanupLog({
      // 触发方式不认识 → 当 auto；负数 / 非数字 → 0；越界时段丢掉。
      trigger: "boom", deleted: "12", bytes: -5, failed: "x", days: 0, window: { from: 30, to: 3 },
    }, { nowMs: at + 1000 });

    const { total, items } = await readCleanupLog({ limit: 10 });
    assert.equal(total, 2);
    // 新的在前
    assert.equal(items[0].trigger, "auto");
    assert.equal(items[0].deleted, 12);
    assert.equal(items[0].bytes, 0, "负数按 0 处理");
    assert.equal(items[0].failed, 0);
    assert.equal(items[0].days, undefined, "0 天不写进记录");
    assert.equal(items[0].window, undefined, "越界时段丢掉");

    assert.equal(items[1].deleted, 3);
    assert.equal(items[1].bytes, 1024);
    assert.equal(items[1].days, 7);
    assert.deepEqual(items[1].window, { from: 2, to: 6 });
    assert.equal(items[1].at, new Date(at).toISOString());

    // limit 生效，但 total 仍是全量。
    const limited = await readCleanupLog({ limit: 1 });
    assert.equal(limited.items.length, 1);
    assert.equal(limited.total, 2);

    // 入参不是对象：直接忽略，不写坏文件。
    assert.equal(await appendCleanupLog(null), null);
    assert.equal((await readCleanupLog({ limit: 10 })).total, 2);
  } finally {
    await cleanup(fx.root);
  }
});

test("清理日志：超过上限只留最近 500 条", async () => {
  const fx = await fixture();
  try {
    const file = cleanupLogFile();
    await mkdir(join(fx.root, "home"), { recursive: true });
    const lines = [];
    for (let i = 0; i < CLEANUP_LOG_MAX_ENTRIES + 20; i++) {
      lines.push(JSON.stringify({
        at: new Date(Date.parse("2026-01-01T00:00:00") + i * 1000).toISOString(),
        trigger: "auto", deleted: i, bytes: 0, failed: 0,
      }));
    }
    await writeFile(file, lines.join("\n") + "\n");

    // 再写一条：总量 521 → 裁到 500，最后一条是刚写的。
    await appendCleanupLog({ trigger: "manual-delete", deleted: 1, bytes: 10 }, {
      nowMs: Date.parse("2026-02-01T00:00:00"),
    });
    const raw = await readFile(file, "utf8");
    assert.equal(raw.split("\n").filter(Boolean).length, CLEANUP_LOG_MAX_ENTRIES);

    const { total, items } = await readCleanupLog({ limit: CLEANUP_LOG_MAX_ENTRIES });
    assert.equal(total, CLEANUP_LOG_MAX_ENTRIES);
    assert.equal(items[0].trigger, "manual-delete", "最新那条必须在");
    // 521 条裁到 500：最旧的 21 条（deleted 0–20）被丢掉，所以剩下的最旧一条是 21。
    assert.equal(items[items.length - 1].deleted, 21);
  } finally {
    await cleanup(fx.root);
  }
});

test("清理日志：清空返回条数，之后读取是空", async () => {
  const fx = await fixture();
  try {
    await appendCleanupLog({ trigger: "auto", deleted: 2, bytes: 20 });
    await appendCleanupLog({ trigger: "manual-purge", deleted: 5, bytes: 50, days: 30 });
    assert.equal(await clearCleanupLog(), 2);
    assert.deepEqual(await readCleanupLog(), { total: 0, items: [] });
    // 没有文件时再清一次也不能报错。
    assert.equal(await clearCleanupLog(), 0);
  } finally {
    await cleanup(fx.root);
  }
});

test("自动清理、手动删除、手动清理各写一条，且不重复记", async () => {
  const fx = await fixture([
    { ageDays: 0, size: 10 },
    { ageDays: 20, size: 100 },
    { ageDays: 40, size: 1000 },
  ]);
  try {
    // 保留 7 天：20 天和 40 天那两张走人，记一条 auto。
    const pruned = await pruneOldImages({ force: true });
    assert.equal(pruned.deleted, 2);
    assert.equal(pruned.bytes, 1100, "释放空间要把删掉的文件大小加起来");

    let { items } = await readCleanupLog({ limit: 10 });
    assert.equal(items.length, 1);
    assert.equal(items[0].trigger, "auto");
    assert.equal(items[0].deleted, 2);
    assert.equal(items[0].bytes, 1100);
    assert.equal(items[0].days, 7);
    assert.deepEqual(items[0].window, { from: 0, to: 24 });

    // 删除选中：一条 manual-delete，带字节数。
    const removed = await deleteImages([fx.names[0]]);
    assert.equal(removed.deleted.length, 1);
    ({ items } = await readCleanupLog({ limit: 10 }));
    assert.equal(items[0].trigger, "manual-delete");
    assert.equal(items[0].deleted, 1);
    assert.equal(items[0].bytes, 10);

    // 手动清理：只记一条 manual-purge（deleteImages 那条不能重复写）。
    const before = (await readCleanupLog({ limit: 10 })).total;
    const purged = await purgeOlderThanDays(1);
    assert.equal(purged.deleted.length, 0, "图已经删光了");
    const after = await readCleanupLog({ limit: 10 });
    assert.equal(after.total, before, "没有删到东西就不该写记录");
  } finally {
    await cleanup(fx.root);
  }
});

test("手动清理早于 N 天会写一条带天数的 manual-purge", async () => {
  const fx = await fixture([
    { ageDays: 0, size: 10 },
    { ageDays: 10, size: 200 },
    { ageDays: 30, size: 3000 },
  ]);
  try {
    const purged = await purgeOlderThanDays(5);
    assert.equal(purged.deleted.length, 2);
    assert.equal(purged.bytes, 3200);

    const { items } = await readCleanupLog({ limit: 10 });
    assert.equal(items.length, 1, "不能同时写 manual-delete 和 manual-purge");
    assert.equal(items[0].trigger, "manual-purge");
    assert.equal(items[0].deleted, 2);
    assert.equal(items[0].bytes, 3200);
    assert.equal(items[0].days, 5);
  } finally {
    await cleanup(fx.root);
  }
});
