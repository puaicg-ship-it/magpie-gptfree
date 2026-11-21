/**
 * Owner-local, encrypted token pool. The key stays in the owner's home
 * directory; it is NOT a hardware-backed OS keychain. A compromise of the
 * same OS user can read both files, so we never claim otherwise.
 *
 * 0.12.10 起策略变更：**允许**持久化 refresh_token。
 *
 * 旧策略（0.9.0 ~ 0.12.x）刻意不存 refresh_token，只存 access token 加上
 * 用户提供的 email/password/TOTP，靠密码反复重登来续期。代价是：每次 access
 * token 过期都要跑一遍 Python 登录流程，而且密码必须落库。
 *
 * 现在改为存 refresh_token（`offline_access` scope 下发），续期走一次 HTTPS
 * 请求即可，密码从「必需」降级为「可选兜底」：
 *   - 浏览器 OAuth 进来的号没有密码，只有 refresh_token；
 *   - TXT 导入的号两个都有，refresh 失效时还能用密码救回来。
 *
 * id_token 仍然**不落库**：它只用于一次性解析邮箱/套餐，之后没有任何用途。
 *
 * refresh_token 会随使用轮换（rotation），拿到新的必须立刻写回，否则旧的下次
 * 就失效 —— 这是本模块唯一要求调用方严格遵守的约定。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
// 循环依赖（batch-registry 也用这里的 poolDir）是刻意的，且安全：两个方向都只在
// 函数体内取值，模块求值阶段不会碰到对方的绑定。
import { LEGACY_BATCH_ID, isBatchId } from "./batch-registry.mjs";

const NAME = "pool.enc.json";
const KEYFILE = "master.key";
const FORMAT = 1;
const MAX_RECORDS = 1000;

export function poolDir() {
  return resolve(process.env.MAGPIE_GPTFREE_HOME || join(homedir(), ".magpie-gptfree"));
}

async function machineKey(root) {
  const file = join(root, KEYFILE);
  try {
    await writeFile(file, randomBytes(32), { mode: 0o600, flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  const key = await readFile(file);
  if (key.length !== 32) throw new Error("本地号池加密密钥无效；拒绝读取凭证");
  try { await chmod(file, 0o600); } catch {}
  return key;
}

async function readUnlocked(root, key) {
  let file;
  try { file = await readFile(join(root, NAME), "utf8"); }
  catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  let blob;
  try { blob = JSON.parse(file); }
  catch { throw new Error("本地号池数据文件无法解析"); }
  if (blob?.version !== FORMAT || typeof blob?.iv !== "string" ||
      typeof blob?.tag !== "string" || typeof blob?.data !== "string")
    throw new Error("本地号池数据文件格式无效");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(blob.data, "base64")), decipher.final(),
    ]);
    const records = JSON.parse(plaintext.toString("utf8"));
    if (!Array.isArray(records) || records.length > MAX_RECORDS)
      throw new Error("invalid size");
    return records;
  } catch {
    throw new Error("本地号池解密失败；检查当前系统用户/密钥及文件完整性");
  }
}

async function storeUnlocked(root, key, rows) {
  if (rows.length > MAX_RECORDS) throw new Error("号池账号数量超过 1000");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(rows), "utf8"), cipher.final(),
  ]);
  const blob = JSON.stringify({
    version: FORMAT, iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), data: ct.toString("base64"),
  });
  const tmp = join(root, "." + NAME + "-" + randomBytes(8).toString("hex") + ".tmp");
  try {
    await writeFile(tmp, blob, { mode: 0o600, flag: "wx" });
    await rename(tmp, join(root, NAME));
    try { await chmod(join(root, NAME), 0o600); } catch {}
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

// The lock is advisory for this process; importing in more than one CLI
// simultaneously is not supported, and the README warns against it.
let pending = Promise.resolve();
async function exclusive(work) {
  const run = pending.then(work, work);
  pending = run.catch(() => {});
  return run;
}

export async function listPool({ root = poolDir() } = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rows = await readUnlocked(root, await machineKey(root));
  // 0.10.x 之前导入的记录没有 addedAt / batchId。这里补默认值而不是写回文件：
  // 读路径不产生写入，而且一旦写回，就再也分不清「真的是历史批次」和「刚刚补上的」。
  return rows.map((row) => ({
    ...row,
    addedAt: typeof row.addedAt === "string" && row.addedAt ? row.addedAt : null,
    batchId: isBatchId(row.batchId) ? row.batchId : LEGACY_BATCH_ID,
    // 0.12.x 及更早的记录没有 refreshToken（那时刻意不存）。补空串而不是 undefined，
    // 让调用方只需判断真值，不用区分「字段不存在」和「空」。
    refreshToken: typeof row.refreshToken === "string" ? row.refreshToken : "",
  }));
}

/**
 * 新增或更新一条账号。
 *
 * `addedAt`（首次入库时间）和 `batchId`（导入批次）都是**首次写入即固定**的：
 * 后面刷新授权、重新登录、重新导入同一个邮箱，都不会改它们。理由是这两个字段
 * 只描述「这个号是什么时候、跟着哪一批进来的」这个历史事实，不是当前状态；
 * 允许覆盖的话，一次重新导入就能把权重悄悄挪走。
 *
 * 要换批次只能先 removePool 再导入（那是新的一次入库，理应算新批次）。
 */
export async function upsertPool(record, { root = poolDir(), batchId = "" } = {}) {
  return exclusive(async () => {
    if (!record || typeof record.email !== "string" ||
        typeof record.accessToken !== "string" || !record.accessToken)
      throw new Error("号池记录缺少账号凭证");
    // 只校验类型和长度上限，不做格式判断 —— 格式问题留给 verifyAccessToken。
    for (const field of ["password", "totp", "refreshToken"]) {
      const value = record[field];
      if (value !== undefined && typeof value !== "string")
        throw new Error("号池记录字段类型不正确");
      if (typeof value === "string" && value.length > 16384)
        throw new Error("号池记录字段过长");
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    const key = await machineKey(root);
    const rows = await readUnlocked(root, key);
    const email = record.email.trim().toLowerCase();
    const i = rows.findIndex((r) => r.email === email);
    const existing = i >= 0 ? rows[i] : null;
    const nowIso = new Date().toISOString();
    const item = {
      email,
      // 密码/TOTP 现在是**可选兜底**：浏览器 OAuth 进来的号两个都是空串。
      // 重新导入同一个邮箱时不拿空值覆盖已有值 —— 否则一次 OAuth 登录就会把
      // 这个号的密码兜底能力抹掉，之后 refresh 一失效就只能人工重来。
      password: record.password || existing?.password || "",
      totp: record.totp || existing?.totp || "",
      accessToken: record.accessToken,
      // refresh_token 同理：没传就保留旧的。轮换后的新值由续期链路显式传入。
      refreshToken: record.refreshToken || existing?.refreshToken || "",
      // 首次入库时间。老记录没有这个字段时留 null（未知），不拿 updatedAt 冒充 ——
      // updatedAt 每次刷新授权都会被覆盖，回填出来的是「最近改动」不是「导入」。
      addedAt: existing?.addedAt || nowIso,
      // 批次号同理：老记录归到 legacy，新记录用调用方给的批次。
      batchId: existing?.batchId || (isBatchId(batchId) ? batchId : LEGACY_BATCH_ID),
      updatedAt: nowIso,
    };
    if (i < 0) rows.push(item);
    else rows[i] = item;
    await storeUnlocked(root, key, rows);
    return { updated: i >= 0, total: rows.length };
  });
}

export async function removePool(email, { root = poolDir() } = {}) {
  return exclusive(async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const key = await machineKey(root), rows = await readUnlocked(root, key);
    const kept = rows.filter((r) => r.email !== String(email).trim().toLowerCase());
    if (kept.length !== rows.length) await storeUnlocked(root, key, kept);
    return { removed: rows.length - kept.length, total: kept.length };
  });
}
