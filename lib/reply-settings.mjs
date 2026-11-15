/**
 * 面板设置的持久化（不用改环境变量、不用重启宿主）。
 *
 * 为什么不只靠环境变量：插件装在很多台机器上，每台都要 ssh 进去加一个 env 才生效，
 * 漏一台就表现不一致；改一次还要重启。这里把选择存进
 * ~/.magpie-gptfree/settings.json，面板上点一下立刻生效、重启后还在。
 *
 * 环境变量仍然**优先**：不方便开面板（或要临时强制）时盖过文件里的值。
 *
 * 目前两项：
 *   imageReply          both（默认）| url | markdown —— 图片桥回复形态
 *   imageRetentionDays  1–90，默认 7 —— 图片保留天数（pruneOldImages 每次现读）
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { poolDir } from "./pool-vault.mjs";

export const IMAGE_REPLY_MODES = ["both", "url", "markdown"];
export const DEFAULT_IMAGE_REPLY_MODE = "both";

export const IMAGE_RETENTION_MIN = 1;
export const IMAGE_RETENTION_MAX = 90;
export const DEFAULT_IMAGE_RETENTION_DAYS = 7;

function settingsFile() {
  return join(poolDir(), "settings.json");
}

/** 读整个设置对象。文件不存在 / 半截 JSON / 不是对象都当空设置，不影响出图。 */
async function readSettings() {
  try {
    const parsed = JSON.parse(await readFile(settingsFile(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}

/** 原子写（0600）。只覆盖传进来的键，别的设置原样保留。 */
async function patchSettings(patch) {
  const file = settingsFile();
  const next = { ...(await readSettings()), ...patch };
  await mkdir(poolDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

function normalizeReplyMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  return IMAGE_REPLY_MODES.includes(mode) ? mode : "";
}

function normalizeRetentionDays(value) {
  if (value === null || value === undefined || value === "") return 0;
  const days = Math.round(Number(value));
  if (!Number.isFinite(days)) return 0;
  return days >= IMAGE_RETENTION_MIN && days <= IMAGE_RETENTION_MAX ? days : 0;
}

/**
 * 当前生效的回复形态：环境变量 > 设置文件 > 默认 both。
 * 返回 { mode, source }，source 用来让面板说清楚这个值是谁定的。
 */
export async function readImageReplyMode() {
  const fromEnv = normalizeReplyMode(process.env.MAGPIE_GPTFREE_IMAGE_REPLY);
  if (fromEnv) return { mode: fromEnv, source: "env" };
  const saved = normalizeReplyMode((await readSettings()).imageReply);
  if (saved) return { mode: saved, source: "settings" };
  return { mode: DEFAULT_IMAGE_REPLY_MODE, source: "default" };
}

export async function writeImageReplyMode(value) {
  const mode = normalizeReplyMode(value);
  if (!mode) {
    throw Object.assign(
      new Error(`不认识的回复形态：${value}（可选 ${IMAGE_REPLY_MODES.join(" / ")}）`),
      { status: 400 },
    );
  }
  await patchSettings({ imageReply: mode });
  return mode;
}

/** 当前生效的保留天数：环境变量 > 设置文件 > 默认 7。返回 { days, source }。 */
export async function readImageRetentionDays() {
  const fromEnv = normalizeRetentionDays(process.env.MAGPIE_GPTFREE_IMAGE_RETENTION_DAYS);
  if (fromEnv) return { days: fromEnv, source: "env" };
  const saved = normalizeRetentionDays((await readSettings()).imageRetentionDays);
  if (saved) return { days: saved, source: "settings" };
  return { days: DEFAULT_IMAGE_RETENTION_DAYS, source: "default" };
}

export async function writeImageRetentionDays(value) {
  const days = normalizeRetentionDays(value);
  if (!days) {
    throw Object.assign(
      new Error(`保留天数要在 ${IMAGE_RETENTION_MIN}–${IMAGE_RETENTION_MAX} 天之间：${value}`),
      { status: 400 },
    );
  }
  await patchSettings({ imageRetentionDays: days });
  return days;
}
