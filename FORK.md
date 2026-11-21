# 这是我们的分支，不是上游

基于上游 [`yang0/magpie-gptfree`](https://github.com/yang0/magpie-gptfree) **0.6.6 / commit `5ab9b99`**（分支 `upstream-0.6.6` 记录了基线）。

**0.8.0 起改名为 `magpie-gptpool` 独立维护**：包名、仓库、GUI 端口（`37986` → `37990`）都是自己的了；**0.8.2 起界面显示名从「GPT号池」改成「GPTFree号池」**。但下面这三样**故意不动**，改它们只有坏处没有好处：

| 不动的东西 | 为什么 |
| --- | --- |
| provider id `gptfree-pool` / marker `gptfree-local-pool-v1` | 它是 Magpie 配置里的 key，也是客户端看到的模型名前缀（`gptfree-pool/gpt-image-2`）。改了等于把所有已保存的模型名、脚本里的模型字符串一次性作废；marker 改了会让 Magpie 里已有的账号条目变成孤儿。 |
| 数据目录 `~/.magpie-gptfree/`（`MAGPIE_GPTFREE_HOME`） | 换目录 = 135 个号要重新导入（含 2FA 登录）。沿用旧目录，装上新插件就是原样接管。 |
| 环境变量前缀 `MAGPIE_GPTFREE_*` | 同上，沿用即可；文档里都按旧名写。 |

所以「换插件」的实际操作只有一步：**卸载旧的 `magpie-gptfree`，装新的 `magpie-gptpool`**，账号不动。两个不能同时装（端口不同能起来，但会共用同一份 vault 和账本，两边同时轮询会互相踩）。

- `main` = 上游 0.6.6，只用来跟上游对比。
- `patch/chat-image-bridge` = **我们的代码，仓库默认分支**。Magpie 里装这个仓，默认拿到的就是它。
- 我们自己的版本号在 `package.json` 里往上走（当前 `0.12.10`），和上游版本号不是一套；Magpie 比的是 commit，不是版本号。

## 显示名只有一个来源

界面上的名字（菜单、页面标题、供应商列表里的「GPTFree号池 (N 个账号)」）全部来自
`lib/pool-connection.mjs` 的 `POOL_DISPLAY_NAME`，`package.json` 里 `magpie.name` /
`page.title` / `actions[].title` 与之保持一致。**再改名只改这几处即可**。

坑：`index.mjs` 的 `config()` 原来是 `cfg.provider[POOL_PROVIDER] ??= {...}`，配置里已有条目时
**永远不会覆盖 name** —— 改名后界面上会一直显示旧名字。现在改成：只有当现有名字是
`GPT号池` / `GPT號池` / 空值（`isLegacyPoolName`）时才就地刷新，用户手动改过的名字不动。

## 我们改了什么

| 文件 | 改动 |
| --- | --- |
| `lib/chat-image-bridge.mjs` | **新增**。把打到 `/v1/chat/completions` 的图片模型桥到 `/images/generations` 或 `/images/edits`，PNG 落盘到 `/config/images`，回一条 `chat.completion`，正文默认是**内联图 + 紧跟一行裸地址**（`n>1` 时每张图一组、组间空一行，流式与非流式一致）。为什么两样都给：客户端「复制」复制的是正文文本，只给 markdown 的话粘到微信/文档里是一行源码；而图片是框架自己画的、没有「拷贝图像」，位图进不了剪贴板 —— 服务端只有文本这一个杠杆，所以图负责渲染、地址负责复制转发。形态在面板「回复格式」里选（`lib/reply-settings.mjs`，存 `settings.json`，重启后还在），环境变量 `MAGPIE_GPTFREE_IMAGE_REPLY` 优先、用来强制覆盖（此时面板下拉置灰并说明原因）。**0.8.10 起 `n>1` 真的出多张**：上游单次只出一张（原生接口的 `n` 是 magpie 网关在外面循环的），所以桥接层并发打 n 次、每次 `n:1`，并发上限 2（对齐 `auth.maxConcurrency`），顺序按提交顺序拼；**部分成功也返回**，只在全部失败时才报错。超时类错误映射成 400 + `code`，避免网关把一次失败重试成两次。**0.12.2 起流式响应立刻返回**：流一开就发一条 `delta:{role:"assistant"}` 的 **data 帧**（客户端解析 SSE 等的是 data 帧，注释帧它直接跳过 —— 实测只发 `: keepalive` 时客户端 5 秒就重发，一次点击生成两张图），之后每 5 秒一条注释帧续命，图好了用**同一个 id** 发内容帧和 `[DONE]`。间隔可用 `MAGPIE_GPTFREE_SSE_KEEPALIVE_MS` 调（默认 5000）。流式失败改不了状态码，按 OpenAI 惯例在流里发 error 帧再收尾 —— 附带好处是网关不会再把一次长失败重试一遍。非流式路径不变。 |
| `lib/cleanup-log.mjs` | **0.8.13 新增**。清理日志：`~/.magpie-gptfree/cleanup-log.jsonl`，一行一条，0600，只记**数量 / 字节 / 触发方式 / 参数**，不记文件名（文件名是随机 hash，记了只会让日志膨胀）。三种触发方式：`auto`（保留期定时清理）、`manual-purge`（早于 N 天）、`manual-delete`（删除选中）。追加和裁剪串行化（两个 prune 同时跑时，裁剪不能把刚写的行读漏）；每写一条读一遍文件，超过 500 条就只留最近 500 —— 写日志的频率是「每次清理一次」，读几十 KB 可以忽略，换来的是面板上「只留最近 500 条」永远是真的。半截行 / 手改坏的行跳过，不让整份日志读不出来。 |
| `lib/image-error-log.mjs` | **0.8.15 新增**。生图错误日志：`~/.magpie-gptfree/image-errors.jsonl`，一行一条，0600，只留最近 500 条。每次失败记一条，`kind` 分两种：`account`（单个号，`{ at, kind, code, tag, requestId, status, upstreamStatus, message }`）与 `request`（整单汇总，`{ at, kind, code, requestId, status, attempted, poolSize, skipped, ms, message }`，只在整单失败时写） —— 时间、账号槽位（`s<sha256前10位>`，永不落邮箱明文）、归类后的错误码、上游 HTTP 状态码、**脱敏后的上游原文**（走 `sanitizeStatsMessage`，去 token/邮箱/URL、压平换行、截断 240 字）。为什么单独一份：`pool-stats.json` 每个号只留**最后一次**失败的 code 与原文，同一个号失败第二次就盖掉了，而「上游只回了文字」这类问题的全部线索就是那句话。只在失败且账本真落盘（`statsFile` 存在）时写，内存账本（测试）不会往 home 丢文件；成功不写。追加与裁剪串行化，坏行跳过不影响整份读取。**`status` 和 `upstreamStatus` 是两个数**：前者是我们归一化后给客户端的（上游回文字时 502），后者是上游真实返回的（通常是 200）——混成一个会把「上游好好的、只是不肯画」看成「上游网关挂了」。**`request` 那条是为了让「没轮到」可见**：池子 20 个号、55 秒只够试 7 个时，`attempted=7 / poolSize=23 / skipped=16` 才不会把预算耗尽误读成「全部号都挂了」。面板能看了：设置页新增「生图错误日志」表（时间 / 账号 / 错误码 / 状态 / 上游原文，账号显示遮罩邮箱、悬停看槽位号），配 `GET /api/image-errors` 与 `POST /api/image-errors/clear`，只在切到设置页时拉一次。 |
| `lib/gui-service.mjs` | 面板本地服务（127.0.0.1:37990）：页面 + 会话能力（CSRF，落盘 24h，跨宿主重启不失效）+ 全部 `/api/*`。**0.8.10 起端口冲突会有限次退避重试**（500/1000/2000/3000ms，约 6.5 秒）—— 从面板热更新插件时新旧 host 的端口会短暂重叠，原来只 bind 一次、失败就永久打不开，只能 `docker restart` 救；只有 `EADDRINUSE` 才重试，重试次数写进错误文案由 `index.mjs` 的 warn 带出去。**0.8.11 起新增图片管理接口**：`/api/images`（分页/排序/日期筛选/统计/`namesOnly`）、`/api/images/delete`（单次上限 500）、`/api/images/purge`（早于 N 天）、`/api/images/file`（缩略图透传）。缩略图那条**不校验会话**：`<img>` 发不出自定义请求头，而端口只监听 127.0.0.1，同一批图本来就由 nginx 公开。列表接口同时回 `retention`（保留天数）与 `cleanup`（自动清理时段），两者都带 `source` / `locked`；`listen()` 时还会挂一个 15 分钟的清理定时器（`close()` 里清掉）。**0.8.13 起**：新增 `/api/images/cleanup-log`（读取）与 `/api/images/cleanup-log/clear`（清空）；`/api/stats` 也带上 `imageRetention` / `imageCleanup` —— 设置页是独立 tab，用户可能一次都没进过图片页，不能等 `/api/images` 才拿到这两个值。**0.8.15 起**：新增 `/api/image-errors`（读，`limit` 上限 500）与 `/api/image-errors/clear`（清空），面板设置页的「生图错误日志」用它。**0.10.0 起端口冲突不再永久放弃**：前台退避重试失败后挂一层后台守护（`scheduleGuiGuard`），按间隔继续尝试直到端口空出来（默认 60 秒窗口），日志节流、定时器 `unref()`；新增 `stopGuiServer()` 供测试和插件卸载用。**同一版新增运行面板接口**：`/api/dashboard`（容量 + 15 分钟指标 + 活跃度 + 额度预测 + 最近 30 条日志，一条数据流）、`/api/requests?since=&limit=`（按 `seq` 游标增量拉，纯内存）、`/api/requests/clear`；`/api/health` 增加 `p95ImageMs` / `inflight`，**判定 `ok` 的条件不变**（监控脚本不用改）。**0.10.1 起**：`/api/stats` 下发 `batches`（`mergeBatchView`：只列账号实际用到的批次，缺元数据的补占位），`/api/dashboard` 下发按批次聚合的 `batches`（`summarizeBatches`）。标签只在接口里给一次，账本每行只带 `batchId`，不在每个号上复制标签。**0.11.0 起**：`buildAccountsSnapshot` 用 `pool-weight` 现算每行的 `autoTier`/`effectiveTier`/`effectiveWeight`（**不塞进 pool-stats** —— 那是策略问题，pool-stats 只管存储聚合）；新增 `GET/POST /api/policy`（GET 附带账本里真实观测到的 feature 名，供面板做下拉）与 `POST /api/accounts/policy`（批量设分级/倍率）。 **0.12.5 起 `close()` 先落盘再返回**：去掉 `if (!server.listening) return` 的早退，并在返回前 `await savingSessions` —— 会话文件是链式异步写的，不等就可能丢掉最后一次写（丢的是「重启后页面还能用」的 capability，不是账号）。**0.12.6 起**新增 `GET /api/logs`（池事件 ring，支持 `since` / `kind` / `limit`），`POST /api/policy` 写一条 `policy.change` 事件、且只在动了 `sweep` 时才重排定时器（rotation 是每请求现读的）。**0.12.7 起**面板多一个「日志」页签：池事件 / 请求 / 生图错误 / 清理四路合成一条时间轴，原来的清理日志与生图错误明细表也搬了过去。 |
| `lib/image-store.mjs` | **0.8.11 新增**。图片目录的唯一入口：文件名白名单 `^[A-Za-z0-9._-]+\.(png\|jpg\|jpeg\|webp\|gif)$` + `resolve()` 后前缀校验（挡 `../`）、`listImages` 分页与统计、`dailyCounts` 按**本地日期**分桶（用 `getFullYear/getMonth/getDate`，不能用 `toISOString()`，那是 UTC）、`deleteImages` 逐条容错（ENOENT 算成功）、`purgeOlderThanDays`、`pruneOldImages`（每次现读保留天数与清理时段）。目录扫描有 30 秒缓存，删除/落盘后主动失效。**清理时段**：`inCleanupWindow()` 按本地小时判断，`from > to` 视为跨午夜（22→6）；`pruneOldImages` 在时段外直接返回 `{ skipped: true, reason: "window" }`，`force: true` 是手动补跑用的、连时段一起绕过。**另外导出 `startCleanupTimer()`**（15 分钟一跳，`unref()`）——光靠「生图之后顺手清」的话，夜里没人用就永远不会执行，设了时段等于设了个不生效的开关。**0.8.13 起三个删除入口都会写清理日志**：`deleteImages(names, { trigger })` 默认记 `manual-delete`，`purgeOlderThanDays` 传 `trigger: null` 自己记一条带天数的 `manual-purge`（否则会重复两条），`pruneOldImages` 记 `auto`；顺带先 `stat` 出大小再删，返回值多了 `bytes`。日志写完才返回（`appendCleanupLog` 自己吞错），避免「刚删完就看日志」偶发看不到那条。 |
| `lib/reply-settings.mjs` | **0.8.9 新增，0.8.11 扩展**。回复形态（`imageReply.mode`）、图片保留天数（`imageRetentionDays`，1–90）、清理时段（`imageCleanupWindow`，`{ from, to }` 小时区间，默认 `0-24` 全天）读写 `~/.magpie-gptfree/settings.json`；原子写（tmp + rename，0600）并保留其它键。**环境变量优先于面板设置**，返回值带 `source: env\|settings\|default`，env 压着时面板置灰只读。 |
| `lib/codex-pool.mjs` | 选号改成**额度加权轮转**（nginx smooth WRR，持久化 credit）+ **熔断**（连续失败指数退避 10min→1h）。判死号排到兜底队列最后。图片路径把失败原因分成"请求的错"和"账号的错"。额度打到 0、上游重置时间过后**自动后台复检**（禁用重新登录，绝不触发 MFA）。**0.8.15 起**生图失败时在 `onAccountResult` 里顺手写一条 `lib/image-error-log.mjs` 的错误日志（`await` 等它写完，一次失败多几毫秒无所谓，但「日志里一定有这条」很重要）。**0.9.0 起账号状态定时巡检**：`startQuotaSweep()` 每 10 分钟挑 2 个「额度快照超过 6 小时」的号问一次额度（只查额度，不登录、不触发 MFA、失败静默）—— 以前只在额度打到 0 且重置时间已过时才复检，池子闲着时快照一直是旧的，而额度加权轮转完全依赖这份快照。**0.9.0 起权重加「干净号」加成**：出过图、且当前连续失败为 0 的号权重 ×1.5（`CLEAN_ACCOUNT_BONUS`），额度相近时可靠的号排前面 —— 以前额度 25、刚超时两次的号会压过额度 8、连续成功 4 次的号。**同一版新增 `unexploredAccounts()` 与 `hedgeDelayForHead()`**：前者挑出「没成功过、失败 <2 次、额度 >0、有额度快照」的号交给第二路去探（实测 121 个号里 55 个 `lastUsedAt` 全为空，不是坏号是没轮到）；后者按头号可信度决定对冲起步时间（30s / 12s / 有探索任务恒 12s）。**0.10.0 起埋点**：`onAccountResult` 先把每次账号尝试写进 `lib/request-log.mjs` 的 ring（放在「有没有 stats 存储」的判断**之前** —— 面板实时流不该依赖账本文件），再把 `ms` / `ttfbMs` 交给账本；`probeAccountImageQuota` 把 Python 返回的 `limits`（`reset_at` → `resetAt`）落盘；文本链路的 `recordText` 同时写 ring 和账本（补上 `rateLimited` / `retryAfter` / `ms`），并把 `textStats` 传进 `executeWebTextGeneration` 供选号读冷却。**两个兜底分支以前漏了 `onAttempt`**（无 codex 号、codex 失败转 Web），纯 Web 号池的文本请求在统计里永远不出现，这一版补上。图片分支用 `noteInflight` 的 `try/finally` 维护在飞计数。**0.10.1 起批次新鲜度权重**：`BATCH_RECENCY_BONUS = [1.25, 1.10, 1.05]`，按批次排名乘到 `accountWeight` 上；`batchRanksFor()` 只在**至少两个批次**时返回排名表（单批次给所有人乘同一个常数对 WRR 比例没影响，直接短路），`MAGPIE_GPTFREE_BATCH_RECENCY=0` 关闭。排名在 `selectPoolOrder` 里算**一次**并透传给 `weightedOrder` 和 `movePreferredFirst` —— 否则首选号的门槛判断会和实际权重对不上。**0.11.0 起 mode-aware 调度**：`selectPoolOrder` 加 `mode`（image/text）和 `policy`；分桶抽成 `bucketOf()` —— 文本只认 `auth`/`marked` 判死 + `textLimitedUntil` 冷却，图片的 never/stale/额度耗尽都不算死（这就是「图片额度 0 但有文本额度的号」不再被浪费的原因）。权重、分级、批次排名全部搬到 `pool-weight.mjs`，这里只留调度。`hedgeDelayForHead` 的两个延迟改读 policy。`probeAccountImageQuota` 按 `policy.textQuotaFeatures` 从 limits 派生文本额度后落账。**0.12.0 起**：`weightOptions` 给 image 模式注入 `inflightOf` 和 `perAccountInflight`（text 模式不限制 —— 文本请求轻，且并发由 worker 自己控）；`selectPoolOrder` 支持外部注入 `inflightOf`；`executeWebImageGeneration` 收到 `policy.perAccountImageInflight`。 **0.12.4 起额度耗尽按错误码判限流**：`upstream_quota_exceeded` / `upstream_rate_limited` 与 429 同等对待（python worker 那条路回的是 **502**，只认 429 会让耗尽的号一直留在队列里反复被选中）。**0.12.6 起** `selectPoolOrder` 读 `policy.rotation.strategy`：`quotaFirst` 过 50% 权重门槛才 pin 首选号、`roundRobin` 不 pin、`preferred` 无条件 pin —— 只换「谁领跑」，权重体系（额度/分级/EWMA/延迟/卡死）不动；新增 `applySweepPolicy()` 按策略重建巡检定时器（`setInterval` 周期定死在创建那刻，不重建等于改了不生效），巡检跑完/失败各写一条池事件。**0.12.10 起 `renewAccount` 先试 refresh_token 再降级密码**：三种失败分支分开处理（网络故障直接抛 / `invalid_grant` 有密码就降级 / 无密码才抛 `reauth_required`），网络故障时绝不拿更贵、更招限流的密码登录去硬撞。refresh 分支仍然走 `verify` —— `discoverPoolModels` 靠注入的 `verify` 顺手捞模型列表，省掉它就静默失效。 |
| `lib/pool-stats.mjs` | 健康账本：`consecutiveFails` / `cooldownUntil` / `failSince` / `lastSuccessAt` / `authFails` / `deadAt`。四条判死规则：`auth`（授权连续失败 2 次 —— 生图调用里的 `unauthorized` 和额度检测里的 `mfa_verify_failed_403` 都算，超时/连不上不算）、`never`（一次没成过但失败 ≥15 次）、`stale`（72h 没成功）、`marked`。额度检测成功可复活 `auth` 类死号并清零连续失败。按天账本保留期 14 → **400 天**（约 13 个月，够按年看，也不至于每次记账都重写一个大文件），`history` 改为返回保留期内的全部天，由前端聚合成周/月/年。**0.9.0 起卡死走快车道**（**0.12.1 已替换**）：`worker_timeout` 一次按两次失败计、并且立刻冷却 5 分钟（连续两次走正常阶梯，20 分钟起）—— 卡死的号吃掉的是整条 lane 的预算，攒满三次才冷却等于让它连吃三单。**0.12.1 起**改成按连续卡死次数升级的独立阶梯 `hangCooldownMs()`：1 次不隔离、2 次 30 分钟、3 次起 2 小时，只在成功时清零；同时取消「按两次失败计」（卡死有自己的阶梯，再乘 2 等于同一件事罚两遍，还会搅乱普通阶梯的阈值）。冷却时间改成**只延长不缩短** —— 否则 2 小时的隔离会被后一次普通失败覆盖成 10 分钟。**0.10.0 起加观测字段（不参与任何排序）**：`limits`（上游 `limits_progress` 全量，最多 12 条，feature 白名单）、`quotaAtCheck`（上次检测时的额度，用来算消耗速率）、`textLimitedUntil` / `textConsecutiveFails`（文本链路冷却持久化）、`avgImageMs` / `avgTextMs` / `ttfbP50Ms` / `imageSamples` / `textSamples`（EWMA 0.7/0.3）。行数据派生只读字段 `burnRatePerHour` / `etaExhaustMs` / `textStatus` / `effectiveWeight`（0.10.0 恒为 `null`，留给 0.11.0 对照「权重到底有没有生效」）。`quotaStats` 增加 `textLimited` 与 `utilization{remaining,atCheck,ratio}`。顺带修 `cleanMs` 把 `null` 当 0（`Number(null)===0`），那会让 EWMA 从 0 起算、均值系统性偏低。**注意 `normalizeAccountEntry` 的白名单和 `summarizePoolStats` 的行构造要一起改**，只改一处字段会被静默丢掉。**0.11.0 起**：账本加 `tier`/`tierSource`/`weightMul`/`textQuota`/`textHasLimit`/`textRestoreAt`/`textQuotaCheckedAt`/`ewmaSuccess`/`hangStreak`/`lastHangAt`；`recordImageCall` 维护 EWMA 成功率（固定 alpha 0.3，热路径不读配置）和连续卡死（只有成功清零，普通失败既不增也不清）；`recordQuotaCheck` 接收调用方派生好的文本额度（`null` 保留旧值，不抹成 0）；新增 `setAccountPolicy()`（`tier: null` = 清回自动，`undefined` = 不动）；`quotaStats` 加 `textActive`/`totalTextQuota`/`tierDist`。 **0.12.4 起限流冷却有兜底**：拿不到 `retryAfter` 时按 1 小时停、上限夹到 7 天，且只往后延不缩短（`laterOf`）—— `isAccountRateLimited` 在额度为 0 时本来就挡住号，兜底解决的是「停到什么时候」，不给它号只能等巡检捞回来。**0.12.6 起**限流与恢复各写一条池事件（`account.parked` / `account.released`）。**0.12.9 起限流时保留 `quotaError`**：以前那行是 `rateLimited ? null : (error ? prev.quotaError : prev.quotaError)`，两个分支写法不同、行为一样，等于空操作 —— 一被限流原因就被 `null` 盖掉，账本只剩「停了」没有「为什么」。现在按 `errorMessage` → `error` → 旧值 的顺序兜底，没有新信息就沿用旧值。**0.12.10 起 `AUTH_ERROR` 加 `reauth_required`**：refresh_token 成为首选续期方式后，refresh 失败**不能一概判死** —— 有密码的号会在 `renewAccount` 内部静默降级走密码登录，压根不把错误抛到账本；只有「refresh 失效 + 没有密码」才抛 `reauth_required`，那才是真的只剩人工重新授权一条路。所以这里认的是 `reauth_required`，**不是 `invalid_grant`**（后者只是中间过程，认它会把好号误杀）。 |
| `lib/pool-vault.mjs` | **0.10.1 起记录导入批次**。`upsertPool(record, { root, batchId })` 给每条账号加 `addedAt`（首次入库时间）和 `batchId`，两者**首次写入即固定**：刷新授权 / 重新登录 / 重新导入同一个邮箱都不改，只有先 `removePool` 再导入才算新批次。`listPool` 给老记录补默认值（`addedAt: null`、`batchId: LEGACY`）但**不写回文件** —— 读路径不产生写入，而且一旦写回就再也分不清「真的是历史批次」和「刚补上的」。和 `batch-registry.mjs` 是刻意的小循环依赖（那边也用这里的 `poolDir`），两个方向都只在函数体内取值，模块求值阶段碰不到对方的绑定。**0.12.10 起允许持久化 `refreshToken`**（策略反转：旧版刻意不存，只靠密码重登续期）：字段可选，老记录读出空串不报错；重新导入时传空值**不会覆盖**已有值 —— 否则一次 OAuth 登录就把这个号的密码兜底抹掉了。`id_token` 仍然不落库，它只用于一次性解析邮箱/套餐。**`refresh_token` 会轮换，拿到新的必须立刻写回**，这是本模块唯一要求调用方遵守的约定。 |
| `lib/batch-registry.mjs` | **0.10.1 新增**。导入批次：`newBatchId()` 生成 `b` + UTC `yyyymmddHHMMSS` + 4 位随机 —— **可按字符串排序**，所以「哪个批次更新」不用读文件，权重计算在热路径上不能为了排序做 I/O。`batchRankMap()` 把账号数组折成 `batchId → 第几新`；`readBatches` / `recordBatch` 管 `~/.magpie-gptfree/batches.json`（明文、0600、原子写、最多 200 条、同 id 覆盖）；`summarizeBatches` 按批次聚合号数 / 可用 / 额度 / 成功率（没调用过是 `null` 不是 0）。标签走 `cleanLabel`（去控制字符、压空白、截 60 字），因为它会进面板和日志。 |
| `lib/pool-policy.mjs` | **0.11.0 新增**。调度策略读写：存 `settings.json` 的 `poolPolicy` 键（和回复形态、保留天数同一个文件 —— 多一个文件只会多一处「改了不生效」）。`tierWeights` / 四个乘子开关 / `ewmaMinSamples` / `tierThresholds` / `textQuotaFeatures` / 两个对冲延迟。环境变量优先（`MAGPIE_GPTFREE_POLICY_*`），用于线上紧急回滚，不用发版。`boolOf` 必须是三态（true/false/**null=没指定**）：把「没设」当成 false 会让 `source` 永远是 `env`，面板上所有开关都显示成「被环境变量锁定」。 **0.12.6 起**加 `rotation{strategy,respectPreferredSlot}` 与 `sweep{enabled,intervalMinutes,limit,staleAfterMinutes}`；`writePoolPolicy` 对这两个嵌套对象做**深合并** —— 浅合并会在「只改 strategy」时把 `respectPreferredSlot` 冲回默认值，等于改一个开关顺手改回另一个，最难查。 |
| `lib/pool-weight.mjs` | **0.11.0 新增**。权重唯一函数 `W = Q_eff/(1+2·streak) × G × M × R × L × H × B`：`G` 是分级或干净号加成（**二选一，不叠加**）、`M` 手工倍率、`R` EWMA 成功率、`L` 首字节相对中位、`H` 连续卡死、`B` 批次新鲜度。`tierOf()` 只用慢变量（成功率 / EWMA / TTFB / 卡死），**不含 streak**（已在 base 罚过）也**不含额度**（额度是主导项）。`deriveTextQuota()` 按 policy 指定的 feature 从 limits 求和，配了但上游没给就返回 null（保留旧值，不编 0）。`finiteOrNull` 必须挡掉 `null`/``：`Number(null)===0` 会让「额度未知」变成「额度 0」，权重从 1 掉到 0.05。**不 import pool-stats**，避免循环。**0.12.0 起**加 `I` 乘子（单号并发已满 ×0.2）。这是并发闸的**软**那一半：只靠它挡不住四条 lane 各自排序、第一名都挑同一个号；只靠硬跳过则池子小时没号可用。`inflightOf` 可外部注入（测试用），默认查进程级全局计数。 |
| `lib/account-inflight.mjs` | **0.12.0 新增**。进程级 `Map<email, count>`，跨请求共享，**不落盘、不参与判死、重启即清零**。存在的理由：`tried` 只保证同一请求内两条 lane 不撞号，而号池整体并发是 4 —— 四个请求各自的第一条 lane 完全可能挑中同一个号，那个号就被四个 worker 同时打，上游看到的是突发流量。计数只增不减会把这个号永久钉在「满」上，所以所有增减都必须成对出现在 `finally` 里。`accountInflight(bad)` 返回 0 而不是在 Map 里留垃圾。 |
| `lib/web-oauth.mjs` | **0.12.10 新增**（移植上游 `a8ca17a`）。浏览器 OAuth PKCE 登录：Codex 客户端 `app_EMoamEEZ73f0CkXaXp7hrann`、scope 带 `offline_access`（不然拿不到 refresh_token）、回调只绑 `127.0.0.1:1455` 的 `/auth/callback`。用途是**在没有凭证时造一份**，不是导入已有凭证：`createWebOAuthFlow` 起回调监听并给出授权链接，`submitCallback(raw)` 接受完整回调 URL / 查询串 / 裸 code 三种形态。安全边界：state 用 `timingSafeEqual` 比对（防 CSRF）、`openExternalUrl` 只允许打开 `auth.openai.com`、状态快照里不含 token 和原始邮箱。回调端口被占/系统不允许时返回 `callbackBlocked` 而不是失败 —— 用户把链接复制到别的浏览器手动完成即可。 |
| `lib/request-log.mjs` | **0.10.0 新增**。进程内请求日志：定长环形缓冲（默认 800 条，`MAGPIE_GPTFREE_REQUEST_LOG_SIZE` 可调，最少 50），写入 O(1)、**零 I/O**。以前 `pool-stats.json` 只记聚合计数、`image-errors.jsonl` 只记失败，于是「这次请求试了哪些号、每个号多久、谁赢了、文本请求到底有没有发生」全都看不见。脱敏：只存 `s<sha256 前 10 位>`，**永不写邮箱明文**；字段走白名单（`reason` / `tier` 也在这里挡），不认识的直接丢。**默认不落盘**：每次请求都写文件会把 500 条裁剪的读放大搬到热路径上，失败取证继续走 `image-errors.jsonl`。ring 是进程内的，热更新时新旧 host 各记各的，所以 `recentRequests` 和 `requestMetrics` 都带 `seq` / `pid` / `since`，面板注明「本进程自 X 起」，不能当成全局数据。`reset=true` 表示调用方的游标比当前 `seq` 还新（进程重启过），前端据此整段重画。 |
| `lib/pool-events.mjs` | **0.12.6 新增**。池级事件日志：进程内 ring（默认 400 条，`MAGPIE_GPTFREE_POOL_EVENT_SIZE` 可调，最少 50），零 I/O。和 `request-log` 的分工不是粒度而是**主语**：那边记「一次请求试了谁、多久、谁赢」，这边记「池子本身发生了什么」—— `sweep.run` / `sweep.error` / `policy.change` / `account.parked` / `account.released`。不落盘的理由同 request-log：快变量、在热路径上，失败取证另有 `image-errors.jsonl`。`kind` 走 `^[a-z][a-z0-9._-]{0,31}$` 白名单、字段也走白名单，只写槽位号不写邮箱；带 `since` / `pid`，面板注明「本进程自 X 起」，热更新时新旧 host 各记各的。 |
| `lib/pool-forecast.mjs` | **0.10.0 新增**。额度耗尽预测：纯计算，不碰 I/O。`forecastExhaustion` 从 `summarizePoolStats` 已经算好的 `burnRatePerHour` / `etaExhaustMs` 里挑出「ETA 有限且为正、额度还有」的号，按最快耗尽排序取前 N；`poolUtilization` 把 `remaining/atCheck` 折成已消耗比例（没有检测快照时 `ratio` 为 `null` 而不是 0，否则面板会显示「利用率 0%」骗人）。预测需要「检测时额度」和「当前额度」的差值 + 时间跨度，所以**刚导入的号不会有预测**。 |
| `lib/pool-connection.mjs` | **0.9.0 起单端点**。整个号池在 Magpie 里只占一条 auth 记录（key 仍是 `gptfree-pool`），标签是「GPTFree号池 (N 个账号)」，**不带 `poolSlot`** —— 以前一个号一条记录（`gptfree-pool#s<hash>`），Magpie 看到 121 个账号，选号和重试都由它做，而它对我们这些号没有任何额度数据（`quotas.json` / `quota-history.json` 里一条都没有），只能盲选 + 串行重试（实测 `tries` 最高 19）。迁移：老的 `gptfree-pool#s*` 在第一次 sync 时清掉；正好处在某次登录 key 作用域里清不掉的记进 `magpie-slots.json`（v2，`{version, legacyKeys}`），下一轮再清。`buildSlotAuthBody` 只为兼容旧脚本保留。 |
| `lib/chatgpt-web-image.mjs` | **0.9.0 起预算重做（lane + 对冲）**。一条 lane 按额度加权顺序依次试号、失败就换下一个；第一路跑满 `MAGPIE_GPTFREE_HEDGE_DELAY_MS`（默认 25 秒）还没结果就再起第二路并行试另一个号，谁先出图谁赢、其余立刻掐掉。老配置是「单次 35s / 整单 55s / 串行换号」，在数学上走不通：第一个号卡满 35 秒后第二个只剩 20 秒，而正常出图 27~32 秒，于是 121 个号的池子每个请求只试到 1 个（线上 `attempted=1 / skipped=120`）。头程定 25 秒而不是 40 秒，是因为客户端 59 秒就 cancel：40+30 一定超，25 秒起步的第二路还能拿到 30 秒；正常号 27~32 秒返回时第二路才跑 2~7 秒、图还没生成，掐掉几乎不额外烧额度。**超时文案里不许出现「额度」**（Magpie 的失败分类正则含 `额度`，一出现就被标成「额度用尽」，把排查方向带偏过一轮）。额度耗尽的 400 换号而不是整个请求失败；解析「上限将在 21小时 后重置」得到 `retryAfter`。**同日再调（实测驱动）**：整单 55s → **150s**、单次 40s → **55s**，新增 `HANG_JUDGE_MS`（默认 **10s**）—— 实测 9 次成功请求的上游首字节只要 2.9~4.5 秒，10 秒没动静就是卡死，不必等满单次上限，同样的预算能多试好几个号；第二路改为优先探未验证号（`exploreAccounts`，探索游标与已取集合放在函数作用域，`n>1` 时不会重复试同一个新号），探索路因预算压缩导致的超时不记账号失败。Python worker 在收到上游第一个 SSE 包时往 stderr 写 `##PROGRESS first_byte`，node 侧按行解析（不混进错误文案）。**0.10.0 起**7 处 `reportResult` 里有 6 处补上 `ms`（`Date.now() - attemptStartedAt`）和能拿到的 `ttfbMs`，供账本算耗时画像。**0.12.0 起单号并发闸的硬那一半**：`takeNext()` 领号时跳过在飞已满的号（`accountInflight >= perAccountInflight`），全都在飞时退化为挑最闲的硬上（池子小时剔除等于不出图）；`takeExplore()` 遇到要探的号在飞已满就让回正常顺序。计数在 `lane()` 里成对 `noteAccountInflight(±1)`，`finally` 释放 —— worker 抛错/abort/预算掐断都要减，否则一次异常就把号永久钉在「满」上。`perAccountInflight=0` 时走原来的直路，连 Map 都不查。**0.12.x 起预算再调**：单账号 **60 秒**没出图就换号（成功样本集中在 21–38 秒，超 60 秒的一次都没成过；号池两百多个号，等一个慢号不如换一个试），整单天花板 **10 分钟**，且**主路径是「号试完了」而不是「超时了」**。同批还修了首字节判定：`firstByteMs === 0`（0ms 到达）和「没来」分不开，改用独立布尔 `firstByteSeen`。**对冲改成看首字节**：老规则「头号 30 秒没结果就复制一路」在 2.6 上（正常 21–37 秒）会复制一个本来会成功的请求，上游白生成一张 —— 现在首字节来了就不对冲，真卡死由 10 秒 hangJudge 掐掉；探索路单独用 `policy.exploreWhileProgressing` 控制（默认 false）。**超时拆成两个码**：`worker_hang`（10 秒无首字节，记 `hangStreak`）/ `worker_slow`（首字节来了但超预算，只记普通失败）—— 混在一个码里会让慢模型把池子里的好号一个个隔离掉。新增 `attempt_aborted`（我们主动不等了，以前直接 throw、日志里完全看不到），记 `accountFault=false`。 **0.12.4 起**：重置时间单位补全 天/小时/分钟/秒（原来只认小时，「3天后重置」解析成 null）；额度文案正则收紧 —— 原来的 `上限|额度|quota|usage limit` 会把 `image size limit` / `prompt length limit` 这类**请求本身**的 400 也判成额度用尽，白停一个好号。 |
| `lib/chatgpt-web-text.mjs` | 单次尝试压到 60s 且不超过剩余预算（worker 默认 180s 比整单 120s 还长）；文本选号排除「重新登录都过不去」的号，但**不**套用图片的熔断/额度状态，并用自己的轮转账本，不干扰图片按额度加权。**0.10.0 起冷却持久化**：`getSlotCooldownUntil` 除了进程内 `Map` 还读账本的 `textLimitedUntil`（宿主每小时热更新会清空 Map，只靠内存等于没有冷却）；`orderWebTextAccounts` / `executeWebTextGeneration` 接受 `textStats` 并透传。**同一版修 429 漏判**：换号分支原来只在 `error_code === "rate_limited"` 时才带 `rateLimited`，而上游实际返回 `rate_limit_exceeded` / `too_many_requests`，导致绝大多数限流根本没落进账本 —— 改成按 `status === 429` 记 `accountRateLimited`。所有 `onAttempt` 都带上 `ms`。 |
| `lib/credentials.mjs` | 账号行分隔符从"3 个以上连字符"放宽到 `----` / `---` / `--` 三种，同一文件可混写（邮箱和 Base32 密钥都不含 `-`，所以 `--` 在前三列不会切错）。五字段行仍要求 `----`：JWT 签名里本身可能出现 `--`，用 `--` 切会切坏 token，这种行直接报错而不是悄悄导错。**0.12.10 起第五列的值真的被取出来了**：以前只记 `hasRefreshToken: true`、值扔掉，于是「过期自动重登」只能靠密码 —— 现在带出 `refreshToken` 交给 importer 落库（正反两种列序都认）。 |
| `gui/app.js` | 失效徽章区分三种失效原因并给出对应的复活提示；趋势图把生图与文本分开计数，并支持 **按日 / 按周 / 按月 / 按年** 切换（周从周一起算，窗口内没有数据的天也画成空柱），**每根柱顶上直接标「成功数 / 失败数」**，不悬停也能读。**0.8.7 起前端收敛成一条数据流**（一次 `/api/stats` → `renderAll()`），首页把原「我的账号池」和「额度统计」两张表合成一张：账号按状态分六组、可折叠、带搜索/分组/排序，批量栏常驻。Token 徽章是 **`Token 已确认` / `Token 未确认`**（只认上游真实证据：额度检测通过或成功出过图，且晚于最近一次换 Token），额度状态徽章是 **`额度可用` / `已限流` / `冷却到期` / `需先续期` / `额度查询失败` / `额度待检测` / `已失效`**，剩余额度单独一列，徽章里不再重复数字。批量删除的确认框是**自绘**（`confirmAction`）：页面跑在 Magpie 的沙箱 iframe 里（`Origin: null`，没有 `allow-modals`），原生 `confirm()` 会被浏览器直接丢弃并返回 false，表现就是「点了批量删除没反应」。**0.8.13 起导航重排**：「导入账号」不是 tab（它是一次性动作，不是「一直待着看」的视图），挪到导航右侧做成主按钮；tab 收成 总览 / 图片 / 设置，导入页没有 tab 时按钮自带一圈 `is-on` 高亮。号池为空时 `renderEmptyState()` 收起账号表 / 筛选 / 批量栏 / 失效分类，换一张引导卡 —— 否则六个统计数字全是 0，看着像页面坏了。设置页（回复格式 / 保留天数 / 清理时段 / 立即清理 / 清理日志）复用同一份 `imageState`，`/api/stats` 下发即渲染，切过去不用再等请求。**0.10.0 起新增「运行」页前端**：`liveState{seq,rows,timer,loading,polling,payload}`，每 2 秒轮询 `/api/requests?since=<seq>`，切走 tab 或 `document.hidden` 立刻 `clearInterval`，回到前台重拉全量；`reset` 表示服务端 `seq` 比游标小（进程重启过），整段替换。三块渲染（指标卡 / 额度预警 / 活跃账号）复用 `.stat-card` 与 `.fail-*` 系类，**不引入任何图表库**。两个坑记一下：① 页面直接落在运行页时 `setup()` 先 `tab()` 再 `refreshData()`，`snapshot` 还是 null，`slotLabelMap()` 为空、账号列只剩槽位号 —— 所以 `renderAll()` 里挂 `renderLiveLabels()` 补画一次；② `errorPillClass` 原来只匹配 `rate_limited`，上游的 `rate_limit_exceeded` 会掉成灰色，已放宽成 `rate_limit`。**0.10.1 起**：账号行邮箱下方加「10-20 入库」副标题（悬停看完整批次标签与第几批，`batchNoteText`）；运行页加「导入批次」区块（`renderLiveBatches`，复用 `liveBarRow`），成功率低于 50% 标红。批次标签从 `/api/stats` 的 `batches` 建索引（`batchMetaMap`），序号按**入库先后**数（最老的是第 1 批，和权重排名的「第几新」是反的）。**0.11.0 起**：状态列加分级徽章（`tierPill`：已生效用主色，自动推断未生效用灰色 + 「仅展示」，否则用户会以为面板上的 S 已经在影响选号）；额度列加「文本 N」副行；设置页「调度策略」卡（`loadPolicy`/`renderPolicy`/`savePolicy`）+ 批量栏分级按钮（`setBatchTier`）。 |
| `gui/style.css` / `gui/dashboard.html` | 0.8.7 重做视觉：主色换成**深青**（亮/暗两套 CSS 变量，`#0f6e56` 只做品牌色，语义绿仍归「成功」），导航收成 tab（切换不发请求），表格改 `table-layout: fixed` + sticky 表头 + 可折叠分组行，窄屏逐级隐藏次要列。**0.8.11 起多一个「图片」tab**：统计卡（总张数/总占用/最早/最晚）+ 近 14 天柱状图 + 排序与日期筛选 + 批量栏（删除选中 / 清理早于 N 天 / 全选筛选结果）+ 分页列表，缩略图 `loading="lazy"`，表格 `max-height` 取「表头 + 8 行」的整数值，避免底部露出半行。**列表 / 网格两种视图**共用一份 `imageState`（选中集合、拖动框选、分页都在状态里），切换只换渲染器不重新请求；网格不设 `max-height`（卡片高度随宽度变，硬卡会切出半行缩略图）。**0.8.13 起**：导航改成 `.tabs-bar`（左边 tab、右边 `+ 导入账号`），新增 `.empty-cta`（空号池引导）、`.settings-card` / `.settings-row`（设置页）、`.cleanup-table`（清理日志表）；图片页头部只留「清理设置」「刷新」，保留天数与清理时段搬到设置页，免得配置散在两处。 |
| `test/*` | 260 个用例，覆盖轮转比例、冷却阶梯、失败分类、判死与复活、授权失败判死（含额度检测里的 MFA 403）、预算超时、额度 400 换号、额度复检守卫、文本链路、按天统计、限流生命周期、导入格式（含 2 连字符）、面板分组/排序控件、批量接口、面板端口重试与恢复、图片桥的正文形态（both 分组 / 多图并发与顺序 / 部分成功 / 全失败 / 流式 / 面板设置读写 / 环境变量覆盖 / markdown 回退），以及图片页的文件名白名单、分页排序筛选、本地日期分桶、逐条容错删除、按天清理、保留天数与清理时段现读设置、时段窗口（含跨午夜与右开区间）、三个图片接口的端到端流程，还有清理日志的字段归一化 / 新旧排序 / 500 条裁剪 / 清空 / 三个删除入口各写一条且不重复。0.10.0 起 199 个用例（新增 `request-log.test.mjs` 13 个：脱敏 / 白名单 / seq 游标 / reset / 窗口指标 / 在飞计数 / 活跃度聚合 / 预测排序）。0.10.1 起 221 个用例（新增 `batch-registry.test.mjs` 10 个：id 可排序 / 非法回退 legacy / 排序去重 / 排名表 / 标签清洗 / 文件往返与坏文件容错 / 按批次聚合 / 空样本成功率 null）。0.11.0 起 240 个用例（新增 `pool-weight.test.mjs` 13 个，其中「default policy reproduces the 0.10.x weight bit for bit」是 0.11.0 的**铁律门禁**：手抄一份 0.10.x 公式当参考答案，对 7 种典型账本记录逐位比对）。0.12.0 起 250 个用例（新增 `account-inflight.test.mjs` 4 个 + 生图链路的并发闸 4 个，含一条**反证**：关掉闸后同样的场景两个请求必然撞同一个号 —— 没有它主用例通过也可能只是碰巧）。 |

环境变量（都有默认值，一般不用设）：

```
MAGPIE_GPTFREE_IMAGE_DIR          PNG 落盘目录，默认 /config/images
MAGPIE_GPTFREE_PUBLIC_BASE        图片链接前缀，默认空 = 返回相对路径 /img/xxx.png
                                  要绝对地址就设成 https://你的域名（结尾斜杠会去掉）
MAGPIE_GPTFREE_IMAGE_REPLY        正文形态，**一般不设**：面板「设置 → 图片回复格式」里选即可（存 settings.json）。
                                  设了就强制覆盖面板，可选 both（默认，图+地址）/ url / markdown
MAGPIE_GPTFREE_IMAGE_RETENTION_DAYS  图片保留天数（1–90），**一般不设**：面板「设置 → 自动清理 → 保留」里选即可。
                                  设了就强制覆盖面板（面板下拉置灰）。超过天数的图每小时清一次
MAGPIE_GPTFREE_IMAGE_CLEANUP_WINDOW  自动清理的时段，**一般不设**：面板「设置 → 自动清理 → 时段」里选即可。
                                  写成 2-6 / 22-6（跨午夜）/ 0-24（全天，默认）。
                                  只管自动清理；面板上的「立即清理」「删除选中」不看它
MAGPIE_GPTFREE_MAX_TOTAL_MS       整单预算（一次请求里所有换号重试都算在里面），默认 150000。
                                  注意是**每张图一份**：n>1 是并发打多次，各自计时，不会叠加
MAGPIE_GPTFREE_ATTEMPT_TIMEOUT_MS 单个号的上限，默认 55000
MAGPIE_GPTFREE_HANG_JUDGE_MS      多久没收到上游首字节就判这个号卡死，默认 10000
MAGPIE_GPTFREE_HEDGE_DELAY_MS     第二路（对冲）起步延迟的兜底值，默认 25000。
                                  真实调用方会用 hedgeDelayForHead() 覆盖成 12s / 30s，见下文「选号策略」
MAGPIE_GPTFREE_MAX_LANES          一次请求最多开几路并行，默认 2
MAGPIE_GPTFREE_TEXT_ATTEMPT_MS    文本单次尝试上限，默认 60000
MAGPIE_GPTFREE_TZ_OFFSET_MIN      按天统计的时区偏移，默认 -480（UTC+8）
MAGPIE_GPTFREE_HEALTH_MIN_USABLE  /api/health 判不健康的可用号下限，默认 3
MAGPIE_GPTFREE_HEALTH_MIN_QUOTA   同上，总剩余额度下限，默认 50
MAGPIE_GPTFREE_GUI_DEBUG          设 1 时输出面板端口重试的调试日志（默认不输出，避免刷屏）
```

## 选号策略（维护者版）

面向用户的说明在 `README.md` 的「号池是怎么挑号的」；这里只记**为什么是这些数字**，
改之前先看一遍，否则很容易把实测调出来的参数当成随手写的。

### 一次请求的完整链路

```
selectPoolOrder()            分三档 + 加权排序
  └─ usable  按 accountWeight() 做 smooth WRR
  └─ blocked 额度耗尽 / 冷却中
  └─ dead    auth / never / stale / marked
        ↓
executeWebImageGeneration()
  ├─ lane 1（第一路）      从队首 takeNext()
  └─ lane 2（第二路/对冲）  12s 或 30s 后起步，优先 takeExplore()
        ↓
tryAccount()                 单个号：10s 无首字节 → 判卡死换号；有首字节 → 等到 55s
```

### 三个关键数字及其依据

| 参数 | 值 | 依据 |
| --- | --- | --- |
| `HANG_JUDGE_MS` | 10 秒 | 实测 9 次成功请求的上游首字节是 **2.9~4.5 秒**，10 秒是最大值的两倍多。卡死的号一个字节都不来，以前要等满 55 秒单次上限才敢换 |
| `MAX_TOTAL_MS` | **600 秒（10 分钟）** | 0.12.x 起改成「单账号 60 秒换号 + 整单只在天花板或号试完时收手」。原来的 150 秒配上 75 秒单次上限，一个请求只够试 2 个号 —— 池子里两百个没用过的号却已经报「全部失败」。天花板只兜底，不是主路径 |
| `CLEAN_ACCOUNT_BONUS` | 1.5× | 池子里额度 25、刚超时两次的号，权重会压过额度 8、连续成功 4 次的号。1.5 不足以颠倒额度差（额度仍是主导），只在额度相近时把可靠的号提上来 |

### 为什么要「第二路去探未验证号」

`accountWeight` 是 `额度 ÷ (1+2×连续失败)`，额度 25 的号权重是额度 5 的 5 倍。
实测 121 个号里 **55 个 `lastUsedAt` 全为空** —— 它们额度低（2~5），永远排队尾，
一次都没上过场；而被反复使用的那批高额度号（额度 10~25）已经有 11 个被上游限流。

这些未验证号的 `planType` / `hasImageLimit` 和已验证号完全一致，不是坏号，是没轮到。
所以让第二路（本来就是「赌一把」的位置）优先去试它们：赢了白赚一个可用号，输了
不占第一路的预算。

上线后实测：未派过活 55 → 21，出过图 55 → 64，还探到一个额度只有 2、20.9 秒就
出图的号（比原来那批 35~51 秒的快得多）。

`unexploredAccounts()` 的三个边界：

- **额度 0 的不探**：肯定出不了图，白烧一个 lane 的 10 秒。
- **给两次机会**（`failCalls < 2`）：一次超时可能是首次调用要预热或上游抖动。
  只给一次的话，实测有 23 个号「失败一次就永久出局」。
- **没有额度快照的不探**：连额度都没探过说明 token 可能根本无效。

### 对冲起步时间为什么不固定

`hedgeDelayForHead()`：

- 头号 24 小时内成功过 → **30 秒**（它大概率只是慢，晚点对冲省额度）
- 头号没验证过 / 久未成功 → **12 秒**（把 43 秒留给第二路，让它真能出图）
- **有未验证号要探 → 一律 12 秒**（否则第二路拿不到一次完整的单次预算，
  探索会变成「预算不够」的假失败）

> 踩过的坑：一开始固定 25 秒起步，但第二路到 150 秒预算末尾只剩 30 秒，比正常
> 出图（实测 35~51 秒）还短，于是线上 `attempted` 一直停在 1，对冲等于摆设。

### 探索路的失败不能记到账号头上

`tryAccount(idx, signal, { exploring })`：探索路的号如果是因为**预算被压缩**
（`attemptTimeout < attemptTimeoutMs`）而超时，不写失败记录 —— 那只说明没时间
试完，不说明这个号不行。否则第一次探索就把新号误判成坏号，探索队列永远长不大。

### 改这些之前请先确认

- 改 `HANG_JUDGE_MS` 前先看 `[gptfree] attempt ttfb=` 日志的首字节分布，
  这个日志目前在 `tryAccount` 里每次尝试打一行（排查完可以删）。
- 改 `accountWeight` 的公式要同步跑 `test/selection.test.mjs` 里的
  「干净号排在刚失败的号前面」用例，那条锁的是「额度相近时可靠优先」。
- 判死阈值在 `lib/pool-stats.mjs`（`AUTH_FAIL_LIMIT` / `NEVER_WORKED_FAILS` /
  `DEAD_AFTER_MS`），冷却阶梯是 `FAIL_COOLDOWN_THRESHOLD=3` 起、
  `10min × 2^(n-3)`、上限 1 小时；`worker_timeout` 额外保底 5 分钟。


## 怎么跑测试

```bash
node --test --test-concurrency=1
```

`--test-concurrency=1` 是必须的：多个测试文件会抢同一个端口（37986），并行跑会假失败。

## 怎么跟上游

上游是 `yang0/magpie-gptfree`（remote 名 `upstream`）。**上游修 bug 时，很可能修的是我们也有的问题**，
所以要看，但不能直接合 —— 我们重写了选号、熔断、判死、GUI 这几块，机械解冲突等于把我们的改动抹掉。

一条命令看「上游动了什么、会不会撞上我们」：

```bash
~/.magpie-gptpool-tools/upstream-status.sh
```

> 这个脚本和发版脚本一样**不进仓库**（见下面「维护者本机工具」）。它要做的事很简单，
> 想自己写一份也行：`git fetch upstream` → 用 `merge-base HEAD upstream/main` 算分叉点 →
> `git diff --name-only <分叉点> upstream/main` 得到上游改过的文件集合 →
> 跟我们改过的文件集合取交集，按「撞代码 / 撞文档 / 不撞」分级。

输出会按风险分级，不是只报「落后几个提交」：

- **高**：上游动的文件我们也在改 → 必须人看，会列出具体文件名
- **中（文档/测试）**：只跟我们的 README / test 撞 → 照合即可
- **中（代码）**：动了 `lib/` 但没碰我们的改动 → 正常合
- **低**：只动 CI / 文档

退出码：`0` 已同步，`1` 上游有新提交。`--quiet` 只在落后时输出，给定时任务用。

确认要合之后：

```bash
git log -p upstream/main ^HEAD -- lib/codex-pool.mjs   # 先看上游到底改了什么
git diff upstream/main..HEAD -- lib/                    # 再看我们改了什么
git merge upstream/main
npm test
```

合完重点看三个文件有没有被上游改过：`codex-pool.mjs`、`pool-stats.mjs`、`chatgpt-web-image.mjs`。
上游动了这三处，就要按**我们的语义**重新落一遍，别机械解冲突。

> 分叉点现在是 `5ab9b99`（我们领先 42 个提交）。上游追踪脚本用 `merge-base` 算分叉点，
> 所以合过一次之后不用改任何配置，它自己知道从哪儿开始算。

## 怎么装、怎么升级

**Magpie 里这个插件的安装源就是这个仓**，spec 写在 `plugins.json`：

```json
{ "spec": "https://github.com/puaicg/magpie-gptpool" }
```

没有 `#<commit>` 就是跟默认分支（`patch/chat-image-bridge`）走。这意味着：

- 上游推新提交**不会再影响我们** —— Magpie 比的是这个仓的 commit，不是 `yang0/magpie-gptfree`。
- 我们自己推了新提交，**要跑 `/root/gptfree-update-plugin.sh` 才会升上去**（原因见下面的警告）。
- 想彻底不再提示更新，把 spec 改成 `https://github.com/puaicg/magpie-gptpool#<完整 commit sha>`。Magpie 的 `refFixed()` 认 `#` 后面的十六进制 SHA，钉住之后不再解析任何 ref。

**升级流程**：本地改完 → 跑测试 → push 到 `patch/chat-image-bridge` → 部署机执行 `/root/gptfree-update-plugin.sh`。

本地一条命令等价（走跳板机，跑完会核对线上版本）：

```bash
~/.magpie-gptpool-tools/update-server.sh
```

> 这个脚本**不在仓库里**：它要连生产机，而跳板别名 / 主机地址一旦进 git 就永久留在历史里。
> 部署目标从仓库之外的 `~/.magpie-gptpool-release.env` 读（见下面「维护者本机工具」）。

> 地址变迁（2026-11）：`puaicg-ship-it/magpie-gptfree` → 账号改名 → `puaicg/magpie-gptfree` → 仓库改名 → **`puaicg/magpie-gptpool`**。
> 前两个地址都是 301 重定向，老机器上装着的旧 spec 不会立刻坏，但 `bun` 会把解析结果写成旧 URL，
> 建议顺手把 spec 换成新地址再跑一次更新。

> ⚠️ 别用 `magpie plugin update`。它走 bun 的「按 lockfile 重装」路径：同一个 URL 已经解析过时
> 不会重新去 GitHub 取，会静默停在旧 commit 上（实测推了新提交后它仍打印 `✓ plugins updated`，
> 实际没动）。`bun update <包名>` 才会重新解析。`gptfree-update-plugin.sh` 做的就是
> `bun update magpie-gptpool` + 重启 + 校验，一条命令搞定。

## 怎么发版

> **发版脚本不进仓库**。仓库只放插件本身；发版 / 部署 / 上游追踪这三件事都碰得到本机路径、
> 主机名和 token 位置，属于维护者本机工具，放在 `~/.magpie-gptpool-tools/`。
> fork 的人照下面的流程自己写一份就行 —— 步骤都是 `git` 和 `npm` 的普通操作。

```bash
~/.magpie-gptpool-tools/release.sh 0.8.11 "改动一" "改动二"   # 发版
~/.magpie-gptpool-tools/release.sh 0.8.11 "改动一" --deploy   # 发完顺手部署
~/.magpie-gptpool-tools/release.sh 0.8.11 "改动一" --release  # 顺便建 GitHub Release
~/.magpie-gptpool-tools/release.sh 0.8.11 "改动一" --dry-run  # 只看要做什么
```

脚本会：校验分支/工作区 → `npm run check` + 全部测试 → 升 `package.json` → 改 README 徽章 →
在 CHANGELOG 顶部插一节 → `commit` → `git tag -a vX.Y.Z` → `push --follow-tags`。
测试不过就中止，不写任何文件。

**部署目标不写死在脚本里**，从仓库之外的 `~/.magpie-gptpool-release.env` 读（`MAGPIE_RELEASE_ENV`
可以指到别处，权限建议 `chmod 600`）：

```bash
DEPLOY_JUMP=跳板别名                     # ~/.ssh/config 里的 Host 名
DEPLOY_HOST=user@host
DEPLOY_PORT=22                           # 可选，SSH 端口非 22 时填（如 55581）
DEPLOY_REMOTE_CMD='bash /root/gptfree-update-plugin.sh'   # 可选，有默认值
DEPLOY_VERIFY_CMD='bash /root/verify-gptfree-patch.sh'    # 可选，有默认值
```

没有这个文件时 `--deploy` 会直接报错说明怎么配，而不是连一个猜出来的地址。

**GitHub token（建 Release 才需要）**：别写进仓库里的任何文件 —— 发版脚本自己会 `git add -A`
并提交，token 会被推到公开仓库，GitHub 的 secret scanning 还会直接吊销它。正确做法是
`release.sh --save-token`，交互输入（不回显、不进 shell 历史），macOS 存钥匙串，
其他平台写本机文件。取用优先级：

```
GITHUB_TOKEN 环境变量 > gh auth token > macOS 钥匙串
  > ~/.magpie-gptpool-tools/.release-token（本机工具目录，不在仓库里）
  > ~/.magpie-gptpool-release-token（仓库之外）
```

## 维护者本机工具（不在仓库里）

| 位置 | 干什么 |
| --- | --- |
| `~/.magpie-gptpool-tools/release.sh` | 发版：检查 → 测试 → 升版本 → 写 CHANGELOG → commit → tag → push →（可选）建 Release / 部署 |
| `~/.magpie-gptpool-tools/update-server.sh` | 连生产机跑 `/root/gptfree-update-plugin.sh` 并核对线上版本 |
| `~/.magpie-gptpool-tools/upstream-status.sh` | 按「撞不撞我们的改动」给上游提交分级 |
| `~/.magpie-gptpool-release.env` | 上面两个脚本读的部署目标（0600，**永远不要提交**） |

仓库里 `.gitignore` 把这几个路径都挡住了（含 `*.release.env`）。为什么不干脆留在仓库里：
这些脚本里原本写着跳板别名、生产机 IP 和远程脚本路径 —— 公开仓库等于把这些永久写进 git 历史，
删掉文件也删不掉历史。**仓库里唯一保留的脚本是 `scripts/demo-preview.mjs`**（造假数据截图/验收用，
只在本机临时目录操作，不含任何内网信息）。

## 账号数据在哪（重装插件不会动）

| 东西 | 位置 |
| --- | --- |
| 账号凭据（加密） | `~/.magpie-gptfree/pool.enc.json` + `master.key`（容器内 `/config/home/.magpie-gptfree/`） |
| 健康账本 | 同目录 `pool-stats.json` |
| 面板设置 | 同目录 `settings.json`（回复格式 + 图片保留天数；面板上改，重启后还在） |
| 插件代码 | `plugins/node_modules/magpie-gptpool/` |

两个目录完全独立。重装/升级插件只替换后者，`master.key` 不变，加密的账号一定能解开。唯一会丢数据的情况是删掉整个 `~/.magpie-gptfree`。

## 跑在容器里要注意什么

部署机上的升级 / 校验 / 健康检查 / 备份脚本属于运维侧，**不随仓库分发**（同样因为会碰到主机地址和
服务器路径）。这里只留两条容易踩的坑：

- 插件目录在 Magpie 容器里的 `/config/magpie/plugins/node_modules/magpie-gptpool`，宿主机上对应
  `/var/lib/docker/volumes/magpie-config/_data/magpie/plugins/node_modules/magpie-gptpool`。
- **直接改 `~/.magpie-gptfree/` 下的文件时，写完必须 `chown 65532:65532`**。容器以 uid 65532 运行，
  属主不对的话插件读不到，表现是 `/api/health` 里所有账号变成「未检测」、额度全 0。

## 许可

上游 `package.json` 写的是 MIT，但仓库里没有 LICENSE 文件。本仓 0.8.0 起补了 [`LICENSE`](./LICENSE)：MIT 全文 + 上游版权行（`Copyright (c) 2026 yang0`）+ 本仓版权行。MIT 允许 fork、改名、再发布，前提就是保留这份声明。
