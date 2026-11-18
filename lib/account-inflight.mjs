/**
 * 单号在飞计数（跨请求共享）。
 *
 * 为什么必须有这一层：`tried` 集合只能保证**同一个请求内部**两条 lane 不撞同一个号。
 * 但 `index.mjs` 给号池的整体并发是 4，四个请求同时进来时，各自的第一条 lane
 * 完全可能挑中同一个号 —— 那个号于是被四个 worker 同时打，上游看到的是突发流量，
 * 直接 429 或者干脆卡住。排序里降权挡不住这件事：降权只影响「谁排前面」，
 * 四条 lane 各自独立排序，第一名照样是同一个。
 *
 * 所以这里是一个**进程级的 Map**，在选号那一刻查、在尝试期间持有。它只描述
 * 「此刻这个号正在被几个 worker 用」，不落盘、不参与判死、重启即清零。
 *
 * 计数必须在 `finally` 里减：worker 抛错、被 abort、被预算掐断都要减，
 * 否则一个异常就会把这个号永久钉死在「满」的状态上，再也选不到。
 */
const inflight = new Map();

function keyOf(emailOrTag) {
  if (typeof emailOrTag !== "string") return "";
  const value = emailOrTag.trim();
  return value || "";
}

/** 当前在飞数。认不出来的标识一律返回 0（当成空闲）。 */
export function accountInflight(emailOrTag) {
  const key = keyOf(emailOrTag);
  return key ? inflight.get(key) || 0 : 0;
}

/** 增减在飞数，返回增减后的值。不会出现负数。 */
export function noteAccountInflight(emailOrTag, delta) {
  const key = keyOf(emailOrTag);
  const step = Math.round(Number(delta) || 0);
  if (!key || step === 0) return accountInflight(emailOrTag);
  const next = Math.max(0, (inflight.get(key) || 0) + step);
  if (next === 0) inflight.delete(key);
  else inflight.set(key, next);
  return next;
}

/** 是否已经达到上限。`limit <= 0` 视为不限制。 */
export function isAccountSaturated(emailOrTag, limit) {
  const cap = Number(limit);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return accountInflight(emailOrTag) >= cap;
}

/** 面板 / 排查用：当前有在飞请求的号。不含邮箱，键就是调用方传进来的标识。 */
export function accountInflightSnapshot() {
  return [...inflight.entries()].map(([key, count]) => ({ key, count }));
}

export function clearAccountInflight() {
  inflight.clear();
}
