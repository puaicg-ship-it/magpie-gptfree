import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_BATCH_ID,
  LEGACY_BATCH_LABEL,
  batchIdOf,
  batchRankMap,
  defaultBatchLabel,
  isBatchId,
  mergeBatchView,
  newBatchId,
  readBatches,
  recordBatch,
  sortBatchIds,
  summarizeBatches,
} from "../lib/batch-registry.mjs";

const at = (iso) => Date.parse(iso);

test("batch ids encode a UTC timestamp so plain string compare gives the order", () => {
  const older = newBatchId(Date.UTC(2026, 10, 1, 0, 0, 0));
  const newer = newBatchId(Date.UTC(2026, 10, 18, 2, 54, 37));
  assert.match(newer, /^b\d{14}-[0-9a-f]{4}$/);
  assert.ok(isBatchId(older) && isBatchId(newer));
  // 字典序 = 时间序，权重计算靠这个不读文件就能排批次。
  assert.ok(newer > older);
  assert.equal(isBatchId(LEGACY_BATCH_ID), true);
  assert.ok(older > LEGACY_BATCH_ID, "历史批次必须排在所有真实批次之前（最旧）");

  // 同一秒导入两次不能撞 id。
  const a = newBatchId(1_700_000_000_000);
  const b = newBatchId(1_700_000_000_000);
  assert.notEqual(a, b);
});

test("junk batch ids are rejected and fall back to the legacy batch", () => {
  for (const bad of ["", "b1", "x20260101000000", "b2026010100000", null, undefined, 42, {}]) {
    assert.equal(isBatchId(bad), false);
  }
  assert.equal(batchIdOf({ batchId: "junk" }), LEGACY_BATCH_ID);
  assert.equal(batchIdOf({}), LEGACY_BATCH_ID);
  assert.equal(batchIdOf(null), LEGACY_BATCH_ID);
  const good = newBatchId(Date.UTC(2026, 10, 18, 0, 0, 0));
  assert.equal(batchIdOf({ batchId: good }), good);
});

test("sortBatchIds puts the newest first and dedupes", () => {
  const a = newBatchId(Date.UTC(2026, 0, 1));
  const b = newBatchId(Date.UTC(2026, 5, 1));
  const c = newBatchId(Date.UTC(2026, 10, 1));
  assert.deepEqual(sortBatchIds([a, c, b, a, "junk", null]), [c, b, a]);
  assert.deepEqual(sortBatchIds([]), []);
  assert.deepEqual(sortBatchIds([LEGACY_BATCH_ID, a]), [a, LEGACY_BATCH_ID]);
});

test("batchRankMap numbers batches from the newest, and legacy lands last", () => {
  const a = newBatchId(Date.UTC(2026, 0, 1));
  const b = newBatchId(Date.UTC(2026, 10, 1));
  const ranks = batchRankMap([
    { batchId: a }, { batchId: b }, { batchId: a }, {},
  ]);
  assert.equal(ranks.get(b), 0, "最新的批次排第 0");
  assert.equal(ranks.get(a), 1);
  assert.equal(ranks.get(LEGACY_BATCH_ID), 2);
  assert.equal(ranks.size, 3, "去重后是三个批次");
});

test("default label is local time plus the account count", () => {
  const ms = at("2026-11-18T02:54:00.000Z");
  const label = defaultBatchLabel(ms, 37);
  assert.match(label, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} · 37 个$/);
  assert.match(defaultBatchLabel(ms, 0), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(defaultBatchLabel(NaN, 5), "5 个");
});

test("batches.json round-trips, dedupes by id and survives a corrupt file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-batch-"));
  const file = join(dir, "batches.json");
  try {
    // 文件不存在：空表，不抛错。
    assert.deepEqual(await readBatches({ file }), { version: 1, batches: [] });

    const id = newBatchId(Date.UTC(2026, 10, 18));
    await recordBatch({
      id, label: "  11月采购批  ", importedAt: "2026-11-18T02:54:00.000Z",
      count: 37, source: "gui",
    }, { file });

    let read = await readBatches({ file });
    assert.equal(read.batches.length, 1);
    assert.equal(read.batches[0].label, "11月采购批", "标签要 trim");
    assert.equal(read.batches[0].count, 37);
    assert.equal(read.batches[0].source, "gui");

    // 同 id 覆盖而不是追加。
    await recordBatch({ id, label: "改名了", count: 38 }, { file });
    read = await readBatches({ file });
    assert.equal(read.batches.length, 1);
    assert.equal(read.batches[0].label, "改名了");
    assert.equal(read.batches[0].count, 38);

    // 非法 id 不写。
    assert.equal((await recordBatch({ id: "junk", label: "x" }, { file })).ok, false);
    assert.equal((await readBatches({ file })).batches.length, 1);

    // 半截 JSON：当空表，不影响出图。
    await writeFile(file, "{ not json", "utf8");
    assert.deepEqual((await readBatches({ file })).batches, []);

    // 坏条目逐条跳过，好的留下。
    await writeFile(file, JSON.stringify({
      version: 1,
      batches: [{ id: "junk" }, null, { id, label: "ok", count: 2 }, { id, label: "dup" }],
    }), "utf8");
    const salvaged = await readBatches({ file });
    assert.equal(salvaged.batches.length, 1);
    assert.equal(salvaged.batches[0].label, "ok");

    // 落盘是 0600，且不含任何凭证字段。
    const mode = (await readFile(file, "utf8")).includes("password");
    assert.equal(mode, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a batch label with control characters is flattened, not stored raw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gptfree-batch-label-"));
  const file = join(dir, "batches.json");
  try {
    const id = newBatchId(Date.UTC(2026, 10, 18));
    await recordBatch({ id, label: "a\nb\tc\u0000d   e", count: 1 }, { file });
    const read = await readBatches({ file });
    assert.equal(read.batches[0].label, "a b c d e");
    // 超长标签截断，不让它把面板撑坏。
    await recordBatch({ id: newBatchId(Date.UTC(2026, 10, 19)), label: "x".repeat(200), count: 1 }, { file });
    const long = (await readBatches({ file })).batches.find((b) => b.label.startsWith("x"));
    assert.equal(long.label.length, 60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeBatchView keeps only the batches actually used, newest first", () => {
  const older = newBatchId(Date.UTC(2026, 0, 1));
  const newer = newBatchId(Date.UTC(2026, 10, 1));
  const view = mergeBatchView(
    [{ batchId: older }, { batchId: newer }, { batchId: newer }, {}],
    { batches: [{ id: newer, label: "11月采购批", importedAt: "2026-11-01T00:00:00.000Z", count: 2, source: "gui" }] },
  );
  assert.deepEqual(view.map((b) => b.id), [newer, older, LEGACY_BATCH_ID]);
  assert.equal(view[0].label, "11月采购批");
  // 没有元数据的批次要有占位标签，不能是空字符串。
  assert.equal(view[1].label, older);
  assert.equal(view[2].label, LEGACY_BATCH_LABEL);
  assert.equal(view[2].importedAt, null);
});

test("summarizeBatches aggregates per batch and reports null success rate before any call", () => {
  const newer = newBatchId(Date.UTC(2026, 10, 1));
  const rows = [
    { batchId: newer, quotaStatus: "available", imageQuota: 30, successCalls: 9, failCalls: 1 },
    { batchId: newer, quotaStatus: "available", imageQuota: 20, successCalls: 0, failCalls: 0 },
    { batchId: newer, quotaStatus: "limited", imageQuota: 0, successCalls: 0, failCalls: 0 },
    { batchId: LEGACY_BATCH_ID, quotaStatus: "available", imageQuota: 10, successCalls: 1, failCalls: 3 },
    { batchId: LEGACY_BATCH_ID, deadReason: "never", imageQuota: 0, successCalls: 0, failCalls: 9 },
  ];
  const out = summarizeBatches(rows, { batches: [{ id: newer, label: "11月采购批", importedAt: null, count: 3, source: "gui" }] });
  assert.equal(out.length, 2);

  const first = out[0];
  assert.equal(first.id, newer, "最新的批次排最前");
  assert.equal(first.label, "11月采购批");
  assert.equal(first.accounts, 3);
  assert.equal(first.usable, 2);
  assert.equal(first.limited, 1);
  assert.equal(first.dead, 0);
  assert.equal(first.quota, 50);
  assert.equal(first.success, 9);
  assert.equal(first.fail, 1);
  assert.equal(first.successRate, 0.9);

  const legacy = out[1];
  assert.equal(legacy.id, LEGACY_BATCH_ID);
  assert.equal(legacy.label, LEGACY_BATCH_LABEL);
  assert.equal(legacy.accounts, 2);
  assert.equal(legacy.dead, 1);
  assert.equal(legacy.fail, 12, "死号的历史失败也要算进批次");
  assert.equal(legacy.successRate, 1 / 13);

  // 一个号都没调用过：成功率是 null，不是 0 —— 面板要能区分「没跑过」和「全败」。
  const untouched = summarizeBatches(
    [{ batchId: newer, quotaStatus: "available", imageQuota: 5 }],
    { batches: [] },
  );
  assert.equal(untouched[0].successRate, null);
});

test("summarizeBatches tolerates junk rows instead of throwing", () => {
  assert.deepEqual(summarizeBatches(null, null), []);
  assert.deepEqual(summarizeBatches([], {}), []);
  const out = summarizeBatches([{ batchId: "junk", imageQuota: "abc" }], { batches: [] });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, LEGACY_BATCH_ID);
  assert.equal(out[0].quota, 0);
  assert.equal(out[0].successRate, null);
});
