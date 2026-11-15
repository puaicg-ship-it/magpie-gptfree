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
- 我们自己的版本号在 `package.json` 里往上走（当前 `0.8.7`），和上游版本号不是一套；Magpie 比的是 commit，不是版本号。

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
| `lib/chat-image-bridge.mjs` | **新增**。把打到 `/v1/chat/completions` 的图片模型桥到 `/images/generations` 或 `/images/edits`，PNG 落盘到 `/config/images`，回一条 `chat.completion`，正文是**纯图片地址**（`n>1` 时一行一个，流式与非流式一致）。之所以不再回 `![image](...)`：客户端「复制」复制的是正文文本，markdown 源码粘到微信/文档里还是一行源码，而图片是框架自己画的、没有「拷贝图像」，位图进不了剪贴板 —— 服务端只能改文本，那就让复制出来的东西能直接用（代价是聊天里不再内联显示，要点开链接看原图，这是刻意取舍）。`MAGPIE_GPTFREE_IMAGE_REPLY=markdown` 可退回旧行为。超时类错误映射成 400 + `code`，避免网关把一次失败重试成两次。 |
| `lib/codex-pool.mjs` | 选号改成**额度加权轮转**（nginx smooth WRR，持久化 credit）+ **熔断**（连续失败指数退避 10min→1h）。判死号排到兜底队列最后。图片路径把失败原因分成"请求的错"和"账号的错"。额度打到 0、上游重置时间过后**自动后台复检**（禁用重新登录，绝不触发 MFA）。 |
| `lib/pool-stats.mjs` | 健康账本：`consecutiveFails` / `cooldownUntil` / `failSince` / `lastSuccessAt` / `authFails` / `deadAt`。四条判死规则：`auth`（授权连续失败 2 次 —— 生图调用里的 `unauthorized` 和额度检测里的 `mfa_verify_failed_403` 都算，超时/连不上不算）、`never`（一次没成过但失败 ≥15 次）、`stale`（72h 没成功）、`marked`。额度检测成功可复活 `auth` 类死号并清零连续失败。按天账本保留期 14 → **400 天**（约 13 个月，够按年看，也不至于每次记账都重写一个大文件），`history` 改为返回保留期内的全部天，由前端聚合成周/月/年。 |
| `lib/chatgpt-web-image.mjs` | 单次 35s / 整单 55s 硬预算（`AbortController` + `Promise.race`，重新登录也算在预算里）；额度耗尽的 400 换号而不是整个请求失败；解析"上限将在 21小时 后重置"得到 `retryAfter`。 |
| `lib/chatgpt-web-text.mjs` | 单次尝试压到 60s 且不超过剩余预算（worker 默认 180s 比整单 120s 还长）；文本选号排除「重新登录都过不去」的号，但**不**套用图片的熔断/额度状态，并用自己的轮转账本，不干扰图片按额度加权。 |
| `lib/credentials.mjs` | 账号行分隔符从"3 个以上连字符"放宽到 `----` / `---` / `--` 三种，同一文件可混写（邮箱和 Base32 密钥都不含 `-`，所以 `--` 在前三列不会切错）。五字段行仍要求 `----`：JWT 签名里本身可能出现 `--`，用 `--` 切会切坏 token，这种行直接报错而不是悄悄导错。 |
| `gui/app.js` | 失效徽章区分三种失效原因并给出对应的复活提示；趋势图把生图与文本分开计数，并支持 **按日 / 按周 / 按月 / 按年** 切换（周从周一起算，窗口内没有数据的天也画成空柱），**每根柱顶上直接标「成功数 / 失败数」**，不悬停也能读。**0.8.7 起前端收敛成一条数据流**（一次 `/api/stats` → `renderAll()`），首页把原「我的账号池」和「额度统计」两张表合成一张：账号按状态分六组、可折叠、带搜索/分组/排序，批量栏常驻。Token 徽章是 **`Token 已确认` / `Token 未确认`**（只认上游真实证据：额度检测通过或成功出过图，且晚于最近一次换 Token），额度状态徽章是 **`额度可用` / `已限流` / `冷却到期` / `需先续期` / `额度查询失败` / `额度待检测` / `已失效`**，剩余额度单独一列，徽章里不再重复数字。批量删除的确认框是**自绘**（`confirmAction`）：页面跑在 Magpie 的沙箱 iframe 里（`Origin: null`，没有 `allow-modals`），原生 `confirm()` 会被浏览器直接丢弃并返回 false，表现就是「点了批量删除没反应」。 |
| `gui/style.css` / `gui/dashboard.html` | 0.8.7 重做视觉：主色换成**深青**（亮/暗两套 CSS 变量，`#0f6e56` 只做品牌色，语义绿仍归「成功」），导航收成 **「总览 / 导入账号」两个 tab**（切换不发请求），表格改 `table-layout: fixed` + sticky 表头 + 可折叠分组行，窄屏逐级隐藏次要列。导入页功能没动，只是从「首页」降级成第二个 tab。 |
| `test/*` | 134 个用例，覆盖轮转比例、冷却阶梯、失败分类、判死与复活、授权失败判死（含额度检测里的 MFA 403）、预算超时、额度 400 换号、额度复检守卫、文本链路、按天统计、限流生命周期、导入格式（含 2 连字符）、面板分组/排序控件、批量接口，以及图片桥的正文形态（纯地址 / 多图换行 / 流式 / markdown 回退）。 |

环境变量（都有默认值，一般不用设）：

```
MAGPIE_GPTFREE_IMAGE_DIR          PNG 落盘目录，默认 /config/images
MAGPIE_GPTFREE_PUBLIC_BASE        图片链接前缀，默认空 = 返回相对路径 /img/xxx.png
                                  要绝对地址就设成 https://你的域名（结尾斜杠会去掉）
MAGPIE_GPTFREE_IMAGE_REPLY        正文形态，默认 url（一行一个纯地址）；
                                  设成 markdown 退回 `![image](...)` 内联图
MAGPIE_GPTFREE_MAX_TOTAL_MS       整单预算，默认 55000
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
scripts/upstream-status.sh
```

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

> 分叉点现在是 `5ab9b99`（我们领先 42 个提交）。`upstream-status.sh` 用 `merge-base` 算分叉点，
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

本地一条命令等价（走 `panel` 跳板，跑完会核对线上版本）：

```bash
scripts/update-server.sh
```

> 地址变迁（2026-11）：`puaicg-ship-it/magpie-gptfree` → 账号改名 → `puaicg/magpie-gptfree` → 仓库改名 → **`puaicg/magpie-gptpool`**。
> 前两个地址都是 301 重定向，老机器上装着的旧 spec 不会立刻坏，但 `bun` 会把解析结果写成旧 URL，
> 建议顺手把 spec 换成新地址再跑一次更新。

> ⚠️ 别用 `magpie plugin update`。它走 bun 的「按 lockfile 重装」路径：同一个 URL 已经解析过时
> 不会重新去 GitHub 取，会静默停在旧 commit 上（实测推了新提交后它仍打印 `✓ plugins updated`，
> 实际没动）。`bun update <包名>` 才会重新解析。`gptfree-update-plugin.sh` 做的就是
> `bun update magpie-gptpool` + 重启 + 校验，一条命令搞定。

## 怎么发版

```bash
cd ~/Documents/magpie-gptpool
./scripts/release.sh 0.8.5 "改动一" "改动二"          # 发版
./scripts/release.sh 0.8.5 "改动一" --deploy          # 发完顺手部署到 example.com
./scripts/release.sh 0.8.5 "改动一" --release         # 顺便建 GitHub Release
./scripts/release.sh 0.8.5 "改动一" --dry-run         # 只看要做什么
```

脚本会：校验分支/工作区 → `npm run check` + 全部测试 → 升 `package.json` → 改 README 徽章 →
在 CHANGELOG 顶部插一节 → `commit` → `git tag -a vX.Y.Z` → `push --follow-tags`。
测试不过就中止，不写任何文件。

**GitHub token（建 Release 才需要）**：别写进仓库里的任何文件 —— 发版脚本自己会 `git add -A`
并提交，token 会被推到公开仓库，GitHub 的 secret scanning 还会直接吊销它。正确做法是
`./scripts/release.sh --save-token`，交互输入（不回显、不进 shell 历史），macOS 存钥匙串，
其他平台写本机文件。取用优先级：

```
GITHUB_TOKEN 环境变量 > gh auth token > macOS 钥匙串
  > scripts/.release-token（仓库内、被 .gitignore 忽略）
  > ~/.magpie-gptpool-release-token（仓库之外）
```

想「就放在脚本旁边」就直接写文件，不用改脚本本身：

```bash
printf 'github_pat_xxx' > scripts/.release-token && chmod 600 scripts/.release-token
```

`scripts/release.sh` 是**被 git 跟踪的文件**，往里写 token 会被它自己的 `git add -A` 提交上去，
不要那么干。

## 账号数据在哪（重装插件不会动）

| 东西 | 位置 |
| --- | --- |
| 账号凭据（加密） | `~/.magpie-gptfree/pool.enc.json` + `master.key`（容器内 `/config/home/.magpie-gptfree/`） |
| 健康账本 | 同目录 `pool-stats.json` |
| 插件代码 | `plugins/node_modules/magpie-gptpool/` |

两个目录完全独立。重装/升级插件只替换后者，`master.key` 不变，加密的账号一定能解开。唯一会丢数据的情况是删掉整个 `~/.magpie-gptfree`。

## 服务器上怎么用

部署机的 Magpie 里，插件目录是 `/config/magpie/plugins/node_modules/magpie-gptpool`（宿主机 `/var/lib/docker/volumes/magpie-config/_data/magpie/plugins/node_modules/magpie-gptpool`）。

- `/root/verify-gptfree-patch.sh` —— 校验我们的代码在位（退出码 0 表示正常）。安装源切过来之后正常情况下永远通过。
- `/root/gptfree-update-plugin.sh` —— **升级用这个**：`bun update` 重新解析到最新提交 + 重启 + 校验。
- `/root/fix-gptfree-chat-image.sh` —— 确保跑的是我们的代码。**现在会先看 spec**：指向本仓就直接 `exec /root/gptfree-update-plugin.sh`；指向上游才用 `/root/gptfree-patch/` 里的镜像文件覆盖（并提示把 spec 改回来）。镜像可能落后于仓库，所以优先走更新。
- `/root/check-gptfree-health.sh` —— 池子容量健康检查，退出码 0/1。
- `/root/gptfree-health-cron.sh` —— cron 包装，每 10 分钟一次；异常写 `/var/log/gptfree-health.log` 并送 syslog（`logger -t gptfree-health`），恢复时记一条 RECOVERED。
- 备份：`/root/gptfree-backup/`（`vault-*.tar.gz` 是凭据，`plugin-dir-*.tar.gz` 是插件目录，`plugins.json.*` 是配置，`container-*.json` 是容器配置）。

**注意**：直接改 `~/.magpie-gptfree/` 下的文件时，写完必须 `chown 65532:65532`。容器以 uid 65532 运行，属主不对的话插件读不到，表现是 `/api/health` 里所有账号变成「未检测」、额度全 0。

## 许可

上游 `package.json` 写的是 MIT，但仓库里没有 LICENSE 文件。本仓 0.8.0 起补了 [`LICENSE`](./LICENSE)：MIT 全文 + 上游版权行（`Copyright (c) 2026 yang0`）+ 本仓版权行。MIT 允许 fork、改名、再发布，前提就是保留这份声明。
