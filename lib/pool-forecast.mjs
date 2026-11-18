/**
 * 额度耗尽预测：纯计算，不碰 I/O。
 *
 * `summarizePoolStats` 已经给每个号算了 `burnRatePerHour` 和 `etaExhaustMs`
 * （基于「上次检测时的额度」和「当前剩余额度」）。这里只做排序和截断，
 * 让面板能提前 1–2 小时看到「哪些号要打空了」，而不是等打空后才发现。
 */

/** 取最先耗尽的 N 个号。`accounts` 是 summarizePoolStats 产出的行数组。 */
export function forecastExhaustion(accounts, { nowMs = Date.now(), top = 10 } = {}) {
  const rows = [];
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const eta = Number(account?.etaExhaustMs);
    const quota = Number(account?.imageQuota);
    if (!Number.isFinite(eta) || eta <= 0) continue;
    if (!Number.isFinite(quota) || quota <= 0) continue;
    rows.push({
      slotTag: account.slotTag || "",
      slotLabel: account.slotLabel || "",
      imageQuota: quota,
      burnRatePerHour: Number.isFinite(Number(account?.burnRatePerHour))
        ? Number(account.burnRatePerHour)
        : null,
      etaExhaustMs: Math.round(eta),
      etaAt: new Date(nowMs + eta).toISOString(),
    });
  }
  rows.sort((a, b) => a.etaExhaustMs - b.etaExhaustMs);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    count: rows.length,
    items: rows.slice(0, Math.max(1, Math.round(Number(top) || 10))),
  };
}

/** 额度利用率：remaining/atCheck → 已消耗比例。没有检测快照时 ratio 为 null。 */
export function poolUtilization(quotaStats) {
  const utilization = quotaStats?.utilization || {};
  const atCheck = Number(utilization.atCheck) || 0;
  const remaining = Number(utilization.remaining) || 0;
  return {
    remaining,
    atCheck,
    ratio: atCheck > 0 ? Math.max(0, Math.min(1, 1 - remaining / atCheck)) : null,
  };
}
