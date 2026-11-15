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

  // ---------- 状态 ----------
  // 唯一数据源：/api/stats 一份快照驱动整页（统计卡、趋势、失败原因、账号表）。
  let snapshot = null;
  // 列表的筛选 / 分组 / 排序。只存在内存里：页面是沙箱页，不写任何持久存储。
  let listState = { query: "", group: "status", sort: { key: "", dir: 1 } };
  // 表格多选：选中的是界面 id（HMAC 后的），不是邮箱。
  const selectedIds = new Set();
  const collapsedGroups = new Set();
  const rowMessages = new Map();
  let deadFilter = "";
  let poolTask = null;
  let poolBusy = false;
  let historyPeriod = "day";
  let activeTab = "stats";

  // 导入流程状态
  let preview = null, previewSource = "", lastSeq = 0, polling = null, busy = false, checkingDraft = false;
  const jobStates = new Map();

  // 一次请求删/查太多号会很慢且没有反馈，按块发，每块回来就刷新一次进度。
  const BATCH_CHUNK = 20;
  // 检测/刷新比删除慢一个数量级（每个号都要打上游），批次开小一点，
  // 进度数字才动得起来：133 个号按 20 一批要 40 秒才跳一次，按 10 一批是 20 秒。
  const REFRESH_CHUNK = 10;

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

  // 上面那条只管 403（会话失效）。但服务正在重启的那几秒，端口根本不监听，
  // fetch 会直接 reject，拿不到任何状态码 —— 这种情况重开页面没有用，等它起来就行。
  // 插件宿主大约每小时重启一次，升级时也会重启，所以这段等待是常态路径，不是兜底。
  const WAKE_DELAYS = [400, 800, 1500, 2500, 4000, 6000];   // 合计约 15 秒
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // 所有等在那儿的请求共用同一个探测：状态轮询每 850ms 发一次，
  // 各等各的会把重试堆成十几条并发请求。
  let waking = null;
  function wakeService() {
    if (waking) return waking;
    waking = (async () => {
      for (const delay of WAKE_DELAYS) {
        await sleep(delay);
        try {
          await fetch("api/status", {
            headers: { "X-GPTFree-Session": session },
            cache: "no-store",
            credentials: "omit",
          });
          return true;
        } catch { /* 还没起来，接着等 */ }
      }
      return false;
    })();
    const clear = () => { waking = null; };
    waking.then(clear, clear);
    return waking;
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
  // Magpie 把这个页面装在沙箱 iframe 里（请求的 Origin 是 null），而沙箱没有
  // allow-modals 时浏览器会直接丢掉原生 confirm 并返回 false ——
  // 表现就是"点了批量删除没有任何反应"。所以确认框自己画，不用原生弹窗。
  function confirmAction({ title, message, confirmText = "确认", danger = true }) {
    return new Promise((resolve) => {
      const layer = el("div", "confirm-layer");
      layer.setAttribute("role", "dialog");
      layer.setAttribute("aria-modal", "true");
      const box = el("div", "confirm-box");
      const heading = el("h3", "confirm-title", title);
      heading.id = "confirmTitle";
      const body = el("p", "confirm-text", message);
      const actions = el("div", "confirm-actions");
      const cancel = el("button", "btn secondary", "取消");
      cancel.type = "button";
      const ok = el("button", "btn" + (danger ? " danger" : " primary"), confirmText);
      ok.type = "button";
      actions.append(cancel, ok);
      box.setAttribute("aria-labelledby", "confirmTitle");
      box.append(heading, body, actions);
      layer.append(box);
      let done = false;
      const close = (answer) => {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey, true);
        layer.remove();
        resolve(answer);
      };
      // 只接管 Esc：Enter 交给按钮自己的默认行为，避免和 click 重复触发。
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close(false);
        }
      };
      cancel.addEventListener("click", () => close(false));
      ok.addEventListener("click", () => close(true));
      layer.addEventListener("click", (event) => {
        if (event.target === layer) close(false);
      });
      document.addEventListener("keydown", onKey, true);
      document.body.append(layer);
      cancel.focus();
    });
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
    catch {
      // 读请求可以放心等：服务起来后重发一次，用户什么都感觉不到。
      // 写请求不重试 —— 连接被拒说明没送到，但失败原因拿不到，重发有重复提交的风险。
      if (data === undefined && await wakeService()) {
        return api(route, data);
      }
      throw new Error(
        data === undefined
          ? "本地服务没有响应（插件服务可能正在重启）。稍等十几秒再点一次。"
          : "本地服务没有响应（插件服务可能正在重启）。这一步没有执行，等十几秒后重试。",
      );
    }
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

  // ---------- 导入流程（与旧版一致，只换了所在 tab） ----------
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
      await refreshData({ quiet: true });
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
          notice("批量处理完成，可在「总览」查看账号与额度；没有可用账号时不会连接供应商");
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
      notice("已开始后台 HTTP 批量登录；成功账号将逐个独立同步到 Magpie Providers 供多账号使用");
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

  // ---------- 格式化 ----------
  function formatTime(iso, prefix = "更新于 ") {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : prefix + d.toLocaleString();
  }
  // 表格里的时间要窄：完整 toLocaleString 在 130px 列里会折成两行。
  function formatShortTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // 柱顶数字：三位数以上缩写，避免把 14 根柱挤爆。
  function formatCount(value) {
    const n = Number(value) || 0;
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return Math.round(n / 1000) + "k";
  }
  // 失败原因码翻译成人话。认不出来的码原样显示，至少比"失败了 84 次"有用。
  const ERROR_LABELS = {
    mfa_verify_failed_403: "MFA 验证被拦",
    unauthorized: "登录失效",
    request_timeout: "请求超时",
    timeout: "请求超时",
    worker_timeout: "生图超时（本地掐断）",
    worker_start_failed: "Worker 启动失败",
    worker_error: "Worker 调用失败",
    output_too_large: "Worker 输出过大",
    dependencies_missing: "Worker 环境缺失",
    quota_exhausted: "额度用尽",
    rate_limited: "被上游限流",
    content_policy_violation: "提示词被拒",
    invalid_image: "图片不合规",
    upstream_bad_request: "上游拒绝请求",
    upstream_error: "上游报错",
    pool_empty: "池里没有可用号",
    reauth_failed: "重新登录失败",
  };
  // 鼠标悬停时给一句人话，不然只看到 worker_timeout 这种代号没法判断要不要处理。
  const ERROR_HINTS = {
    worker_timeout: "本地 Python worker 在预算内没返回（默认单次 35 秒、整单 55 秒），多见于上游慢、号被限流或代理抖动；只记一次慢失败并自动换号，不判死",
    worker_start_failed: "Python worker 起不来，通常是首次安装没装完或缺少依赖",
    dependencies_missing: "Python worker 依赖缺失，重装插件会自动补齐",
    output_too_large: "worker 输出超过上限，多为异常返回，重试一次通常就好",
    mfa_verify_failed_403: "登录时 MFA 被上游拦截，连续 2 次会判为失效",
    unauthorized: "Token 失效，需要重新登录",
    rate_limited: "被上游限流，等额度重置后自动恢复",
    quota_exhausted: "这个号的生图额度用完了，会自动换下一个号",
    content_policy_violation: "提示词被上游安全策略拒绝，换提示词而不是换号",
  };
  function errorLabel(code) {
    if (!code) return "";
    return ERROR_LABELS[code] || code;
  }
  function errorHint(code) {
    return ERROR_HINTS[code] || "";
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
    // 倒推出来的开始时间不能装作是观测到的，前缀一个「约」。
    const approx = account?.limitedAtEstimated ? "约 " : "";
    if (account?.quotaStatus === "limited" && account?.limitedAt) {
      const reset = account.quotaResetAt ? formatTime(account.quotaResetAt, " · 预计 ") : "";
      return {
        text: `限流 ${approx}${span || "刚开始"}`,
        title: `${formatTime(account.limitedAt, `限流开始于${approx}`)}${reset}` +
          (account.limitedAtEstimated
            ? "（开始时间是从上游重置时间倒推的，不是观测值）" : ""),
      };
    }
    // 记这笔账之前就已经在限流的号：开始时间没有，别硬编一个。
    if (account?.quotaStatus === "limited") {
      const reset = formatTime(account?.quotaResetAt, "预计 ");
      return {
        text: reset ? `限流中 · ${reset}` : "限流中",
        title: "这一轮限流开始于记录功能上线之前，没有开始时间；下次进入限流会正常记录起止",
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
        pillText: "额度可用",
        statusLabel: "可用",
        quotaCell: String(account.imageQuota),
        title: "生图额度：" + account.imageQuota +
          (account.quotaCheckedAt ? "\n" + formatTime(account.quotaCheckedAt, "检测于 ") : ""),
      };
    }
    if (status === "limited") {
      return {
        cls: "bad",
        pillText: account.cooldownExpired ? "冷却到期" : "已限流",
        statusLabel: account.cooldownExpired ? "待复检" : "限流中",
        quotaCell: "0",
        title: (account.cooldownExpired
          ? "冷却时间已过，点「检测额度」可以复检一次\n"
          : "上游返回剩余额度为 0\n") +
          (account.quotaResetAt ? formatTime(account.quotaResetAt, "预计恢复 ") : "等上游重置额度"),
      };
    }
    if (status === "needs_renew") {
      return {
        cls: "warn",
        pillText: "需先续期",
        statusLabel: "需续期",
        quotaCell: typeof account.imageQuota === "number" ? String(account.imageQuota) : "—",
        title: "Token 已过期，需重新授权后再检测生图额度" +
          (typeof account.imageQuota === "number" ? "\n上次读到的生图额度：" + account.imageQuota : ""),
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
        pillText: "已失效",
        statusLabel: "已失效",
        quotaCell: "失效",
        title: why + revive,
      };
    }
    if (status === "unavailable") {
      return {
        cls: "bad",
        pillText: "额度不可用",
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
      pillText: "额度待检测",
      statusLabel: "待检测",
      quotaCell: "待检测",
      title: "尚未向 chatgpt.com 查询生图额度，点击检测/刷新获取真实额度",
    };
  }
  /**
   * Token 到底"确认"到什么程度 —— 这里只认上游的真实反馈，不拿本地解码当结论。
   *
   * 本地能做的只有解码 JWT 看 exp，那只说明"时间上没过期"，不代表 OpenAI 接受它。
   * 真正的证据只有两种：
   *   1. 额度检测真的读回了数字（读 chatgpt.com 额度必须带 Token 认证）；
   *   2. 这个号真的成功出过图。
   * 两种证据都要晚于最近一次换 Token（重新登录会刷新 updatedAt），否则说明
   * 证据是上一个 Token 的，新的还没验证过。
   */
  function tokenBadge(account) {
    if (!account.hasAccess || account.tokenState === "missing")
      return { cls: "bad", text: "无可用 Token", confirmed: false, title: "号池里没有这个账号的 access_token，需要重新导入或重新登录" };
    if (account.tokenState === "invalid")
      return { cls: "bad", text: "Token 格式异常", confirmed: false, title: "本地解析不出这个 JWT 的结构，需要重新登录" };
    if (account.tokenState === "expired")
      return { cls: "warn", text: "Token 已过期", confirmed: false, title: "本地 JWT 的 exp 已经过了；下次派活会先自动重新登录换新 Token" };
    if (account.tokenState === "not_yet_valid")
      return { cls: "warn", text: "Token 尚未生效", confirmed: false, title: "JWT 的 nbf 还没到，稍等再试" };

    const quotaMs = account.quotaError ? 0 : (Date.parse(account.quotaCheckedAt || "") || 0);
    const successMs = Date.parse(account.lastSuccessAt || "") || 0;
    const evidenceMs = Math.max(quotaMs, successMs);
    const issuedMs = Date.parse(account.updatedAt || "") || 0;
    // 换 Token 和检测之间可能差几秒，留一分钟容差。
    const confirmed = evidenceMs > 0 && evidenceMs >= issuedMs - 60000;
    if (confirmed) {
      const when = successMs >= quotaMs
        ? formatTime(account.lastSuccessAt, "出图成功于 ")
        : formatTime(account.quotaCheckedAt, "额度检测通过于 ");
      return {
        cls: "good",
        text: "Token 已确认",
        confirmed: true,
        title: "上游真实接受过这个 Token（" + when + "），不是只解码了本地 JWT。额度够不够看额度列。",
      };
    }
    const issued = issuedMs ? "这个 Token 是 " + formatTime(account.updatedAt, "") + " 换的，" : "";
    return {
      cls: "warn",
      text: "Token 未确认",
      confirmed: false,
      title: issued + "还没被上游接受过：本地只能解出它的过期时间，不代表 OpenAI 认。" +
        "点「刷新授权」会真的请求一次上游，通过后这里会变成「Token 已确认」。",
    };
  }

  // ---------- 分组 / 排序 ----------
  const POOL_GROUPS = [
    { key: "available", title: "可用", note: "有剩余生图额度" },
    { key: "limited", title: "限流中", note: "额度为 0，等上游重置" },
    { key: "unchecked", title: "待检测", note: "还没查过额度" },
    { key: "error", title: "额度查询失败", note: "多半是代理或网络不通；连续两次授权失败会自动进「已失效」" },
    { key: "renew", title: "需续期 / 无 Token", note: "Token 过期或缺失" },
    { key: "dead", title: "已失效", note: "不再派活；确认不要了可以整组删掉" },
  ];
  function poolGroupKey(account) {
    const status = account.quotaStatus;
    if (status === "dead") return "dead";
    if (status === "available") return "available";
    if (status === "limited") return "limited";
    if (status === "error") return "error";
    if (status === "unchecked") return "unchecked";
    return "renew";
  }
  function quotaNum(account) {
    return typeof account.imageQuota === "number" ? account.imageQuota : -1;
  }
  const STATUS_RANK = {
    available: 0, limited: 1, unchecked: 2, error: 3, needs_renew: 4, unavailable: 5, dead: 6,
  };
  const SORTS = {
    label: (a, b) => String(a.slotLabel || "").localeCompare(String(b.slotLabel || "")),
    plan: (a, b) => String(a.planType || "").localeCompare(String(b.planType || "")),
    status: (a, b) => (STATUS_RANK[a.quotaStatus] ?? 9) - (STATUS_RANK[b.quotaStatus] ?? 9),
    quota: (a, b) => quotaNum(a) - quotaNum(b),
    calls: (a, b) => (a.successCalls || 0) - (b.successCalls || 0),
    checked: (a, b) => (Date.parse(a.quotaCheckedAt || "") || 0) - (Date.parse(b.quotaCheckedAt || "") || 0),
    recent: (a, b) => (Date.parse(a.lastSuccessAt || "") || 0) - (Date.parse(b.lastSuccessAt || "") || 0),
    fails: (a, b) => (a.failCalls || 0) - (b.failCalls || 0),
  };
  // 下拉里的「快捷排序」和表头点击共用同一份 sort 状态。
  const SORT_PRESETS = {
    default: { key: "", dir: 1 },
    "quota-desc": { key: "quota", dir: -1 },
    "quota-asc": { key: "quota", dir: 1 },
    recent: { key: "recent", dir: -1 },
    fails: { key: "fails", dir: -1 },
    label: { key: "label", dir: 1 },
  };
  function presetOfSort(sort) {
    for (const [value, preset] of Object.entries(SORT_PRESETS)) {
      if (preset.key === sort.key && preset.dir === sort.dir) return value;
    }
    return "";
  }
  function sortedForStats(accounts) {
    const cmp = SORTS[listState.sort.key];
    if (!cmp) return accounts;
    return accounts.slice().sort((a, b) => cmp(a, b) * listState.sort.dir);
  }
  function visibleAccounts(accounts) {
    const q = listState.query.trim().toLowerCase();
    const rows = q
      ? accounts.filter((a) =>
        String(a.slotLabel || "").toLowerCase().includes(q) ||
        String(a.slotTag || "").toLowerCase().includes(q))
      : accounts.slice();
    return sortedForStats(rows);
  }
  function markSortHeaders() {
    for (const button of document.querySelectorAll(".sort-th")) {
      const on = button.dataset.sort === listState.sort.key;
      button.classList.toggle("sorted", on);
      button.classList.toggle("desc", on && listState.sort.dir < 0);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  // ---------- 数据 ----------
  function accountsOf() {
    return Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  }
  async function refreshData({ quiet = false } = {}) {
    try {
      snapshot = await api("stats");
      renderAll();
    } catch (err) {
      if (!quiet) notice(err.message, true);
      if (!snapshot) {
        $("statsRows").replaceChildren(errorRow(err.message));
        $("overviewMeta").textContent = "无法读取号池：" + err.message;
      }
    }
  }

  // ---------- 渲染 ----------
  function renderAll() {
    const accounts = accountsOf();
    $("poolCount").textContent = String(accounts.length);
    renderMeta(accounts);
    renderCards();
    renderHint();
    renderHistory(snapshot);
    renderFailBreakdown(snapshot);
    renderDeadGroups();
    syncSelection();
    renderTable();
    renderBatchBar();
  }

  function renderMeta(accounts) {
    const qs = snapshot?.quotaStats || {};
    const confirmed = accounts.filter((a) => tokenBadge(a).confirmed).length;
    if (!accounts.length) {
      $("overviewMeta").textContent = "号池暂无账号 · 点「导入账号」添加第一批";
      return;
    }
    const parts = [
      `共 ${accounts.length} 个账号`,
      `Token 已确认 ${confirmed}`,
      `可用 ${Number(qs.active ?? 0)}`,
      `限流 ${Number(qs.limited ?? 0)}`,
      `待检测 ${Number(qs.unchecked ?? 0)}`,
    ];
    if (Number(qs.errored ?? 0) > 0) parts.push(`查询失败 ${qs.errored}`);
    if (Number(qs.needsRenew ?? 0) > 0) parts.push(`需续期 ${qs.needsRenew}`);
    $("overviewMeta").textContent = parts.join(" · ");
  }

  function renderCards() {
    const qs = snapshot?.quotaStats || {};
    const accounts = accountsOf();
    const totalAccounts = Number(qs.total ?? accounts.length ?? 0);
    const activeAccounts = Number(qs.active ?? 0);
    const limitedAccounts = Number(qs.limited ?? 0);
    const uncheckedAccounts = Number(qs.unchecked ?? 0);
    const erroredAccounts = Number(qs.errored ?? 0);
    const totalQuota = Number(qs.totalQuota ?? 0);
    $("statTotalAccounts").textContent = String(totalAccounts);
    $("statActiveAccounts").textContent = String(activeAccounts);
    $("statLimitedAccounts").textContent = String(limitedAccounts);
    $("statTotalQuota").textContent = (totalAccounts && qs.checked === 0 && totalQuota === 0)
      ? (erroredAccounts > 0 ? "—" : "待检测")
      : String(totalQuota);
    $("statTotalSuccess").textContent = String(Number(qs.totalSuccess ?? 0));
    $("statTotalFail").textContent = String(Number(qs.totalFail ?? 0));
    $("statQuotaNote").textContent = uncheckedAccounts > 0
      ? `尚有 ${uncheckedAccounts} 个账号未检测额度`
      : erroredAccounts > 0
        ? `其中 ${erroredAccounts} 个账号额度查询失败`
        : "从上游状态接口读取";
  }

  function renderHint() {
    const qs = snapshot?.quotaStats || {};
    const accounts = accountsOf();
    const hint = $("statsHint");
    const totalAccounts = Number(qs.total ?? accounts.length ?? 0);
    const activeAccounts = Number(qs.active ?? 0);
    const limitedAccounts = Number(qs.limited ?? 0);
    const uncheckedAccounts = Number(qs.unchecked ?? 0);
    const erroredAccounts = Number(qs.errored ?? 0);
    if (!accounts.length) {
      hint.classList.add("hidden");
      hint.textContent = "";
    } else if (erroredAccounts > 0 && activeAccounts === 0) {
      hint.classList.remove("hidden");
      hint.textContent = "部分或全部账号查询生图额度失败：登录走 auth.openai.com，而生图额度查询需访问 chatgpt.com。请确认本机 HTTP(S) 代理可访问 chatgpt.com 后点「刷新全部额度」。";
    } else if (uncheckedAccounts > 0) {
      hint.classList.remove("hidden");
      hint.textContent = `当前有 ${uncheckedAccounts} 个账号尚未获取 chatgpt.com 生图额度，可点「刷新全部额度」实时检测（不会伪造或估算数值）。`;
    } else if (totalAccounts > 0 && limitedAccounts === totalAccounts) {
      hint.classList.remove("hidden");
      hint.textContent = "上游返回所有账号当前生图剩余额度均为 0（已限流）。请等待官方配额恢复或补充新账号。";
    } else {
      hint.classList.add("hidden");
      hint.textContent = "";
    }
  }

  // ---------- 调用趋势：按日 / 周 / 月 / 年 ----------
  // 柱子高度算的是「生图 + 文本」的总流量，柱顶把成功/失败两个数字标出来，
  // tooltip 里再把两类拆开 —— 只看一根柱的话，文本全成功、生图全失败的日子会显得一切正常。
  // 账本按天记，聚合在前端做：换粒度不用重算，也不用改存储。
  const HISTORY_VIEWS = {
    day: { label: "按日", window: 14, unit: "天" },
    week: { label: "按周", window: 12, unit: "周" },
    month: { label: "按月", window: 12, unit: "个月" },
    // 账本只留 400 天，所以「按年」最多给两年，多画的空柱子是骗人的。
    year: { label: "按年", window: 2, unit: "年" },
  };
  const ymd = (d) => [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
  function periodKeyOf(dateStr, period) {
    if (period === "year") return dateStr.slice(0, 4);
    if (period === "month") return dateStr.slice(0, 7);
    if (period !== "week") return dateStr;
    // 周一算一周的开始，和国内习惯一致。
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return ymd(d);
  }
  function historyBuckets(days, period) {
    const view = HISTORY_VIEWS[period] || HISTORY_VIEWS.day;
    const now = new Date();
    const keys = [];
    for (let i = view.window - 1; i >= 0; i--) {
      let d = new Date(now);
      if (period === "day") d.setDate(d.getDate() - i);
      else if (period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - i * 7);
      else if (period === "month") d = new Date(d.getFullYear(), d.getMonth() - i, 1);
      else d = new Date(d.getFullYear() - i, 0, 1);
      keys.push(ymd(d).slice(0, period === "year" ? 4 : period === "month" ? 7 : 10));
    }
    const map = new Map(keys.map((k) => [k, { key: k, success: 0, fail: 0, textSuccess: 0, textFail: 0 }]));
    for (const day of days) {
      const bucket = map.get(periodKeyOf(day.date, period));
      if (!bucket) continue;   // 超出当前窗口的老账，不画
      bucket.success += day.success || 0;
      bucket.fail += day.fail || 0;
      bucket.textSuccess += day.textSuccess || 0;
      bucket.textFail += day.textFail || 0;
    }
    return { view, buckets: [...map.values()] };
  }
  function bucketLabel(key, period) {
    if (period === "year") return key;
    if (period === "month") return key.slice(5) + "月";
    return key.slice(5);   // MM-DD
  }
  function bucketTitle(key, period) {
    if (period === "year") return key + " 年";
    if (period === "month") return key;
    if (period === "week") return key + " 那一周";
    return key;
  }

  function renderHistory(data) {
    const host = $("historyChart");
    const range = $("insightRange");
    const days = Array.isArray(data?.history) ? data.history : [];
    const okOf = (d) => (d.success || 0) + (d.textSuccess || 0);
    const badOf = (d) => (d.fail || 0) + (d.textFail || 0);
    host.replaceChildren();
    if (!days.length) {
      host.append(el("div", "insight-empty", "还没有调用记录"));
      range.textContent = "";
      return;
    }
    const { view, buckets } = historyBuckets(days, historyPeriod);
    const max = Math.max(1, ...buckets.map((d) => Math.max(okOf(d), badOf(d))));
    for (const bucket of buckets) {
      const wrap = el("div", "history-day");
      const bars = el("div", "history-bars");
      const okCount = okOf(bucket);
      const badCount = badOf(bucket);
      // 一组柱共用一行数字：绿色成功数 / 红色失败数。为 0 的不写，
      // 免得一排 0 把柱子本身淹掉。
      if (okCount > 0 || badCount > 0) {
        const values = el("div", "history-total");
        if (okCount > 0) values.append(el("b", "ok", formatCount(okCount)));
        if (okCount > 0 && badCount > 0) values.append(el("i", "", "/"));
        if (badCount > 0) values.append(el("b", "fail", formatCount(badCount)));
        values.title = `${bucketTitle(bucket.key, historyPeriod)} 成功 ${okCount} · 失败 ${badCount}`;
        bars.append(values);
      }
      const ok = el("div", "history-bar ok");
      ok.style.height = Math.round((okCount / max) * 100) + "%";
      ok.title = `${bucketTitle(bucket.key, historyPeriod)} 成功 ${okCount} 次（生图 ${bucket.success} · 文本 ${bucket.textSuccess}）`;
      const bad = el("div", "history-bar fail");
      bad.style.height = Math.round((badCount / max) * 100) + "%";
      bad.title = `${bucketTitle(bucket.key, historyPeriod)} 失败 ${badCount} 次（生图 ${bucket.fail} · 文本 ${bucket.textFail}）`;
      bars.append(ok, bad);
      wrap.append(bars, el("span", "", bucketLabel(bucket.key, historyPeriod)));
      host.append(wrap);
    }
    const sum = buckets.reduce((acc, b) => {
      acc.ok += okOf(b); acc.bad += badOf(b);
      acc.textOk += b.textSuccess; acc.textBad += b.textFail;
      return acc;
    }, { ok: 0, bad: 0, textOk: 0, textBad: 0 });
    const today = data?.today || {};
    range.textContent =
      `近 ${view.window} ${view.unit} 生图 ${sum.ok - sum.textOk} 成 / ${sum.bad - sum.textBad} 败` +
      ` · 文本 ${sum.textOk} 成 / ${sum.textBad} 败` +
      ` · 今天 ${today.success || 0} / ${today.fail || 0}`;
    range.title = `按${view.label.slice(1)}汇总；今天：生图 ${today.success || 0} 成 / ${today.fail || 0} 败，文本 ${today.textSuccess || 0} 成 / ${today.textFail || 0} 败`;
    host.setAttribute("aria-label", `调用趋势（${view.label}）：近 ${view.window} ${view.unit}`);
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
      label.title = errorHint(code) ? `${code} — ${errorHint(code)}` : code;
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

  function renderDeadGroups() {
    const host = $("deadGroups");
    host.replaceChildren();
    const breakdown = snapshot?.deadBreakdown || {};
    const accounts = accountsOf();
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
        deadFilter = deadFilter === group.key ? "" : group.key;
        selectedIds.clear();
        if (deadFilter) {
          for (const a of accounts) {
            if (a.deadReason === deadFilter && a.id) selectedIds.add(a.id);
          }
        }
        renderDeadGroups();
        renderTable();
        renderBatchBar();
      });
      host.append(btn);
    }
  }

  // ---------- 多选 ----------
  function syncSelection() {
    const ids = new Set(accountsOf().map((a) => a.id).filter(Boolean));
    for (const id of [...selectedIds]) {
      if (!ids.has(id)) selectedIds.delete(id);
    }
  }
  function visibleIds() {
    return visibleAccounts(accountsOf()).filter((a) => a.id).map((a) => a.id);
  }
  function togglePickAll(on) {
    const ids = visibleIds();
    if (on) for (const id of ids) selectedIds.add(id);
    else for (const id of ids) selectedIds.delete(id);
    renderTable();
    renderBatchBar();
  }
  function setGroupCollapsed(key, on) {
    if (on) collapsedGroups.add(key);
    else collapsedGroups.delete(key);
    renderTable();
    renderBatchBar();
  }

  // ---------- 统一账号表 ----------
  function errorRow(message) {
    const tr = el("tr");
    const td = el("td", "stats-empty", "无法读取号池：" + message);
    td.colSpan = 8;
    tr.append(td);
    return tr;
  }

  function accountRow(account) {
    const tr = el("tr", "account-row");
    tr.dataset.id = account.id || "";
    const q = quotaBadgeInfo(account);
    const badge = tokenBadge(account);

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
    const name = el("span", "acct-name", account.slotLabel || account.email);
    name.title = account.slotTag || account.email || "";
    nameTd.append(name);
    tr.append(nameTd);

    const planTd = el("td");
    planTd.append(el("span", "pill " + (account.planType ? "plan" : "neutral"),
      account.planType ? account.planType.toUpperCase() : "未知"));
    tr.append(planTd);

    const statusTd = el("td");
    const statusStack = el("div", "cell-stack");
    const pills = el("div", "cell-pills");
    const tokenPill = el("span", "pill " + badge.cls, badge.text);
    tokenPill.title = badge.title;
    const quotaPill = el("span", "quota-pill " + q.cls, q.pillText);
    if (q.title) quotaPill.title = q.title;
    pills.append(tokenPill, quotaPill);
    statusStack.append(pills);
    const limitNote = limitNoteText(account);
    if (limitNote) {
      const note = el("span", "cell-sub", limitNote.text);
      note.title = limitNote.title;
      statusStack.append(note);
    }
    if (account.lastErrorCode && (account.failCalls || 0) > 0) {
      const err = el("span", "cell-sub", "上次失败：" + errorLabel(account.lastErrorCode));
      err.title = account.lastErrorCode +
        (account.lastErrorAt ? " · " + formatTime(account.lastErrorAt, "发生在 ") : "") +
        (errorHint(account.lastErrorCode) ? "\n" + errorHint(account.lastErrorCode) : "");
      statusStack.append(err);
    }
    statusTd.append(statusStack);
    tr.append(statusTd);

    const quotaTd = el("td", "cell-num", q.quotaCell);
    if (q.title) quotaTd.title = q.title;
    tr.append(quotaTd);

    const callsTd = el("td", "cell-num", (account.successCalls || 0) + " / " + (account.failCalls || 0));
    if (account.lastErrorCode) {
      callsTd.title = "上次失败：" + errorLabel(account.lastErrorCode) +
        "（" + account.lastErrorCode + "）" +
        (errorHint(account.lastErrorCode) ? "\n" + errorHint(account.lastErrorCode) : "");
    }
    tr.append(callsTd);

    const checkedTd = el("td");
    const checkedStack = el("div", "cell-stack");
    const checkedText = account.quotaCheckedAt
      ? formatShortTime(account.quotaCheckedAt)
      : (account.quotaError ? "查询失败" : "尚未检测");
    const checkedSpan = el("span", "cell-muted", checkedText);
    if (account.quotaCheckedAt) checkedSpan.title = formatTime(account.quotaCheckedAt, "检测于 ");
    if (account.quotaError) checkedSpan.title = account.quotaError;
    checkedStack.append(checkedSpan);
    const message = rowMessages.get(account.id);
    if (message) checkedStack.append(el("span", "cell-sub", message));
    checkedTd.append(checkedStack);
    tr.append(checkedTd);

    const actTd = el("td");
    const actions = el("div", "row-actions");

    const checkBtn = el("button", "btn quiet row-act", "检测额度");
    checkBtn.type = "button";
    checkBtn.title = "只查这个号在 chatgpt.com 的生图剩余额度";
    checkBtn.disabled = poolBusy;
    checkBtn.addEventListener("click", () =>
      withOp(checkBtn, "检测中…", () => refreshAccounts({
        id: account.id,
        quotaOnly: true,
        force: account.tokenState !== "unexpired_unverified",
      })));

    const renewBtn = el("button", "btn quiet row-act", "刷新授权");
    renewBtn.type = "button";
    renewBtn.title = "验证 Token，过期就自动重新登录，并顺带查一次额度";
    renewBtn.disabled = poolBusy;
    renewBtn.addEventListener("click", () =>
      withOp(renewBtn, "刷新中…", () =>
        refreshAccounts({ id: account.id, force: account.tokenState !== "unexpired_unverified" })));

    const removeBtn = el("button", "btn quiet danger-text row-act", "移除");
    removeBtn.type = "button";
    let confirming = false;
    removeBtn.addEventListener("click", async () => {
      if (!confirming) {
        confirming = true;
        removeBtn.classList.add("confirming");
        removeBtn.textContent = "确认移除";
        return;
      }
      removeBtn.disabled = true;
      await withOp(removeBtn, "移除中…", async () => {
        try {
          const removed = await api("remove", { id: account.id });
          rowMessages.delete(account.id);
          selectedIds.delete(account.id);
          await refreshData({ quiet: true });
          if (removed.connectionError)
            notice("账号已移除，但 Magpie 供应商状态同步失败", true);
          else if (removed.providerConnected === false)
            notice("最后一个账号已移除，GPTFree号池已自动断开");
          else
            notice("账号已从本地号池移除，其余账号将继续轮询工作");
        } catch (err) { notice(err.message, true); removeBtn.disabled = false; }
      });
    });

    actions.append(checkBtn, renewBtn, removeBtn);
    actTd.append(actions);
    tr.append(actTd);
    return tr;
  }

  function groupHeaderRow(group, items) {
    const collapsed = collapsedGroups.has(group.key);
    const tr = el("tr", "group-row");
    tr.dataset.group = group.key;
    tr.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const th = el("th");
    th.colSpan = 8;
    const inner = el("div", "group-inner");

    const toggle = el("button", "group-toggle");
    toggle.type = "button";
    toggle.title = collapsed ? "展开这一组" : "折叠这一组";
    toggle.append(el("span", "group-caret", collapsed ? "▸" : "▾"));
    toggle.append(el("strong", "", group.title));
    toggle.append(el("span", "group-count", String(items.length)));
    toggle.addEventListener("click", () => setGroupCollapsed(group.key, !collapsed));

    const note = el("span", "group-note", group.note);
    const pickGroup = el("button", "group-pick");
    pickGroup.type = "button";
    pickGroup.textContent = "选本组";
    pickGroup.title = "把这一组的 " + items.length + " 个账号加入选择";
    pickGroup.addEventListener("click", () => {
      for (const a of items) if (a.id) selectedIds.add(a.id);
      renderTable();
      renderBatchBar();
    });

    inner.append(toggle, note, pickGroup);
    th.append(inner);
    tr.append(th);
    return tr;
  }

  function renderTable() {
    markSortHeaders();
    const tbody = $("statsRows");
    const accounts = accountsOf();
    const rows = visibleAccounts(accounts);
    const info = $("poolFilterInfo");
    if (info) {
      const parts = [];
      if (accounts.length && rows.length !== accounts.length) parts.push(`筛选出 ${rows.length} / ${accounts.length} 个`);
      const collapsed = POOL_GROUPS.filter((g) => collapsedGroups.has(g.key)).length;
      if (listState.group !== "none" && collapsed) parts.push(`已折叠 ${collapsed} 组`);
      info.textContent = parts.join(" · ");
    }
    if (!accounts.length) {
      const tr = el("tr");
      const td = el("td", "stats-empty", "号池暂无账号。切到「导入账号」贴一批账号进来，这里就会出现额度明细。");
      td.colSpan = 8;
      tr.append(td);
      tbody.replaceChildren(tr);
      return;
    }
    if (!rows.length) {
      const tr = el("tr");
      const td = el("td", "stats-empty", "没有匹配的账号 · 换个关键词试试");
      td.colSpan = 8;
      tr.append(td);
      tbody.replaceChildren(tr);
      return;
    }
    const nodes = [];
    if (listState.group === "none") {
      for (const account of rows) nodes.push(accountRow(account));
    } else {
      const buckets = new Map(POOL_GROUPS.map((g) => [g.key, []]));
      for (const account of rows) buckets.get(poolGroupKey(account)).push(account);
      for (const group of POOL_GROUPS) {
        const items = buckets.get(group.key);
        if (!items.length) continue;
        nodes.push(groupHeaderRow(group, items));
        const collapsed = collapsedGroups.has(group.key);
        for (const account of items) {
          const tr = accountRow(account);
          if (collapsed) tr.hidden = true;
          nodes.push(tr);
        }
      }
    }
    tbody.replaceChildren(...nodes);
  }

  // ---------- 批量栏与进度 ----------
  // 批量任务进行中时，页头与批量栏都显示「转圈 + 文案 + 已处理/总数」。
  function setPoolTask(next) {
    poolTask = next;
    renderBatchStatus();
  }
  // 一次操作至少亮这么久。快请求（比如只删 1 个号）几十毫秒就回来了，
  // 转圈一闪而过，用户看到的还是"点了没反应"。
  const OP_MIN_MS = 420;
  /**
   * 所有"点一下就等后端"的操作都走这里：
   *   按钮立刻换成「xx中…」并禁用 + 批量栏转圈 + 至少亮 OP_MIN_MS。
   * work 收到的 progress(patch) 可以随时更新文案和进度（批量任务用）。
   */
  async function withOp(btn, runningText, work) {
    const node = typeof btn === "string" ? $(btn) : btn;
    const idle = node ? node.textContent : "";
    const wasDisabled = node ? node.disabled : false;
    const startedAt = Date.now();
    const task = { kind: "op", label: runningText, btnText: runningText, done: 0, total: 0, node, idle };
    const progress = (patch) => { Object.assign(task, patch); renderBatchStatus(); };
    setPoolTask(task);
    try {
      return await work(progress);
    } finally {
      const left = OP_MIN_MS - (Date.now() - startedAt);
      if (left > 0) await sleep(left);
      setPoolTask(null);
      // 文案和可点状态都要自己还原：renderBatchBar 只管批量按钮，
      // 不管「刷新列表」这类普通按钮 —— 漏了它就会点一次永久变灰。
      if (node) {
        node.textContent = idle;
        node.disabled = wasDisabled;
      }
      renderBatchBar();
    }
  }
  function renderBatchStatus() {
    for (const id of ["poolBatchStatus", "batchStatus"]) {
      const host = $(id);
      if (!host) continue;
      host.replaceChildren();
      if (!poolTask) continue;
      const spin = el("span", "spin");
      spin.setAttribute("aria-hidden", "true");
      const progress = poolTask.total ? ` ${poolTask.done} / ${poolTask.total}` : "";
      host.append(spin, el("span", "", poolTask.label + progress));
    }
    // 按钮文案跟着任务走：点完立刻变成「删除中…」，而不是只有变灰。
    // withOp 传了具体按钮时以它为准（普通操作没有固定文案表）。
    if (poolTask?.node) {
      poolTask.node.textContent = poolTask.btnText || poolTask.label;
      poolTask.node.disabled = true;
      return;
    }
    const buttons = {
      poolBatchRemove: ["批量删除", "删除中…", "remove"],
      poolBatchCheck: ["批量检测额度", "检测中…", "check"],
    };
    for (const [id, [idle, running, kind]] of Object.entries(buttons)) {
      const btn = $(id);
      if (!btn) continue;
      btn.textContent = poolTask && poolTask.kind === kind ? running : idle;
    }
  }

  function renderBatchBar() {
    const n = selectedIds.size;
    const hidden = listState.group === "none"
      ? 0
      : accountsOf().filter((a) => a.id && selectedIds.has(a.id) && collapsedGroups.has(poolGroupKey(a))).length;
    const label = `已选 ${n} 个` + (hidden ? `（其中 ${hidden} 个在折叠分组内）` : "");
    if ($("poolBatchCount")) $("poolBatchCount").textContent = label;
    const ids = visibleIds();
    const picked = ids.filter((id) => selectedIds.has(id)).length;
    for (const id of ["pickAll", "poolPickAll"]) {
      const box = $(id);
      if (!box) continue;
      box.checked = ids.length > 0 && picked === ids.length;
      box.indeterminate = picked > 0 && !box.checked;
      box.disabled = poolBusy || !ids.length;
    }
    for (const id of ["poolBatchCheck", "poolBatchRemove", "poolBatchClear"]) {
      const button = $(id);
      if (button) button.disabled = poolBusy || n === 0;
    }
    renderBatchStatus();
  }

  function proxyValue() {
    return ($("poolProxyInput")?.value || $("proxyInput")?.value || "").trim();
  }

  // 按块发请求：一次删/查上百个号会卡很久而且完全没反馈，分块后每块回来就能刷新进度。
  function chunksOf(ids, size = BATCH_CHUNK) {
    const out = [];
    for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
    return out;
  }

  // ---------- 检测 / 刷新 ----------
  function setPoolBusyState(next) {
    poolBusy = next;
    const hasRows = !!$("statsRows")?.querySelector(".account-row");
    $("refreshAllPool").disabled = poolBusy || !hasRows;
    if ($("syncProviders")) $("syncProviders").disabled = poolBusy;
    if ($("refreshStatsQuota")) $("refreshStatsQuota").disabled = poolBusy || !hasRows;
    // 行内按钮也要跟着走：列表是在 poolBusy=true 时渲染的，
    // 只放开顶部按钮的话，这些「检测/刷新」会一直是灰的。
    for (const btn of document.querySelectorAll(".row-act")) btn.disabled = poolBusy;
    renderBatchBar();
  }
  // 把一批刷新结果并进汇总：分批调用时要累加，不能只看最后一批的返回值。
  function mergeRefreshTotals(totals, res) {
    totals.valid += Number(res?.valid || 0);
    totals.renewed += Number(res?.renewed || 0);
    totals.failed += Number(res?.failed || 0);
    totals.quotaChecked += Number(res?.quotaChecked || 0);
    totals.quotaFailed += Number(res?.quotaFailed || 0);
    if (res?.quotaStats) totals.quotaStats = res.quotaStats;
    if (res?.providerConnected === true) totals.providerConnected = true;
    return totals;
  }
  function applyRefreshRows(items, quotaOnly, state) {
    for (const item of items) {
      if (!item.quotaOk && !state.firstFail) {
        state.firstFail = item.quotaError || item.reason || "";
      }
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
  }
  async function refreshAccounts(payload, progress = null) {
    if (poolBusy || busy) return;
    setPoolBusyState(true);
    const quotaOnly = payload?.quotaOnly === true;
    const force = payload?.force === true;
    try {
      const proxy = proxyValue();
      // 「全部」要前端分批：服务端一次跑完上百个号要好几分钟，中途一个字都不返回，
      // 界面只能干等。分批之后每批回来就能把 12 / 100 刷出来。
      let ids = null;
      if (payload?.all === true) {
        const source = accountsOf();
        ids = source.map((a) => a.id).filter(Boolean);
        if (!ids.length) {
          notice("号池里还没有账号，先导入再检测", true);
          return;
        }
      }
      const totals = {
        valid: 0, renewed: 0, failed: 0, quotaChecked: 0, quotaFailed: 0,
        quotaStats: null, providerConnected: false, firstFail: "",
      };
      if (ids && ids.length > REFRESH_CHUNK) {
        const total = ids.length;
        const label = quotaOnly ? "正在刷新额度…" : "正在检测…";
        let done = 0;
        for (const chunk of chunksOf(ids, REFRESH_CHUNK)) {
          progress?.({ label, done, total });
          const res = await api("accounts/refresh", { ids: chunk, quotaOnly, force, proxy });
          applyRefreshRows(res.results || [], quotaOnly, totals);
          mergeRefreshTotals(totals, res);
          done += chunk.length;
          progress?.({ label, done, total });
        }
      } else {
        const body = ids ? { ids, quotaOnly, force, proxy } : { ...payload, proxy };
        const res = await api("accounts/refresh", body);
        applyRefreshRows(res.results || [], quotaOnly, totals);
        mergeRefreshTotals(totals, res);
      }
      await refreshData({ quiet: true });
      if (quotaOnly) {
        if (totals.failed > 0 && totals.quotaChecked === 0) {
          const detail = totals.firstFail || "请检查代理或账号状态";
          notice("额度检测失败：" + totals.failed + " 个账号查询失败（" + detail + "）", true);
        } else {
          const totalQ = totals.quotaStats?.totalQuota ?? 0;
          notice(`额度检测完成：已更新 ${totals.quotaChecked ?? (totals.valid + totals.renewed)} 个账号 · 当前可用总剩余额度 ${totalQ}${totals.failed ? ` · 失败 ${totals.failed} 个` : ""}`);
        }
      } else if (totals.failed > 0 && totals.renewed === 0 && totals.valid === 0) {
        notice("检测完成：" + totals.failed + " 个账号刷新失败，请检查代理或账号状态", true);
      } else if (totals.quotaFailed > 0) {
        notice(`检测完成：有效 ${totals.valid} · 续期 ${totals.renewed}（其中 ${totals.quotaFailed} 个账号生图额度查询失败，请检查 chatgpt.com 代理连通性）`);
      } else {
        const extra = totals.quotaChecked > 0 ? ` · 生图总剩余额度 ${totals.quotaStats?.totalQuota ?? 0}` : "";
        notice(`检测完成：有效 ${totals.valid} 个 · 续期 ${totals.renewed} 个 · 失败 ${totals.failed} 个${extra}`);
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
      await refreshData({ quiet: true });
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

  async function batchRefreshQuota() {
    if (poolBusy || !selectedIds.size) return;
    const ids = [...selectedIds];
    const total = ids.length;
    setPoolBusyState(true);
    let done = 0, ok = 0, bad = 0;
    await withOp("poolBatchCheck", "检测中…", async (progress) => {
      try {
        for (const chunk of chunksOf(ids, REFRESH_CHUNK)) {
          progress({ label: "正在检测额度…", done, total });
          const res = await api("accounts/refresh", { ids: chunk, quotaOnly: true, proxy: proxyValue() });
          for (const item of res.results || []) {
            if (item.quotaOk) ok++;
            else bad++;
          }
          done += chunk.length;
          progress({ label: "正在检测额度…", done, total });
        }
        notice(`已检测 ${done} 个账号，其中 ${ok} 个读到了额度${bad ? `，${bad} 个失败` : ""}`);
      } catch (err) {
        notice(`检测中断（已完成 ${done} / ${total}）：${err.message}`, true);
      } finally {
        setPoolBusyState(false);
        await refreshData({ quiet: true });
      }
    });
  }

  async function batchRemoveAccounts() {
    if (poolBusy || !selectedIds.size) return;
    const ids = [...selectedIds];
    const n = ids.length;
    const sure = await confirmAction({
      title: `删除选中的 ${n} 个账号？`,
      message: "凭据会从本机加密库里删掉，无法恢复；对应条目也会从 Magpie 的供应商列表里移除。",
      confirmText: `删除 ${n} 个`,
    });
    if (!sure) return;
    setPoolBusyState(true);
    let done = 0;
    await withOp("poolBatchRemove", "删除中…", async (progress) => {
      try {
        for (const chunk of chunksOf(ids)) {
          progress({ label: "正在删除账号…", done, total: n });
          const res = await api("remove", { ids: chunk });
          done += Number(res?.count || chunk.length);
          // 删掉一块就从选择集里摘掉，万一中途失败，剩下的还能直接重试。
          for (const id of chunk) selectedIds.delete(id);
          progress({ label: "正在删除账号…", done, total: n });
        }
        notice(`已删除 ${done} 个账号`);
      } catch (err) {
        notice(`删除中断（已删除 ${done} / ${n}）：${err.message}`, true);
      } finally {
        setPoolBusyState(false);
        await refreshData({ quiet: true });
      }
    });
  }

  // ---------- tab ----------
  function tab(next) {
    activeTab = next;
    document.querySelectorAll(".tab").forEach((button) => {
      const selected = button.dataset.tab === next;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
    });
    hidden("overviewPanel", next !== "stats");
    hidden("importPanel", next !== "import");
  }

  function setup() {
    // 两个 tab：总览（默认）/ 导入账号。data-tab 沿用 stats / import，
    // 这样 #action=manage-pool、#action=stats 两个深链不用改。
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
    // 导入页和总览页的代理框互相同步：填一次两边都生效。
    $("proxyInput").addEventListener("input", () => {
      $("poolProxyInput").value = $("proxyInput").value;
    });
    $("poolProxyInput").addEventListener("input", () => {
      $("proxyInput").value = $("poolProxyInput").value;
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

    $("refreshAccounts").addEventListener("click", () =>
      withOp("refreshAccounts", "刷新中…", () => refreshData()));
    $("refreshAllPool").addEventListener("click", () =>
      withOp("refreshAllPool", "检测中…", (progress) => refreshAccounts({ all: true }, progress)));
    $("syncProviders")?.addEventListener("click", () =>
      withOp("syncProviders", "同步中…", syncProvidersNow));
    $("refreshStatsQuota")?.addEventListener("click", () =>
      withOp("refreshStatsQuota", "刷新中…", (progress) => refreshAccounts({ all: true, quotaOnly: true }, progress)));

    // 全选：表头复选框和批量栏复选框是同一个动作，作用范围都是「当前筛选结果」。
    for (const id of ["pickAll", "poolPickAll"]) {
      $(id)?.addEventListener("change", (event) => {
        deadFilter = "";
        togglePickAll(event.target.checked);
      });
    }
    $("poolBatchCheck")?.addEventListener("click", batchRefreshQuota);
    $("poolBatchRemove")?.addEventListener("click", batchRemoveAccounts);
    $("poolBatchClear")?.addEventListener("click", () => {
      selectedIds.clear();
      deadFilter = "";
      renderDeadGroups();
      renderTable();
      renderBatchBar();
    });

    // 搜索防抖：133 行 × 8 列的节点量，逐字全量重绘会掉帧。
    let searchTimer = null;
    $("poolSearch")?.addEventListener("input", (event) => {
      const value = event.target.value || "";
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        listState.query = value;
        renderTable();
        renderBatchBar();
      }, 120);
    });
    $("poolGroupSelect")?.addEventListener("change", (event) => {
      listState.group = event.target.value === "none" ? "none" : "status";
      collapsedGroups.clear();
      renderTable();
      renderBatchBar();
    });
    $("poolSortSelect")?.addEventListener("change", (event) => {
      const preset = SORT_PRESETS[event.target.value] || SORT_PRESETS.default;
      listState.sort = { key: preset.key, dir: preset.dir };
      renderTable();
    });
    for (const button of document.querySelectorAll(".sort-th")) {
      button.addEventListener("click", () => {
        const key = button.dataset.sort;
        if (!SORTS[key]) return;
        listState.sort = listState.sort.key === key
          ? { key, dir: -listState.sort.dir }
          : { key, dir: 1 };
        // 点表头后把下拉同步过去，避免两处状态互相打脸。
        const preset = presetOfSort(listState.sort);
        if ($("poolSortSelect")) $("poolSortSelect").value = preset || "default";
        renderTable();
      });
    }
    $("historyPeriod")?.addEventListener("change", (event) => {
      historyPeriod = HISTORY_VIEWS[event.target.value] ? event.target.value : "day";
      renderHistory(snapshot);
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
        if (id === "manage-pool" || id === "stats") tab("stats");
        else if (id === "batch-import") {
          tab("import");
          loadPendingDraft();
          $("pasteAccounts").focus();
        }
      }
    });
    if (location.hash === "#action=manage-pool" || location.hash === "#action=stats") tab("stats");
    else if (location.hash === "#action=batch-import") {
      tab("import");
      $("pasteAccounts").focus();
    }
    updateLineCounter();
    setBusy(false);
    tab(activeTab);
    loadPendingDraft();
    refreshData();
    status();
  }
  setup();
})();
