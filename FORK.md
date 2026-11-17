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
- 我们自己的版本号在 `package.json` 里往上走（当前 `0.8.11`），和上游版本号不是一套；Magpie 比的是 commit，不是版本号。

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
| `lib/chat-image-bridge.mjs` | **新增**。把打到 `/v1/chat/completions` 的图片模型桥到 `/images/generations` 或 `/images/edits`，PNG 落盘到 `/config/images`，回一条 `chat.completion`，正文默认是**内联图 + 紧跟一行裸地址**（`n>1` 时每张图一组、组间空一行，流式与非流式一致）。为什么两样都给：客户端「复制」复制的是正文文本，只给 markdown 的话粘到微信/文档里是一行源码；而图片是框架自己画的、没有「拷贝图像」，位图进不了剪贴板 —— 服务端只有文本这一个杠杆，所以图负责渲染、地址负责复制转发。形态在面板「回复格式」里选（`lib/reply-settings.mjs`，存 `settings.json`，重启后还在），环境变量 `MAGPIE_GPTFREE_IMAGE_REPLY` 优先、用来强制覆盖（此时面板下拉置灰并说明原因）。**0.8.10 起 `n>1` 真的出多张**：上游单次只出一张（原生接口的 `n` 是 magpie 网关在外面循环的），所以桥接层并发打 n 次、每次 `n:1`，并发上限 2（对齐 `auth.maxConcurrency`），顺序按提交顺序拼；**部分成功也返回**，只在全部失败时才报错。超时类错误映射成 400 + `code`，避免网关把一次失败重试成两次。 |
| `lib/cleanup-log.mjs` | **0.8.13 新增**。清理日志：`~/.magpie-gptfree/cleanup-log.jsonl`，一行一条，0600，只记**数量 / 字节 / 触发方式 / 参数**，不记文件名（文件名是随机 hash，记了只会让日志膨胀）。三种触发方式：`auto`（保留期定时清理）、`manual-purge`（早于 N 天）、`manual-delete`（删除选中）。追加和裁剪串行化（两个 prune 同时跑时，裁剪不能把刚写的行读漏）；每写一条读一遍文件，超过 500 条就只留最近 500 —— 写日志的频率是「每次清理一次」，读几十 KB 可以忽略，换来的是面板上「只留最近 500 条」永远是真的。半截行 / 手改坏的行跳过，不让整份日志读不出来。 |
| `lib/image-error-log.mjs` | **0.8.15 新增**。生图错误日志：`~/.magpie-gptfree/image-errors.jsonl`，一行一条，0600，只留最近 500 条。每次失败记一条，`kind` 分两种：`account`（单个号，`{ at, kind, code, tag, requestId, status, upstreamStatus, message }`）与 `request`（整单汇总，`{ at, kind, code, requestId, status, attempted, poolSize, skipped, ms, message }`，只在整单失败时写） —— 时间、账号槽位（`s<sha256前10位>`，永不落邮箱明文）、归类后的错误码、上游 HTTP 状态码、**脱敏后的上游原文**（走 `sanitizeStatsMessage`，去 token/邮箱/URL、压平换行、截断 240 字）。为什么单独一份：`pool-stats.json` 每个号只留**最后一次**失败的 code 与原文，同一个号失败第二次就盖掉了，而「上游只回了文字」这类问题的全部线索就是那句话。只在失败且账本真落盘（`statsFile` 存在）时写，内存账本（测试）不会往 home 丢文件；成功不写。追加与裁剪串行化，坏行跳过不影响整份读取。**`status` 和 `upstreamStatus` 是两个数**：前者是我们归一化后给客户端的（上游回文字时 502），后者是上游真实返回的（通常是 200）——混成一个会把「上游好好的、只是不肯画」看成「上游网关挂了」。**`request` 那条是为了让「没轮到」可见**：池子 20 个号、55 秒只够试 7 个时，`attempted=7 / poolSize=23 / skipped=16` 才不会把预算耗尽误读成「全部号都挂了」。面板能看了：设置页新增「生图错误日志」表（时间 / 账号 / 错误码 / 状态 / 上游原文，账号显示遮罩邮箱、悬停看槽位号），配 `GET /api/image-errors` 与 `POST /api/image-errors/clear`，只在切到设置页时拉一次。 |
| `lib/gui-service.mjs` | 面板本地服务（127.0.0.1:37990）：页面 + 会话能力（CSRF，落盘 24h，跨宿主重启不失效）+ 全部 `/api/*`。**0.8.10 起端口冲突会有限次退避重试**（500/1000/2000/3000ms，约 6.5 秒）—— 从面板热更新插件时新旧 host 的端口会短暂重叠，原来只 bind 一次、失败就永久打不开，只能 `docker restart` 救；只有 `EADDRINUSE` 才重试，重试次数写进错误文案由 `index.mjs` 的 warn 带出去。**0.8.11 起新增图片管理接口**：`/api/images`（分页/排序/日期筛选/统计/`namesOnly`）、`/api/images/delete`（单次上限 500）、`/api/images/purge`（早于 N 天）、`/api/images/file`（缩略图透传）。缩略图那条**不校验会话**：`<img>` 发不出自定义请求头，而端口只监听 127.0.0.1，同一批图本来就由 nginx 公开。列表接口同时回 `retention`（保留天数）与 `cleanup`（自动清理时段），两者都带 `source` / `locked`；`listen()` 时还会挂一个 15 分钟的清理定时器（`close()` 里清掉）。**0.8.13 起**：新增 `/api/images/cleanup-log`（读取）与 `/api/images/cleanup-log/clear`（清空）；`/api/stats` 也带上 `imageRetention` / `imageCleanup` —— 设置页是独立 tab，用户可能一次都没进过图片页，不能等 `/api/images` 才拿到这两个值。**0.8.15 起**：新增 `/api/image-errors`（读，`limit` 上限 500）与 `/api/image-errors/clear`（清空），面板设置页的「生图错误日志」用它。 |
| `lib/image-store.mjs` | **0.8.11 新增**。图片目录的唯一入口：文件名白名单 `^[A-Za-z0-9._-]+\.(png\|jpg\|jpeg\|webp\|gif)$` + `resolve()` 后前缀校验（挡 `../`）、`listImages` 分页与统计、`dailyCounts` 按**本地日期**分桶（用 `getFullYear/getMonth/getDate`，不能用 `toISOString()`，那是 UTC）、`deleteImages` 逐条容错（ENOENT 算成功）、`purgeOlderThanDays`、`pruneOldImages`（每次现读保留天数与清理时段）。目录扫描有 30 秒缓存，删除/落盘后主动失效。**清理时段**：`inCleanupWindow()` 按本地小时判断，`from > to` 视为跨午夜（22→6）；`pruneOldImages` 在时段外直接返回 `{ skipped: true, reason: "window" }`，`force: true` 是手动补跑用的、连时段一起绕过。**另外导出 `startCleanupTimer()`**（15 分钟一跳，`unref()`）——光靠「生图之后顺手清」的话，夜里没人用就永远不会执行，设了时段等于设了个不生效的开关。**0.8.13 起三个删除入口都会写清理日志**：`deleteImages(names, { trigger })` 默认记 `manual-delete`，`purgeOlderThanDays` 传 `trigger: null` 自己记一条带天数的 `manual-purge`（否则会重复两条），`pruneOldImages` 记 `auto`；顺带先 `stat` 出大小再删，返回值多了 `bytes`。日志写完才返回（`appendCleanupLog` 自己吞错），避免「刚删完就看日志」偶发看不到那条。 |
| `lib/reply-settings.mjs` | **0.8.9 新增，0.8.11 扩展**。回复形态（`imageReply.mode`）、图片保留天数（`imageRetentionDays`，1–90）、清理时段（`imageCleanupWindow`，`{ from, to }` 小时区间，默认 `0-24` 全天）读写 `~/.magpie-gptfree/settings.json`；原子写（tmp + rename，0600）并保留其它键。**环境变量优先于面板设置**，返回值带 `source: env\|settings\|default`，env 压着时面板置灰只读。 |
| `lib/codex-pool.mjs` | 选号改成**额度加权轮转**（nginx smooth WRR，持久化 credit）+ **熔断**（连续失败指数退避 10min→1h）。判死号排到兜底队列最后。图片路径把失败原因分成"请求的错"和"账号的错"。额度打到 0、上游重置时间过后**自动后台复检**（禁用重新登录，绝不触发 MFA）。**0.8.15 起**生图失败时在 `onAccountResult` 里顺手写一条 `lib/image-error-log.mjs` 的错误日志（`await` 等它写完，一次失败多几毫秒无所谓，但「日志里一定有这条」很重要）。 |
| `lib/pool-stats.mjs` | 健康账本：`consecutiveFails` / `cooldownUntil` / `failSince` / `lastSuccessAt` / `authFails` / `deadAt`。四条判死规则：`auth`（授权连续失败 2 次 —— 生图调用里的 `unauthorized` 和额度检测里的 `mfa_verify_failed_403` 都算，超时/连不上不算）、`never`（一次没成过但失败 ≥15 次）、`stale`（72h 没成功）、`marked`。额度检测成功可复活 `auth` 类死号并清零连续失败。按天账本保留期 14 → **400 天**（约 13 个月，够按年看，也不至于每次记账都重写一个大文件），`history` 改为返回保留期内的全部天，由前端聚合成周/月/年。 |
| `lib/chatgpt-web-image.mjs` | 单次 35s / 整单 55s 硬预算（`AbortController` + `Promise.race`，重新登录也算在预算里）；额度耗尽的 400 换号而不是整个请求失败；解析"上限将在 21小时 后重置"得到 `retryAfter`。 |
| `lib/chatgpt-web-text.mjs` | 单次尝试压到 60s 且不超过剩余预算（worker 默认 180s 比整单 120s 还长）；文本选号排除「重新登录都过不去」的号，但**不**套用图片的熔断/额度状态，并用自己的轮转账本，不干扰图片按额度加权。 |
| `lib/credentials.mjs` | 账号行分隔符从"3 个以上连字符"放宽到 `----` / `---` / `--` 三种，同一文件可混写（邮箱和 Base32 密钥都不含 `-`，所以 `--` 在前三列不会切错）。五字段行仍要求 `----`：JWT 签名里本身可能出现 `--`，用 `--` 切会切坏 token，这种行直接报错而不是悄悄导错。 |
| `gui/app.js` | 失效徽章区分三种失效原因并给出对应的复活提示；趋势图把生图与文本分开计数，并支持 **按日 / 按周 / 按月 / 按年** 切换（周从周一起算，窗口内没有数据的天也画成空柱），**每根柱顶上直接标「成功数 / 失败数」**，不悬停也能读。**0.8.7 起前端收敛成一条数据流**（一次 `/api/stats` → `renderAll()`），首页把原「我的账号池」和「额度统计」两张表合成一张：账号按状态分六组、可折叠、带搜索/分组/排序，批量栏常驻。Token 徽章是 **`Token 已确认` / `Token 未确认`**（只认上游真实证据：额度检测通过或成功出过图，且晚于最近一次换 Token），额度状态徽章是 **`额度可用` / `已限流` / `冷却到期` / `需先续期` / `额度查询失败` / `额度待检测` / `已失效`**，剩余额度单独一列，徽章里不再重复数字。批量删除的确认框是**自绘**（`confirmAction`）：页面跑在 Magpie 的沙箱 iframe 里（`Origin: null`，没有 `allow-modals`），原生 `confirm()` 会被浏览器直接丢弃并返回 false，表现就是「点了批量删除没反应」。**0.8.13 起导航重排**：「导入账号」不是 tab（它是一次性动作，不是「一直待着看」的视图），挪到导航右侧做成主按钮；tab 收成 总览 / 图片 / 设置，导入页没有 tab 时按钮自带一圈 `is-on` 高亮。号池为空时 `renderEmptyState()` 收起账号表 / 筛选 / 批量栏 / 失效分类，换一张引导卡 —— 否则六个统计数字全是 0，看着像页面坏了。设置页（回复格式 / 保留天数 / 清理时段 / 立即清理 / 清理日志）复用同一份 `imageState`，`/api/stats` 下发即渲染，切过去不用再等请求。 |
| `gui/style.css` / `gui/dashboard.html` | 0.8.7 重做视觉：主色换成**深青**（亮/暗两套 CSS 变量，`#0f6e56` 只做品牌色，语义绿仍归「成功」），导航收成 tab（切换不发请求），表格改 `table-layout: fixed` + sticky 表头 + 可折叠分组行，窄屏逐级隐藏次要列。**0.8.11 起多一个「图片」tab**：统计卡（总张数/总占用/最早/最晚）+ 近 14 天柱状图 + 排序与日期筛选 + 批量栏（删除选中 / 清理早于 N 天 / 全选筛选结果）+ 分页列表，缩略图 `loading="lazy"`，表格 `max-height` 取「表头 + 8 行」的整数值，避免底部露出半行。**列表 / 网格两种视图**共用一份 `imageState`（选中集合、拖动框选、分页都在状态里），切换只换渲染器不重新请求；网格不设 `max-height`（卡片高度随宽度变，硬卡会切出半行缩略图）。**0.8.13 起**：导航改成 `.tabs-bar`（左边 tab、右边 `+ 导入账号`），新增 `.empty-cta`（空号池引导）、`.settings-card` / `.settings-row`（设置页）、`.cleanup-table`（清理日志表）；图片页头部只留「清理设置」「刷新」，保留天数与清理时段搬到设置页，免得配置散在两处。 |
| `test/*` | 155 个用例，覆盖轮转比例、冷却阶梯、失败分类、判死与复活、授权失败判死（含额度检测里的 MFA 403）、预算超时、额度 400 换号、额度复检守卫、文本链路、按天统计、限流生命周期、导入格式（含 2 连字符）、面板分组/排序控件、批量接口、面板端口重试与恢复、图片桥的正文形态（both 分组 / 多图并发与顺序 / 部分成功 / 全失败 / 流式 / 面板设置读写 / 环境变量覆盖 / markdown 回退），以及图片页的文件名白名单、分页排序筛选、本地日期分桶、逐条容错删除、按天清理、保留天数与清理时段现读设置、时段窗口（含跨午夜与右开区间）、三个图片接口的端到端流程，还有清理日志的字段归一化 / 新旧排序 / 500 条裁剪 / 清空 / 三个删除入口各写一条且不重复。 |

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
MAGPIE_GPTFREE_MAX_TOTAL_MS       单张图的预算（换号重试也算在里面），默认 55000。
                                  注意是**每张图一份**：n>1 是并发打多次，各自计时，不会叠加
MAGPIE_GPTFREE_GUI_DEBUG          设 1 时输出面板端口重试的调试日志（默认不输出，避免刷屏）
MAGPIE_GPTFREE_ATTEMPT_TIMEOUT_MS 单次超时，默认 35000
MAGPIE_GPTFREE_MAX_SLOW_FAILOVERS 慢失败最多换几次号，默认 2
MAGPIE_GPTFREE_TEXT_ATTEMPT_MS    文本单次尝试上限，默认 60000
MAGPIE_GPTFREE_TZ_OFFSET_MIN      按天统计的时区偏移，默认 -480（UTC+8）
MAGPIE_GPTFREE_HEALTH_MIN_USABLE  /api/health 判不健康的可用号下限，默认 3
MAGPIE_GPTFREE_HEALTH_MIN_QUOTA   同上，总剩余额度下限，默认 50
```

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
