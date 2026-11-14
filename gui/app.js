// GUI runs in Magpie's sandboxed frame, with a fresh in-memory capability
// sent on every request. Never write input secrets into persistent browser
// storage, query strings, logs, or plugin options.
(() => {
  const $ = (id) => document.getElementById(id);
  const session = document.querySelector('meta[name="gptfree-session"]')?.content || "";
  const labels = {
    standard: "邮箱 + 密码 + 2FA",
    mail_link: "附邮箱链接",
    access_token: "附带 JWT Token",
  };
  const tokenLabels = {
    expired: "Token 过期 · 将自动重登",
    unexpired_unverified: "Token 待服务器验证",
    unknown: "Token 有效期未知",
    not_yet_valid: "Token 尚未生效",
  };
  const poolTokenBadges = {
    unexpired_unverified: { cls: "good", text: "Token 有效（待请求确认）" },
    expired: { cls: "warn", text: "Token 已过期（会自动重登）" },
    missing: { cls: "bad", text: "无可用 Token" },
    unknown: { cls: "warn", text: "Token 状态未知" },
    not_yet_valid: { cls: "warn", text: "Token 尚未生效" },
    invalid: { cls: "bad", text: "Token 格式异常" },
  };
  const stateLabels = {
    authorizing: "正在授权",
    added: "导入成功",
    token_reused: "Token 已验证复用",
    token_expired: "Token 过期",
    token_needs_oauth: "需要 OAuth",
    token_unverified: "需要验证",
    mail_link_ignored: "邮箱链接已识别",
    failed: "授权失败",
  };
  let preview = null, previewSource = "", lastSeq = 0, polling = null, busy = false, poolBusy = false, checkingDraft = false, activeTab = "import";
  // 表格多选：选中的是界面 id（HMAC 后的），不是邮箱。
  const selectedIds = new Set();
  let lastAccounts = [];
  let deadFilter = "";
  let lastStats = null;
  const jobStates = new Map();
  const rowMessages = new Map();
  // Magpie restarts its plugin host about once an hour (community plugin
  // auto-update). The page outlives that restart, so a request can be refused
  // with an expired page capability. Instead of leaving an error banner for the
  // rest of the session, reload the page once and let it open a fresh one.
  let reconnecting = false;
  function isSessionExpired(message) {
    return /session expired|会话已过期|session/i.test(String(message || ""));
  }
  function reconnectOnce() {
    if (reconnecting) return;
    reconnecting = true;
    notice("插件服务刚刚重启，正在自动重新连接…");
    setTimeout(() => location.reload(), 350);
  }

  function el(tag, className, content) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (content != null) n.textContent = String(content);
    return n;
  }
  function notice(message, error = false) {
    const n = $("notice");
    n.textContent = message;
    n.className = "notice" + (error ? " error" : "");
  }
  function hidden(id, yes) { $(id).classList.toggle("hidden", yes); }
  function countTextLines(text) {
    let lines = 0;
    for (const raw of String(text || "").split(/\r?\n/)) {
      const s = raw.trim();
      if (s && !s.startsWith("#") && !s.startsWith("//")) lines++;
    }
    return lines;
  }
  function updateLineCounter() {
    const n = countTextLines($("pasteAccounts").value);
    $("lineCount").textContent = n + " 行有效文本";
  }
  async function api(route, data = undefined) {
    const opts = {
      method: data === undefined ? "GET" : "POST",
      headers: { "X-GPTFree-Session": session },
      cache: "no-store",
      credentials: "omit",
    };
    if (data !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(data);
    }
    let response;
    try { response = await fetch("api/" + route, opts); }
    catch { throw new Error("无法连接本地导入服务，请重新打开 Magpie 插件页面"); }
    let json;
    try { json = await response.json(); }
    catch { throw new Error("本地服务返回无效响应"); }
    if (!response.ok) {
      const error = new Error(json.error || "操作失败");
      error.status = response.status;
      if (response.status === 403 && isSessionExpired(json.error)) reconnectOnce();
      throw error;
    }
    return json;
  }
  function hasDraftChanges() {
    return $("pasteAccounts").value !== previewSource;
  }
  function canStartImport() {
    return $("consent").checked && !!$("pasteAccounts").value.trim();
  }
  function setBusy(next) {
    busy = next;
    $("selectFile").disabled = busy;
    $("fileInput").disabled = busy;
    $("checkPaste").disabled = busy;
    $("clearPaste").disabled = busy;
    $("pasteAccounts").disabled = busy;
    $("skipInvalid").disabled = busy;
    $("proxyInput").disabled = busy;
    $("consent").disabled = busy;
    $("dropzone").classList.toggle("disabled", busy);
    $("startButton").disabled = busy || !canStartImport();
  }
  function renderPreview(rows) {
    const tbody = $("previewRows");
    const nodes = [];
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.dataset.line = row.line;
      const status = jobStates.get(row.line);
      const cols = [
        "#" + row.line, row.email,
        labels[row.format] || row.format,
        status ? stateLabels[status] || status :
          row.tokenState ? tokenLabels[row.tokenState] || "待验证" : "等待导入",
      ];
      for (const [i, val] of cols.entries()) {
        const td = el("td", i === 3 ? "status-cell" : "", val);
        tr.append(td);
      }
      nodes.push(tr);
    }
    tbody.replaceChildren(...nodes);
  }
  function renderValidation() {
    $("counts").textContent = preview.count + " 条有效 · " +
      preview.duplicates + " 条重复 · " + preview.errors.length + " 条错误";
    const box = $("validation");
    box.replaceChildren();
    if (preview.errors.length) {
      box.append(el("strong", "",
        "以下行存在格式错误，请直接在上方文本框修改对应行，或勾选「跳过格式错误行，仅导入有效账号」："));
      const ul = el("ul");
      for (const e of preview.errors.slice(0, 20))
        ul.append(el("li", "", "第 " + e.line + " 行：" + e.reason));
      box.append(ul);
      hidden("validation", false);
    } else hidden("validation", true);
    renderPreview(preview.rows);
    hidden("previewBox", false);
    setBusy(busy);
  }
  async function previewText(text, sourceLabel = "文本框内容") {
    if (!text || !text.trim()) {
      notice("请先选择 TXT 文件或在文本框输入账号列表", true);
      return false;
    }
    if (new TextEncoder().encode(text).length > 1024 * 1024) {
      notice("账号列表超过 1 MiB，请分批导入", true);
      return false;
    }
    const wasBusy = busy;
    setBusy(true);
    hidden("progressBox", true);
    jobStates.clear();
    preview = null;
    previewSource = text;
    try {
      const data = await api("preview", { text });
      preview = data;
      renderValidation();
      if (data.errors.length && !$("skipInvalid").checked) {
        notice(sourceLabel + " 已加载到文本框（发现 " + data.errors.length + " 行格式错误）：可直接编辑修改后继续，或勾选「跳过格式错误行」", true);
      } else if (data.errors.length) {
        notice(sourceLabel + " 已解析：" + data.count + " 条有效（已选择跳过 " + data.errors.length + " 条错误行），可点击「导入并授权入池」");
      } else {
        notice(sourceLabel + " 已解析（" + data.count + " 条有效），可继续在文本框微调或点击「导入并授权入池」");
      }
      return true;
    } catch (err) {
      hidden("previewBox", true);
      notice(err.message, true);
      return false;
    } finally { setBusy(wasBusy); }
  }
  async function loadText(file) {
    if (busy || !file) return;
    if (file.size > 1024 * 1024) {
      notice("请选择小于 1 MiB 的 TXT 文件", true);
      return;
    }
    if (!/\.txt$/i.test(file.name) && file.type !== "text/plain") {
      notice("请使用 TXT 文件", true);
      return;
    }
    $("fileName").textContent = file.name + " · " + Math.ceil(file.size / 1024) + " KiB（已填入下方文本框，可直接编辑）";
    const text = await file.text();
    // Put loaded file text straight into the editable textarea so malformed lines
    // can be inspected and corrected without re-uploading.
    $("pasteAccounts").value = text;
    updateLineCounter();
    $("pasteAccounts").focus();
    await previewText(text, "TXT 文件");
  }
  function addEvent(entry) {
    const div = el("div", "event");
    div.append(el("span", "event-dot " + entry.state));
    div.append(el("span", "event-account", "第 " + entry.line + " 行 · " + entry.email));
    div.append(el("span", "event-state", stateLabels[entry.state] || entry.state));
    if (entry.reason) div.append(el("span", "event-reason", entry.reason));
    $("events").prepend(div);
    if ($("events").children.length > 100) $("events").lastElementChild.remove();
    if (entry.line) jobStates.set(entry.line, entry.state);
  }
  async function status() {
    let info;
    try { info = await api("status"); }
    catch (err) { stopPolling(); notice(err.message, true); return; }
    if (info.state === "idle") return;
    const incoming = info.events || [];
    if (incoming.length && incoming.at(-1).seq < lastSeq) {
      $("events").replaceChildren();
      lastSeq = 0;
    }
    for (const entry of incoming.filter((event) => event.seq > lastSeq)) addEvent(entry);
    if (incoming.length) lastSeq = incoming.at(-1).seq;
    if (preview?.rows) renderPreview(preview.rows);
    hidden("progressBox", false);
    if (info.state === "running") {
      setBusy(true);
      if (!polling) polling = setInterval(status, 850);
    }
    $("doneCount").textContent = String(info.done || 0);
    $("addedCount").textContent = String(info.result?.added ?? info.added ?? 0);
    $("reusedCount").textContent = String(info.result?.reused ?? info.reused ?? 0);
    $("failedCount").textContent = String(info.result?.failed ?? info.failed ?? 0);
    const percent = Math.round((info.done || 0) / Math.max(1, info.total) * 100);
    $("progressFill").style.width = percent + "%";
    $("progressTrack").setAttribute("aria-valuenow", String(percent));
    $("progressCaption").textContent = (info.done || 0) + " / " + info.total + " · " +
      ({ running: "正在导入", completed: "已完成", canceled: "已取消", error: "导入异常" }[info.state] || "");
    if (info.state !== "running") {
      stopPolling();
      setBusy(false);
      hidden("cancelButton", true);
      hidden("againButton", false);
      await loadPool();
      if (activeTab === "stats") await loadStats();
      if (info.state === "completed") {
        const added = info.result?.added ?? info.added ?? 0;
        const failed = info.result?.failed ?? info.failed ?? 0;
        const skipped = info.result?.invalid ?? 0;
        const providerCount = info.providerCount ?? added;
        if (info.providerConnected === true)
          notice(`导入完成：本次新增/更新 ${added} 个账号（失败 ${failed}${skipped ? `，已跳过错误行 ${skipped}` : ""}），当前已有 ${providerCount} 个账号独立入驻 Magpie Providers`);
        else if (info.providerConnected === false)
          notice(info.message || "账号已入池，但连接 Magpie 号池失败；请检查插件状态", true);
        else
          notice("批量处理完成，可在「我的账号池」与「额度统计」查看账号与详细状态；没有可用账号时不会连接供应商");
      } else notice(info.message || "批量导入已停止，未完成的账号可稍后重试", true);
    }
  }
  function stopPolling() {
    if (polling) clearInterval(polling);
    polling = null;
  }
  async function begin() {
    if (busy || !$("consent").checked) return;
    const text = $("pasteAccounts").value;
    const skipInvalid = $("skipInvalid").checked;
    if (!text.trim()) {
      notice("请先选择 TXT 文件或在文本框输入账号", true);
      return;
    }
    if (hasDraftChanges() || !preview) {
      const ok = await previewText(text, "当前编辑文本");
      if (!ok) return;
    }
    if (!preview || !preview.count) {
      notice("没有可导入的有效账号，请检查文本框内容", true);
      return;
    }
    if (preview.errors.length && !skipInvalid) {
      $("previewBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
      notice("仍有 " + preview.errors.length + " 行格式错误：请直接在上方文本框修改，或勾选「跳过格式错误行，仅导入有效账号」", true);
      return;
    }
    setBusy(true);
    jobStates.clear();
    lastSeq = 0;
    $("events").replaceChildren();
    hidden("progressBox", false);
    hidden("againButton", true);
    hidden("cancelButton", false);
    $("progressFill").style.width = "0%";
    try {
      await api("start", {
        mode: "pool",
        consent: true,
        skipInvalid,
        proxy: $("proxyInput").value.trim(),
      });
      $("progressBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
      stopPolling();
      await status();
      notice("已开始 DSH 风格后台 HTTP 批量登录；成功账号将逐个独立同步到 Magpie Providers 供多账号使用");
    } catch (err) {
      setBusy(false);
      hidden("progressBox", true);
      notice(err.message, true);
    }
  }
  async function cancel() {
    try {
      await api("cancel", {});
      $("cancelButton").disabled = true;
      $("cancelButton").textContent = "正在停止…";
      notice("已请求停止；当前账号的授权操作正在取消");
    } catch (err) { notice(err.message, true); }
  }
  function formatTime(iso, prefix = "更新于 ") {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : prefix + d.toLocaleString();
  }
  // 失败原因码翻译成人话。认不出来的码原样显示，至少比"失败了 84 次"有用。
  const ERROR_LABELS = {
    mfa_verify_failed_403: "MFA 验证被拦",
    unauthorized: "登录失效",
    request_timeout: "请求超时",
    timeout: "请求超时",
    quota_exhausted: "额度用尽",
    rate_limited: "被上游限流",
    content_policy_violation: "提示词被拒",
    invalid_image: "图片不合规",
    upstream_bad_request: "上游拒绝请求",
    upstream_error: "上游报错",
    pool_empty: "池里没有可用号",
    reauth_failed: "重新登录失败",
  };
  function errorLabel(code) {
    if (!code) return "";
    return ERROR_LABELS[code] || code;
  }
  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    const min = Math.round(ms / 60000);
    if (min < 60) return `${min} 分钟`;
    const hours = Math.floor(min / 60);
    const rest = min % 60;
    if (hours < 24) return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
    return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
  }
  /**
   * 限流备注：正在限流就说"限流多久了"，已经恢复就说"上一轮限了多久"。
   * 数据来自 pool-stats 的 limitedAt / lastLimitedAt / recoveredAt / limitedForMs。
   */
  function limitNoteText(account) {
    const span = formatDuration(account?.limitedForMs);
    if (account?.quotaStatus === "limited" && account?.limitedAt) {
      const reset = account.quotaResetAt ? formatTime(account.quotaResetAt, " · 预计 ") : "";
      return {
        text: `限流 ${span || "刚开始"}`,
        title: `${formatTime(account.limitedAt, "限流开始于 ")}${reset}`,
      };
    }
    if (account?.recoveredAt && account?.lastLimitedAt) {
      return {
        text: `已恢复 · 上轮限流 ${span || "—"}`,
        title: `${formatTime(account.lastLimitedAt, "上轮限流开始 ")} · ${formatTime(account.recoveredAt, "恢复于 ")}` +
          (account.limitCount ? ` · 累计 ${account.limitCount} 次` : ""),
      };
    }
    return null;
  }
  function quotaBadgeInfo(account) {
    const status = account.quotaStatus || (typeof account.imageQuota === "number"
      ? (account.imageQuota === 0 ? "limited" : "available")
      : (account.quotaError ? "error" : "unchecked"));
    if (status === "available") {
      return {
        cls: "good",
        pillText: "生图额度：" + account.imageQuota,
        statusLabel: "可用",
        quotaCell: String(account.imageQuota),
        title: account.quotaCheckedAt ? formatTime(account.quotaCheckedAt, "检测于 ") : "上游返回的剩余生图额度",
      };
    }
    if (status === "limited") {
      return {
        cls: "bad",
        pillText: account.cooldownExpired ? "冷却到期 · 待检测 (0)" : "已限流 · 剩余 0",
        statusLabel: account.cooldownExpired ? "待复检" : "限流中",
        quotaCell: "0",
        title: account.quotaResetAt ? formatTime(account.quotaResetAt, "预计恢复 ") : "上游返回剩余额度为 0",
      };
    }
    if (status === "needs_renew") {
      return {
        cls: "warn",
        pillText: typeof account.imageQuota === "number"
          ? "生图额度：" + account.imageQuota + "（需续期）"
          : "生图额度：需先续期",
        statusLabel: "需续期",
        quotaCell: typeof account.imageQuota === "number" ? String(account.imageQuota) : "—",
        title: "Token 已过期，需重新授权后再检测生图额度",
      };
    }
    if (status === "dead") {
      const why = account.deadReason === "auth" ? "重新登录连续失败（多半是 MFA 被拦）"
        : account.deadReason === "never" ? `导进来一次都没成功过，已经失败 ${account.failCalls || 0} 次`
        : account.deadReason === "stale" ? "连续 3 天没有成功过一次"
        : "已被标记为失效";
      const revive = account.deadReason === "auth"
        ? " · 人工「检测额度」通过即可复活"
        : " · 重新导入凭据可复活";
      return {
        cls: "bad",
        pillText: "已失效 · 不再派活",
        statusLabel: "已失效",
        quotaCell: "失效",
        title: why + revive,
      };
    }
    if (status === "unavailable") {
      return {
        cls: "bad",
        pillText: "无可用 Token",
        statusLabel: "不可用",
        quotaCell: "—",
        title: "缺失或异常 Token，请检测/刷新授权",
      };
    }
    if (status === "error") {
      return {
        cls: "warn",
        pillText: "额度查询失败",
        statusLabel: "查询失败",
        quotaCell: "失败",
        title: account.quotaError || "查询 ChatGPT Web 生图额度失败",
      };
    }
    return {
      cls: "neutral",
      pillText: "生图额度：待检测",
      statusLabel: "待检测",
      quotaCell: "待检测",
      title: "尚未向 chatgpt.com 查询生图额度，点击检测/刷新获取真实额度",
    };
  }
  function setPoolBusyState(next) {
    poolBusy = next;
    const hasRows = !!$("poolList")?.querySelector(".account-row");
    $("refreshAllPool").disabled = poolBusy || !hasRows;
    if ($("syncProviders")) $("syncProviders").disabled = poolBusy;
    if ($("refreshStatsQuota")) $("refreshStatsQuota").disabled = poolBusy || !hasRows;
    if ($("reloadStats")) $("reloadStats").disabled = poolBusy;
  }
  async function refreshAccounts(payload) {
    if (poolBusy || busy) return;
    setPoolBusyState(true);
    try {
      const proxy = ($("poolProxyInput").value || $("statsProxyInput")?.value || $("proxyInput").value || "").trim();
      const res = await api("accounts/refresh", { ...payload, proxy });
      const quotaOnly = payload?.quotaOnly === true;
      for (const item of res.results || []) {
        if (quotaOnly) {
          if (item.quotaOk) {
            rowMessages.set(item.id, "最新生图额度：剩余 " + (item.imageQuota ?? 0));
          } else {
            rowMessages.set(item.id, "额度查询失败：" + (item.quotaError || item.reason || "请检查代理或网络"));
          }
        } else if (item.status === "valid") {
          rowMessages.set(
            item.id,
            item.quotaOk === true
              ? "上次检测：Token 有效 · 生图额度 " + (item.imageQuota ?? 0)
              : item.quotaOk === false
                ? "Token 有效 · 额度查询失败：" + (item.quotaError || "请检查代理")
                : "上次检测：有效可用",
          );
        } else if (item.status === "renewed") {
          rowMessages.set(
            item.id,
            item.quotaOk === true
              ? "已续期 Token · 生图额度 " + (item.imageQuota ?? 0)
              : item.quotaOk === false
                ? "已续期 Token · 额度查询失败：" + (item.quotaError || "请检查代理")
                : "上次刷新：已重新授权并更新 Token",
          );
        } else {
          rowMessages.set(item.id, "上次刷新失败：" + (item.reason || "请检查网络或账号状态"));
        }
      }
      if (activeTab === "stats") {
        await loadStats();
      } else {
        await loadPool();
      }
      if (quotaOnly) {
        if (res.failed > 0 && res.quotaChecked === 0) {
          const detail = res.results?.[0]?.quotaError || res.results?.[0]?.reason || "请检查代理或账号状态";
          notice("额度检测失败：" + res.failed + " 个账号查询失败（" + detail + "）", true);
        } else {
          const totalQ = res.quotaStats?.totalQuota ?? 0;
          notice(`额度检测完成：已更新 ${res.quotaChecked ?? (res.valid + res.renewed)} 个账号 · 当前可用总剩余额度 ${totalQ}${res.failed ? ` · 失败 ${res.failed} 个` : ""}`);
        }
      } else if (res.failed > 0 && res.renewed === 0 && res.valid === 0) {
        notice("检测完成：" + res.failed + " 个账号刷新失败，请检查代理或账号状态", true);
      } else if (res.quotaFailed > 0) {
        notice(`检测完成：有效 ${res.valid} · 续期 ${res.renewed}（其中 ${res.quotaFailed} 个账号生图额度查询失败，请检查 chatgpt.com 代理连通性）`);
      } else {
        const extra = res.quotaChecked > 0 ? ` · 生图总剩余额度 ${res.quotaStats?.totalQuota ?? 0}` : "";
        notice(`检测完成：有效 ${res.valid} 个 · 续期 ${res.renewed} 个 · 失败 ${res.failed} 个${extra}`);
      }
    } catch (err) {
      notice(err.message, true);
    } finally {
      setPoolBusyState(false);
    }
  }
  async function syncProvidersNow() {
    if (poolBusy || busy) return;
    setPoolBusyState(true);
    try {
      const res = await api("sync", {});
      await loadPool();
      if (res.connected)
        notice(`已将 ${res.count} 个账号分别同步到 Magpie Providers，可在 Providers 中独立勾选、设为首选与轮询`);
      else
        notice("当前号池暂无可用账号，已清理 Providers 中的空号池条目");
    } catch (err) {
      notice(err.message, true);
    } finally {
      setPoolBusyState(false);
    }
  }
  async function loadPendingDraft() {
    if (busy || checkingDraft) return;
    checkingDraft = true;
    try {
      const draft = await api("draft");
      if (!draft?.hasDraft || typeof draft.text !== "string" || busy) return;
      tab("import");
      $("pasteAccounts").value = draft.text;
      $("fileName").textContent = (draft.filename || "accounts.txt") + "（已预加载，可直接在下方编辑修正）";
      updateLineCounter();
      await previewText(draft.text, "预加载的 TXT 文件");
      $("pasteAccounts").focus();
    } catch {
      // Ignore transient errors when polling pending drafts.
    } finally {
      checkingDraft = false;
    }
  }
  // ---------- 统计：近 7 天趋势 ----------
  function renderHistory(data) {
    const host = $("historyChart");
    const range = $("insightRange");
    const days = Array.isArray(data?.history) ? data.history : [];
    host.replaceChildren();
    if (!days.length) {
      host.append(el("div", "insight-empty", "还没有调用记录"));
      range.textContent = "";
      return;
    }
    const max = Math.max(1, ...days.map((d) => Math.max(d.success || 0, d.fail || 0)));
    for (const day of days) {
      const wrap = el("div", "history-day");
      const bars = el("div", "history-bars");
      const ok = el("div", "history-bar ok");
      ok.style.height = Math.round(((day.success || 0) / max) * 100) + "%";
      ok.title = `${day.date} 成功 ${day.success} 次`;
      const bad = el("div", "history-bar fail");
      bad.style.height = Math.round(((day.fail || 0) / max) * 100) + "%";
      bad.title = `${day.date} 失败 ${day.fail} 次`;
      bars.append(ok, bad);
      wrap.append(bars, el("span", "", String(day.date).slice(5)));
      host.append(wrap);
    }
    const today = data?.today || {};
    range.textContent = `今天 ${today.success || 0} 成 / ${today.fail || 0} 败`;
  }

  function renderFailBreakdown(data) {
    const host = $("failBreakdown");
    const totalLabel = $("insightFailTotal");
    host.replaceChildren();
    const entries = Object.entries(data?.failBreakdown || {})
      .filter(([, n]) => Number(n) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 5);
    const sum = entries.reduce((acc, [, n]) => acc + Number(n), 0);
    totalLabel.textContent = sum ? `近 7 天 ${sum} 次` : "";
    if (!entries.length) {
      host.append(el("div", "insight-empty", "近 7 天没有失败记录"));
      return;
    }
    const top = Number(entries[0][1]) || 1;
    for (const [code, n] of entries) {
      const row = el("div", "fail-row");
      const label = el("div", "fail-label", errorLabel(code));
      label.title = code;
      const num = el("div", "quota-num", String(n));
      const track = el("div", "fail-track");
      const fill = el("div", "fail-fill");
      fill.style.width = Math.max(4, Math.round((Number(n) / top) * 100)) + "%";
      track.append(fill);
      row.append(label, num, track);
      host.append(row);
    }
  }

  // ---------- 失效账号分类 ----------
  const DEAD_GROUP_INFO = {
    auth: { title: "登录失效", note: "重新登录连续失败，多半是 MFA 被拦。点「检测额度」通过即可复活。" },
    never: { title: "从未成功", note: "导入后一次都没出过图，多半凭据或账号本身有问题，建议重新导入或删除。" },
    stale: { title: "三天未成功", note: "连续 72 小时没有一次成功，等它自己恢复或人工复检。" },
    marked: { title: "已标记失效", note: "被显式标记为失效。" },
  };

  function renderDeadGroups(data, accounts) {
    const host = $("deadGroups");
    host.replaceChildren();
    const breakdown = data?.deadBreakdown || {};
    const groups = Object.entries(DEAD_GROUP_INFO)
      .map(([key, info]) => ({ key, ...info, count: Number(breakdown[key] || 0) }))
      .filter((g) => g.count > 0);
    if (!groups.length) {
      host.append(el("div", "insight-empty", "当前没有失效账号。"));
      return;
    }
    for (const group of groups) {
      const btn = el("button", "dead-group");
      btn.type = "button";
      btn.setAttribute("aria-pressed", deadFilter === group.key ? "true" : "false");
      btn.title = deadFilter === group.key ? "再点一次取消选择" : "选中这一类的全部账号";
      btn.append(el("b", "", String(group.count)));
      btn.append(el("strong", "", group.title));
      btn.append(el("small", "", group.note));
      btn.addEventListener("click", () => {
        const next = deadFilter === group.key ? "" : group.key;
        deadFilter = next;
        selectedIds.clear();
        if (next) {
          for (const a of accounts) {
            if (a.deadReason === next && a.id) selectedIds.add(a.id);
          }
        }
        renderDeadGroups(data, accounts);
        renderStatsView(data);
      });
      host.append(btn);
    }
  }

  // ---------- 多选批量 ----------
  function pruneSelection(accounts) {
    lastAccounts = accounts;
    const ids = new Set(accounts.map((a) => a.id).filter(Boolean));
    for (const id of [...selectedIds]) {
      if (!ids.has(id)) selectedIds.delete(id);
    }
    renderBatchBar();
  }

  function renderBatchBar() {
    const bar = $("batchBar");
    if (!bar) return;
    const n = selectedIds.size;
    bar.classList.toggle("hidden", n === 0);
    $("batchCount").textContent = `已选 ${n} 个`;
    const all = $("pickAll");
    if (all) {
      const selectable = lastAccounts.filter((a) => a.id).length;
      all.checked = n > 0 && n === selectable;
      all.indeterminate = n > 0 && !all.checked;
    }
  }

  function statsProxy() {
    return ($("statsProxyInput")?.value || $("poolProxyInput")?.value || $("proxyInput")?.value || "").trim();
  }

  async function batchRefreshQuota() {
    if (poolBusy || !selectedIds.size) return;
    setPoolBusyState(true);
    try {
      const res = await api("accounts/refresh", {
        ids: [...selectedIds],
        quotaOnly: true,
        proxy: statsProxy(),
      });
      const ok = (res.results || []).filter((r) => r.quotaOk).length;
      notice(`已检测 ${res.results?.length || 0} 个账号，其中 ${ok} 个读到了额度`);
    } catch (err) {
      notice(err.message, true);
    } finally {
      setPoolBusyState(false);
      await loadPool();
    }
  }

  async function batchRemoveAccounts() {
    if (poolBusy || !selectedIds.size) return;
    const n = selectedIds.size;
    if (!window.confirm(`确定删除选中的 ${n} 个账号？\n凭据会从本机加密库里删掉，无法恢复。`)) return;
    setPoolBusyState(true);
    try {
      const res = await api("remove", { ids: [...selectedIds] });
      selectedIds.clear();
      notice(`已删除 ${res?.count || n} 个账号`);
    } catch (err) {
      notice(err.message, true);
    } finally {
      setPoolBusyState(false);
      await loadPool();
    }
  }

  function renderStatsView(data) {
    lastStats = data;
    const qs = data?.quotaStats || {};
    const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    const totalAccounts = Number(qs.total ?? accounts.length ?? 0);
    const activeAccounts = Number(qs.active ?? 0);
    const limitedAccounts = Number(qs.limited ?? 0);
    const uncheckedAccounts = Number(qs.unchecked ?? 0);
    const erroredAccounts = Number(qs.errored ?? 0);
    const totalQuota = Number(qs.totalQuota ?? 0);
    const totalSuccess = Number(qs.totalSuccess ?? 0);
    const totalFail = Number(qs.totalFail ?? 0);

    $("statTotalAccounts").textContent = String(totalAccounts);
    $("statActiveAccounts").textContent = String(activeAccounts);
    $("statLimitedAccounts").textContent = String(limitedAccounts);
    $("statTotalQuota").textContent = (totalAccounts && qs.checked === 0 && totalQuota === 0)
      ? (erroredAccounts > 0 ? "—" : "待检测")
      : String(totalQuota);
    $("statTotalSuccess").textContent = String(totalSuccess);
    $("statTotalFail").textContent = String(totalFail);
    $("statQuotaNote").textContent = uncheckedAccounts > 0
      ? `尚有 ${uncheckedAccounts} 个账号未检测额度`
      : erroredAccounts > 0
        ? `其中 ${erroredAccounts} 个账号额度查询失败`
        : "从上游状态接口读取";
    $("statsMeta").textContent = totalAccounts
      ? `共 ${totalAccounts} 个账号 · 可用 ${activeAccounts} · 限流 ${limitedAccounts} · 待检测 ${uncheckedAccounts}${erroredAccounts ? ` · 查询失败 ${erroredAccounts}` : ""}`
      : "号池暂无账号 · 请先在「批量导入」添加账号";

    if ($("refreshStatsQuota")) {
      $("refreshStatsQuota").disabled = poolBusy || !accounts.length;
    }

    const hint = $("statsHint");
    if (!accounts.length) {
      hint.classList.add("hidden");
      hint.textContent = "";
    } else if (erroredAccounts > 0 && activeAccounts === 0) {
      hint.classList.remove("hidden");
      hint.textContent = "部分或全部账号查询生图额度失败：登录走 auth.openai.com，而生图额度查询需访问 chatgpt.com。请确认本机 HTTP(S) 代理可访问 chatgpt.com 后点击「刷新全部额度」。";
    } else if (uncheckedAccounts > 0) {
      hint.classList.remove("hidden");
      hint.textContent = `当前有 ${uncheckedAccounts} 个账号尚未获取 chatgpt.com 生图额度，可点击右上角「刷新全部额度」实时检测（不会伪造或估算数值）。`;
    } else if (totalAccounts > 0 && limitedAccounts === totalAccounts) {
      hint.classList.remove("hidden");
      hint.textContent = "上游返回所有账号当前生图剩余额度均为 0（已限流）。请等待官方配额恢复或补充新账号。";
    } else {
      hint.classList.add("hidden");
      hint.textContent = "";
    }

    renderHistory(data);
    renderFailBreakdown(data);
    renderDeadGroups(data, accounts);
    pruneSelection(accounts);

    const tbody = $("statsRows");
    if (!accounts.length) {
      const tr = el("tr");
      const td = el("td", "stats-empty", "号池暂无账号，暂无额度统计明细。");
      td.colSpan = 8;
      tr.append(td);
      tbody.replaceChildren(tr);
      return;
    }

    const rows = [];
    for (const account of accounts) {
      const tr = el("tr");
      const q = quotaBadgeInfo(account);
      const pickTd = el("td", "pick");
      const pick = el("input");
      pick.type = "checkbox";
      pick.checked = selectedIds.has(account.id);
      pick.setAttribute("aria-label", "选择 " + (account.slotLabel || account.email));
      pick.addEventListener("change", () => {
        if (pick.checked) selectedIds.add(account.id);
        else selectedIds.delete(account.id);
        tr.classList.toggle("row-selected", pick.checked);
        renderBatchBar();
      });
      if (pick.checked) tr.classList.add("row-selected");
      pickTd.append(pick);
      tr.append(pickTd);
      const nameTd = el("td");
      nameTd.append(el("strong", "", account.slotLabel || account.email));
      tr.append(nameTd);

      const planTd = el("td");
      planTd.append(el("span", "pill " + (account.planType ? "plan" : "neutral"),
        account.planType ? account.planType.toUpperCase() : "未知"));
      tr.append(planTd);

      const statusTd = el("td");
      statusTd.append(el("span", "pill " + q.cls, q.statusLabel));
      if (account.lastErrorCode && (account.failCalls || 0) > 0) {
        const errSpan = el("span", "muted", " " + errorLabel(account.lastErrorCode));
        errSpan.title = account.lastErrorCode +
          (account.lastErrorAt ? " · " + formatTime(account.lastErrorAt, "发生在 ") : "");
        statusTd.append(errSpan);
      }
      // 什么时候被限流、限了多久、什么时候恢复 —— 就挂在状态后面。
      const limitNote = limitNoteText(account);
      if (limitNote) {
        const limitSpan = el("span", "muted", " " + limitNote.text);
        limitSpan.title = limitNote.title;
        statusTd.append(limitSpan);
      }
      tr.append(statusTd);

      const quotaTd = el("td", "quota-num", q.quotaCell);
      if (q.title) quotaTd.title = q.title;
      tr.append(quotaTd);

      const callsTd = el("td", "", (account.successCalls || 0) + " / " + (account.failCalls || 0));
      if (account.lastErrorCode) {
        callsTd.title = "上次失败：" + errorLabel(account.lastErrorCode) +
          "（" + account.lastErrorCode + "）";
      }
      tr.append(callsTd);

      const checkedText = account.quotaCheckedAt
        ? formatTime(account.quotaCheckedAt, "")
        : (account.quotaError ? "查询失败" : "尚未检测");
      const checkedTd = el("td", "muted", checkedText);
      if (account.quotaError) checkedTd.title = account.quotaError;
      tr.append(checkedTd);

      const actTd = el("td");
      const btn = el("button", "btn secondary small", "检测额度");
      btn.type = "button";
      btn.disabled = poolBusy;
      btn.addEventListener("click", async () => {
        btn.textContent = "检测中…";
        await refreshAccounts({
          id: account.id,
          quotaOnly: true,
          force: account.tokenState !== "unexpired_unverified",
        });
      });
      actTd.append(btn);
      tr.append(actTd);

      rows.push(tr);
    }
    tbody.replaceChildren(...rows);
  }
  function renderPoolView(data) {
    $("poolCount").textContent = data.total;
    const summary = data.summary || { total: data.total, valid: 0, needsRenew: 0 };
    const qs = data.quotaStats || {};
    if (data.total) {
      const quotaSeg = qs.checked > 0
        ? ` · 生图可用 ${qs.active ?? 0} · 限流 ${qs.limited ?? 0} · 剩余额度 ${qs.totalQuota ?? 0}`
        : ` · 生图额度待检测`;
      $("poolSummary").textContent =
        `共 ${summary.total} 个入池账号 · 有效 ${summary.valid} · 待续期/异常 ${summary.needsRenew}${quotaSeg}`;
    } else {
      $("poolSummary").textContent = "号池暂无账号 · 请先导入账号";
    }
    const list = $("poolList");
    list.replaceChildren();
    if (!data.accounts.length) {
      list.append(el("div", "empty", "独立号池暂无账号。请在「批量导入」选择 TXT 文件或粘贴账号批量导入。"));
      setPoolBusyState(poolBusy);
      return;
    }
    for (const account of data.accounts) {
      const item = el("div", "account-row");
      const left = el("div", "account-main");
      const head = el("div", "account-head");
      head.append(el("strong", "", account.slotLabel || account.email));
      const badge = poolTokenBadges[account.tokenState] || (account.hasAccess
        ? poolTokenBadges.unexpired_unverified
        : poolTokenBadges.missing);
      head.append(el("span", "pill " + badge.cls, badge.text));
      if (account.planType) {
        head.append(el("span", "pill plan", account.planType.toUpperCase()));
      }
      left.append(head);

      const q = quotaBadgeInfo(account);
      const usagePart = (account.successCalls || account.failCalls)
        ? `成功 ${account.successCalls || 0} / 失败 ${account.failCalls || 0}`
        : "";
      const resetPart = account.quotaResetAt ? formatTime(account.quotaResetAt, "预计恢复 ") : "";
      const checkedPart = account.quotaCheckedAt ? formatTime(account.quotaCheckedAt, "额度检测于 ") : "";
      const errPart = account.quotaError ? "额度错误：" + account.quotaError : "";
      const sub = [
        formatTime(account.updatedAt),
        checkedPart,
        resetPart,
        usagePart,
        errPart,
        rowMessages.get(account.id),
      ].filter(Boolean).join(" · ");
      left.append(el("small", "", sub || "已在 Providers 独立入驻 · 轮询与故障转移就绪 · Token 无明文显示"));
      item.append(left);

      const side = el("div", "account-side");
      const quotaPill = el("span", "quota-pill " + q.cls, q.pillText);
      if (q.title) quotaPill.title = q.title;
      side.append(quotaPill);

      const controls = el("div", "account-buttons");
      const refresh = el("button", "btn secondary small", "检测/刷新");
      refresh.type = "button";
      refresh.disabled = poolBusy;
      refresh.addEventListener("click", async () => {
        refresh.textContent = "处理中…";
        await refreshAccounts({ id: account.id, force: account.tokenState !== "unexpired_unverified" });
      });
      const remove = el("button", "btn secondary small", "移除");
      remove.type = "button";
      let confirming = false;
      remove.addEventListener("click", async () => {
        if (!confirming) {
          confirming = true;
          remove.classList.add("danger");
          remove.textContent = "确认移除";
          return;
        }
        remove.disabled = true;
        try {
          const removed = await api("remove", { id: account.id });
          rowMessages.delete(account.id);
          await loadPool();
          if (removed.connectionError)
            notice("账号已移除，但 Magpie 供应商状态同步失败", true);
          else if (removed.providerConnected === false)
            notice("最后一个账号已移除，GPT号池已自动断开");
          else
            notice("账号已从本地号池移除，其余账号将继续轮询工作");
        }
        catch (err) { notice(err.message, true); remove.disabled = false; }
      });
      controls.append(refresh, remove);
      side.append(controls);
      item.append(side);
      list.append(item);
    }
    setPoolBusyState(poolBusy);
  }
  async function loadPool() {
    try {
      const data = await api("accounts");
      renderPoolView(data);
      renderStatsView(data);
    } catch (err) {
      $("poolList").replaceChildren(el("p", "muted", "无法读取号池：" + err.message));
    }
  }
  async function loadStats() {
    try {
      const data = await api("stats");
      renderStatsView(data);
      renderPoolView({
        total: data.total,
        summary: {
          total: data.total,
          valid: (data.accounts || []).filter((a) => a.tokenState === "unexpired_unverified").length,
          needsRenew: (data.accounts || []).filter((a) => a.tokenState !== "unexpired_unverified").length,
        },
        quotaStats: data.quotaStats,
        accounts: data.accounts || [],
      });
    } catch (err) {
      $("statsMeta").textContent = "无法读取额度统计：" + err.message;
    }
  }
  function tab(next) {
    activeTab = next;
    document.querySelectorAll(".tab").forEach((button) => {
      const selected = button.dataset.tab === next;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
    });
    hidden("importPanel", next !== "import");
    hidden("poolPanel", next !== "pool");
    hidden("statsPanel", next !== "stats");
    if (next === "pool") loadPool();
    if (next === "stats") loadStats();
  }
  function setup() {
    // Always shown INSIDE Magpie's plugin frame. Choosing a file loads its
    // contents directly into #pasteAccounts so errors can be edited in place.
    document.querySelectorAll(".tab").forEach((button) =>
      button.addEventListener("click", () => tab(button.dataset.tab)));
    $("goImport").addEventListener("click", () => {
      tab("import");
      $("pasteAccounts").focus();
    });
    $("checkPaste").addEventListener("click", async () => {
      if (busy) return;
      await previewText($("pasteAccounts").value, "文本框内容");
    });
    $("clearPaste").addEventListener("click", () => {
      if (busy) return;
      $("pasteAccounts").value = "";
      preview = null;
      previewSource = "";
      jobStates.clear();
      hidden("previewBox", true);
      $("fileName").textContent = "文件内容会直接填入下方文本框；若某行格式不对可直接改好后再导入";
      updateLineCounter();
      setBusy(false);
      notice("已清空输入框");
    });
    $("pasteAccounts").addEventListener("input", () => {
      if (!$("pasteAccounts").value.trim()) {
        preview = null;
        previewSource = "";
        hidden("previewBox", true);
      }
      updateLineCounter();
      setBusy(busy);
    });
    $("skipInvalid").addEventListener("change", () => setBusy(busy));
    $("proxyInput").addEventListener("input", () => {
      const val = $("proxyInput").value;
      $("poolProxyInput").value = val;
      if ($("statsProxyInput")) $("statsProxyInput").value = val;
    });
    $("poolProxyInput").addEventListener("input", () => {
      const val = $("poolProxyInput").value;
      $("proxyInput").value = val;
      if ($("statsProxyInput")) $("statsProxyInput").value = val;
    });
    $("statsProxyInput")?.addEventListener("input", () => {
      const val = $("statsProxyInput").value;
      $("proxyInput").value = val;
      $("poolProxyInput").value = val;
    });
    $("selectFile").addEventListener("click", (event) => {
      event.stopPropagation(); $("fileInput").click();
    });
    $("dropzone").addEventListener("click", (event) => {
      if (!busy && event.target !== $("selectFile")) $("fileInput").click();
    });
    $("dropzone").addEventListener("keydown", (event) => {
      if (!busy && ["Enter", " "].includes(event.key)) { event.preventDefault(); $("fileInput").click(); }
    });
    $("fileInput").addEventListener("change", (event) => {
      loadText(event.target.files?.[0]);
      event.target.value = "";
    });
    $("dropzone").addEventListener("dragover", (event) => {
      event.preventDefault(); $("dropzone").classList.add("dragging");
    });
    $("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("dragging"));
    $("dropzone").addEventListener("drop", (event) => {
      event.preventDefault(); $("dropzone").classList.remove("dragging");
      loadText(event.dataTransfer?.files?.[0]);
    });
    $("consent").addEventListener("change", () => setBusy(busy));
    $("startButton").addEventListener("click", begin);
    $("cancelButton").addEventListener("click", cancel);
    $("againButton").addEventListener("click", () => {
      stopPolling(); preview = null; previewSource = ""; jobStates.clear();
      hidden("previewBox", true); hidden("progressBox", true);
      $("fileName").textContent = "文件内容会直接填入下方文本框；若某行格式不对可直接改好后再导入";
      $("pasteAccounts").value = "";
      updateLineCounter();
      $("cancelButton").textContent = "停止导入"; $("cancelButton").disabled = false;
      setBusy(false);
      $("pasteAccounts").focus();
      notice("文本框已清空，可以继续批量追加下一批账号到同一个号池");
    });
    $("refreshAccounts").addEventListener("click", loadPool);
    $("refreshAllPool").addEventListener("click", () => refreshAccounts({ all: true }));
    $("syncProviders")?.addEventListener("click", syncProvidersNow);
    $("refreshStatsQuota")?.addEventListener("click", () => refreshAccounts({ all: true, quotaOnly: true }));
    $("reloadStats")?.addEventListener("click", loadStats);
    $("pickAll")?.addEventListener("change", (event) => {
      selectedIds.clear();
      if (event.target.checked) {
        for (const a of lastAccounts) if (a.id) selectedIds.add(a.id);
      }
      deadFilter = "";
      if (lastStats) renderStatsView(lastStats);
      else renderBatchBar();
    });
    $("batchCheck")?.addEventListener("click", batchRefreshQuota);
    $("batchRemove")?.addEventListener("click", batchRemoveAccounts);
    $("batchClear")?.addEventListener("click", () => {
      selectedIds.clear();
      deadFilter = "";
      if (lastStats) renderStatsView(lastStats);
      else renderBatchBar();
    });
    window.addEventListener("focus", () => { loadPendingDraft(); });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) loadPendingDraft();
    });
    window.addEventListener("message", (ev) => {
      if (ev.data?.magpie !== 1) return;
      if (ev.data?.event === "visibility" && ev.data?.data?.visible === true) {
        loadPendingDraft();
        return;
      }
      if (ev.data?.event === "action") {
        const id = ev.data?.data?.id;
        if (id === "manage-pool") tab("pool");
        else if (id === "stats") tab("stats");
        else if (id === "batch-import") {
          tab("import");
          loadPendingDraft();
          $("pasteAccounts").focus();
        }
      }
    });
    if (location.hash === "#action=manage-pool") tab("pool");
    else if (location.hash === "#action=stats") tab("stats");
    else if (location.hash === "#action=batch-import") $("pasteAccounts").focus();
    updateLineCounter();
    setBusy(false);
    loadPendingDraft();
    loadPool();
    status();
  }
  setup();
})();
