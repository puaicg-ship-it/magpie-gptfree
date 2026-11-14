# 这是我们的分支，不是上游

基于上游 [`yang0/magpie-gptfree`](https://github.com/yang0/magpie-gptfree) **0.6.6 / commit `5ab9b99`**（分支 `upstream-0.6.6` 记录了基线）。

- `main` = 上游 0.6.6，只用来跟上游对比。
- `patch/chat-image-bridge` = **我们的代码，仓库默认分支**。Magpie 里装这个仓，默认拿到的就是它。

## 我们改了什么

| 文件 | 改动 |
| --- | --- |
| `lib/chat-image-bridge.mjs` | **新增**。把打到 `/v1/chat/completions` 的图片模型桥到 `/images/generations` 或 `/images/edits`，PNG 落盘到 `/config/images`，回一条带 markdown 图片链接的 `chat.completion`。超时类错误映射成 400 + `code`，避免网关把一次失败重试成两次。 |
| `lib/codex-pool.mjs` | 选号改成**额度加权轮转**（nginx smooth WRR，持久化 credit）+ **熔断**（连续失败指数退避 10min→1h）。判死号排到兜底队列最后。图片路径把失败原因分成"请求的错"和"账号的错"。 |
| `lib/pool-stats.mjs` | 健康账本：`consecutiveFails` / `cooldownUntil` / `failSince` / `lastSuccessAt` / `authFails` / `deadAt`。四条判死规则：`auth`（重新登录连续失败）、`never`（一次没成过但失败 ≥15 次）、`stale`（72h 没成功）、`marked`。额度检测成功可复活 `auth` 类死号。 |
| `lib/chatgpt-web-image.mjs` | 单次 35s / 整单 55s 硬预算（`AbortController` + `Promise.race`，重新登录也算在预算里）；额度耗尽的 400 换号而不是整个请求失败；解析"上限将在 21小时 后重置"得到 `retryAfter`。 |
| `gui/app.js` | 额度统计页的失效徽章，区分三种失效原因并给出对应的复活提示。 |
| `test/*` | 19 个新用例，覆盖轮转比例、冷却阶梯、失败分类、判死与复活、预算超时、额度 400 换号。 |

环境变量（都有默认值，一般不用设）：

```
MAGPIE_GPTFREE_IMAGE_DIR          PNG 落盘目录，默认 /config/images
MAGPIE_GPTFREE_MAX_TOTAL_MS       整单预算，默认 55000
MAGPIE_GPTFREE_ATTEMPT_TIMEOUT_MS 单次超时，默认 35000
MAGPIE_GPTFREE_MAX_SLOW_FAILOVERS 慢失败最多换几次号，默认 2
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

## 服务器上怎么用

`example.com` 的 Magpie 里，插件目录是 `/config/magpie/plugins/node_modules/magpie-gptfree`（宿主机 `/var/lib/docker/volumes/magpie-config/_data/magpie/plugins/node_modules/magpie-gptfree`）。

- `/root/fix-gptfree-chat-image.sh` —— 从 `/root/gptfree-patch/` 覆盖五个文件并重启 Magpie。**这是过渡手段**，等这里安装源切换完成就可以退役。
- `/root/verify-gptfree-patch.sh` —— 校验补丁在位（退出码 0 表示正常）。
- 备份：`/root/gptfree-backup-*.tgz`。

## 许可

上游 `package.json` 写的是 MIT，但仓库里没有 LICENSE 文件。本仓为私有仓，仅内部使用。
