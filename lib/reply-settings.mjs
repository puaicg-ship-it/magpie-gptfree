/**
 * 图片桥回复形态的持久化设置（面板里可选，不用改环境变量）。
 *
 * 为什么不只靠环境变量：插件装在很多台机器上，每台都要 ssh 进去加一个 env 才生效，
 * 漏一台就表现不一致；改一次还要重启宿主。这里把选择存进
 * ~/.magpie-gptfree/settings.json，面板上点一下立刻生效、重启后还在。
 *
 * 环境变量仍然**优先**：不方便开面板（或要临时强制）时，
 * MAGPIE_GPTFREE_IMAGE_REPLY=both|url|markdown 会盖过文件里的值。
 *
 * 三种形态：
 *   both     内联图 + 紧跟一行裸地址（默认：看着有图，同时能复制地址）
 *   url      只有裸地址（0.8.8 的行为）
 *   markdown 只有内联图（0.8.7 的行为）
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { poolDir } from "./pool-vault.mjs";

export const IMAGE_REPLY_MODES = ["both", "url", "markdown"];
export const DEFAULT_IMAGE_REPLY_MODE = "both";

function settingsFile() {
  return join(poolDir(), "settings.json");
}

function normalize(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  return IMAGE_REPLY_MODES.includes(mode) ? mode : "";
}

/**
 * 当前生效的形态：环境变量 > 设置文件 > 默认 both。
 * 返回 { mode, source }，source 用来让面板说清楚这个值是谁定的。
 */
export async function readImageReplyMode() {
  const fromEnv = normalize(process.env.MAGPIE_GPTFREE_IMAGE_REPLY);
  if (fromEnv) return { mode: fromEnv, source: "env" };
  try {
    const saved = normalize(JSON.parse(await readFile(settingsFile(), "utf8"))?.imageReply);
    if (saved) return { mode: saved, source: "settings" };
  } catch {
    // 文件不存在、被删了一半、JSON 坏了都当没设置：用默认值，不影响出图。
  }
  return { mode: DEFAULT_IMAGE_REPLY_MODE, source: "default" };
}

/** 写进设置文件（原子替换，0600）。保留文件里其他键，以后加设置不用改这里。 */
export async function writeImageReplyMode(value) {
  const mode = normalize(value);
  if (!mode) {
    throw Object.assign(
      new Error(`不认识的回复形态：${value}（可选 ${IMAGE_REPLY_MODES.join(" / ")}）`),
      { status: 400 },
    );
  }
  const dir = poolDir();
  const file = settingsFile();
  let current = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
  } catch {}
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...current, imageReply: mode }, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
  return mode;
}
