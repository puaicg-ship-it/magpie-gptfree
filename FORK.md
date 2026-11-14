# 这是我们的分支，不是上游

基于上游 [`yang0/magpie-gptfree`](https://github.com/yang0/magpie-gptfree) **0.6.6 / commit `5ab9b99`**（分支 `upstream-0.6.6` 记录了基线）。

- `main` = 上游 0.6.6，只用来跟上游对比。
- `patch/chat-image-bridge` = **我们的代码，仓库默认分支**。Magpie 里装这个仓，默认拿到的就是它。

## 我们改了什么

| 文件 | 改动 |
| --- | --- |
| `lib/chat-image-bridge.mjs` | **新增**。把打到 `/v1/chat/completions` 的图片模型桥到 `/images/generations` 或 `/images/edits`，PNG 落盘到 `/config/images`，回一条带 markdown 图片链接的 `chat.completion`。超时类错误映射成 400 + `code`，避免网关把一次失败重试成两次。 |
| `lib/codex-pool.mjs` | 选号改成**额度加权轮转**（nginx smooth WRR，持久化 credit）+ **熔断**（连续失败指数退避 10min→1h）。判死号排到兜底队列最后。图片路径把失败原因分成"请求的错"和"账号的错"。额度打到 0、上游重置时间过后**自动后台复检**（禁用重新登录，绝不触发 MFA）。 |
| `lib/pool-stats.mjs` | 健康账本：`consecutiveFails` / `cooldownUntil` / `failSince` / `lastSuccessAt` / `authFails` / `deadAt`。四条判死规则：`auth`（重新登录连续失败）、`never`（一次没成过但失败 ≥15 次）、`stale`（72h 没成功）、`marked`。额度检测成功可复活 `auth` 类死号。 |
| `lib/chatgpt-web-image.mjs` | 单次 35s / 整单 55s 硬预算（`AbortController` + `Promise.race`，重新登录也算在预算里）；额度耗尽的 400 换号而不是整个请求失败；解析"上限将在 21小时 后重置"得到 `retryAfter`。 |
| `lib/chatgpt-web-text.mjs` | 单次尝试压到 60s 且不超过剩余预算（worker 默认 180s 比整单 120s 还长）；文本选号排除「重新登录都过不去」的号，但**不**套用图片的熔断/额度状态，并用自己的轮转账本，不干扰图片按额度加权。 |
| `gui/app.js` | 额度统计页的失效徽章，区分三种失效原因并给出对应的复活提示。 |
| `test/*` | 116 个用例，覆盖轮转比例、冷却阶梯、失败分类、判死与复活、预算超时、额度 400 换号、额度复检守卫、文本链路、按天统计、限流生命周期、批量接口。 |

环境变量（都有默认值，一般不用设）：

```
MAGPIE_GPTFREE_IMAGE_DIR          PNG 落盘目录，默认 /config/images
MAGPIE_GPTFREE_PUBLIC_BASE        图片链接前缀，默认空 = 返回相对路径 /img/xxx.png
                                  要绝对地址就设成 https://你的域名（结尾斜杠会去掉）
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

```bash
git fetch upstream
git log --oneline upstream/main ^main          # 上游新提交
git diff upstream/main..HEAD -- lib/           # 我们的改动有没有跟上游撞
git merge upstream/main                        # 在 patch/chat-image-bridge 上合
```

合完重点看三个文件有没有被上游改过：`codex-pool.mjs`、`pool-stats.mjs`、`chatgpt-web-image.mjs`。上游动了这三处，就要人工过一遍我们的改动，别机械解冲突。

## 怎么装、怎么升级

**Magpie 里这个插件的安装源就是这个仓**，spec 写在 `plugins.json`：

```json
{ "spec": "https://github.com/puaicg-ship-it/magpie-gptfree" }
```

没有 `#<commit>` 就是跟默认分支（`patch/chat-image-bridge`）走。这意味着：

- 上游推新提交**不会再影响我们** —— Magpie 比的是这个仓的 commit，不是 `yang0/magpie-gptfree`。
- 我们自己推了新提交，面板上会出现「有更新」，点一下或跑 `magpie plugin update` 就升到我们的新代码，**不会把改动覆盖掉**（改动本来就在仓里）。
- 想彻底不再提示更新，把 spec 改成 `https://github.com/puaicg-ship-it/magpie-gptfree#<完整 commit sha>`。Magpie 的 `refFixed()` 认 `#` 后面的十六进制 SHA，钉住之后不再解析任何 ref。

**升级流程**：本地改完 → 跑测试 → push 到 `patch/chat-image-bridge` → 面板点更新（或 `magpie plugin update`）→ 重启 Magpie。

## 账号数据在哪（重装插件不会动）

| 东西 | 位置 |
| --- | --- |
| 账号凭据（加密） | `~/.magpie-gptfree/pool.enc.json` + `master.key`（容器内 `/config/home/.magpie-gptfree/`） |
| 健康账本 | 同目录 `pool-stats.json` |
| 插件代码 | `plugins/node_modules/magpie-gptfree/` |

两个目录完全独立。重装/升级插件只替换后者，`master.key` 不变，加密的账号一定能解开。唯一会丢数据的情况是删掉整个 `~/.magpie-gptfree`。

## 服务器上怎么用

部署机的 Magpie 里，插件目录是 `/config/magpie/plugins/node_modules/magpie-gptfree`（宿主机 `/var/lib/docker/volumes/magpie-config/_data/magpie/plugins/node_modules/magpie-gptfree`）。

- `/root/verify-gptfree-patch.sh` —— 校验我们的代码在位（退出码 0 表示正常）。安装源切过来之后正常情况下永远通过。
- `/root/fix-gptfree-chat-image.sh` —— 确保跑的是我们的代码。**现在会先看 spec**：指向本仓就跑 `magpie plugin update`，指向上游才用 `/root/gptfree-patch/` 里的镜像文件覆盖（并提示把 spec 改回来）。镜像可能落后于仓库，所以优先走更新。
- `/root/check-gptfree-health.sh` —— 池子容量健康检查，退出码 0/1。
- `/root/gptfree-health-cron.sh` —— cron 包装，每 10 分钟一次；异常写 `/var/log/gptfree-health.log` 并送 syslog（`logger -t gptfree-health`），恢复时记一条 RECOVERED。
- 备份：`/root/gptfree-backup/`（`vault-*.tar.gz` 是凭据，`plugin-dir-*.tar.gz` 是插件目录，`plugins.json.*` 是配置，`container-*.json` 是容器配置）。

**注意**：直接改 `~/.magpie-gptfree/` 下的文件时，写完必须 `chown 65532:65532`。容器以 uid 65532 运行，属主不对的话插件读不到，表现是 `/api/health` 里所有账号变成「未检测」、额度全 0。

## 许可

上游 `package.json` 写的是 MIT，但仓库里没有 LICENSE 文件。本仓为公开仓，沿用上游 MIT 条款。
