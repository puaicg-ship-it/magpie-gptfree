import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const SCRIPT = new URL("../scripts/release.sh", import.meta.url);
const UPDATE = new URL("../scripts/update-server.sh", import.meta.url);
const UPSTREAM = new URL("../scripts/upstream-status.sh", import.meta.url);
const source = () => readFile(SCRIPT, "utf8");

test("所有脚本语法正确", () => {
  // bash -n 只解析不执行
  for (const script of [SCRIPT, UPDATE, UPSTREAM]) {
    execFileSync("bash", ["-n", script.pathname], { stdio: "pipe" });
  }
});

test("上游追踪脚本按「撞不撞我们的改动」分级", async () => {
  const text = await readFile(UPSTREAM, "utf8");
  // 只报"落后几个提交"没用，得知道会撞哪儿
  assert(text.includes("merge-base"), "要用分叉点算差异，不能拿 upstream/main 直接比");
  assert(text.includes("git diff --name-only"), "要算出我们改过的文件集合");
  assert(text.includes("is_code"), "撞代码和撞文档要分开，否则上游改个 README 也报高风险");
  assert(text.includes("--quiet"), "定时任务需要只在落后时输出");
  assert(text.includes("exit 1"), "落后时退出码要非 0，定时任务才能判断");
});

test("服务器更新脚本语法正确，且指向部署机上的更新脚本", async () => {
  execFileSync("bash", ["-n", UPDATE.pathname], { stdio: "pipe" });
  const text = await readFile(UPDATE, "utf8");
  assert(text.includes("/root/gptfree-update-plugin.sh"), "必须复用部署机上那份脚本");
  // 别再退回 magpie plugin update：它对 git 插件不推进 commit，只会假装成功
  assert(!/magpie plugin update/.test(text.replace(/^#.*$/gm, "")),
    "不要用 magpie plugin update，它不会推进 git 插件的 commit");
});

test("脚本里没有 \$VAR 紧跟中文的写法", async () => {
  // bash 对多字节字符的变量名边界判断不可靠：`$VERSION：xxx` 会被当成变量
  // `VERSION：`，set -u 下直接 unbound variable 中止。踩过两次（tag 消息、
  // 钥匙串提示），这里加个回归守卫，新写文案时立刻能发现。
  const offenders = [];
  for (const script of [SCRIPT, UPDATE, UPSTREAM]) {
    const text = await readFile(script, "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (line.trimStart().startsWith("#")) continue;
      for (const match of line.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/g)) {
        offenders.push(`${script.pathname.split("/").pop()} 第 ${index + 1} 行: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "请写成 ${VAR} 再跟中文：" + offenders.join("；"));
});

test("发版脚本覆盖发版必需的动作", async () => {
  const text = await source();
  for (const needle of [
    "node --test --test-concurrency=1",   // 先跑测试
    '"version":',                          // 升 package.json
    "CHANGELOG.md",                        // 写更新记录
    "git tag -a",                          // 打 tag
    "--follow-tags",                       // 连 tag 一起推
    "--dry-run",                           // 空跑
    "--save-token",                        // 钥匙串
    "gptfree-update-plugin.sh",            // 部署机
    "LOCAL_TOKEN_FILE",                    // 允许"就放在脚本旁边"的 token 文件
    "create_release",                      // Release 步骤抽成函数，才能单独补建
    "--only-release",                      // 补建已有 tag 的 Release
  ]) {
    assert(text.includes(needle), "缺少：" + needle);
  }
});

test("--only-release 只补 Release，不动版本", async () => {
  const text = await source();
  const start = text.indexOf('if [ "$ONLY_RELEASE" = 1 ]');
  assert(start > 0, "缺少 --only-release 分支");
  // 分支体到下一个空行段落为止
  const body = text.slice(start, text.indexOf("\nfi\n", start));
  assert(body.includes("create_release"), "补建分支必须复用 create_release");
  assert(!body.includes("git commit"), "补建分支不能提交");
  assert(!body.includes("git push"), "补建分支不能推送");
  // 版本号检查要在补建分支之前，否则 --only-release 拿不到版本
  assert(text.indexOf("缺少版本号") < start, "版本号检查应在补建分支之前");
});

test("Release 正文优先取 docs/releases，其次 CHANGELOG", async () => {
  const text = await source();
  assert(text.includes("docs/releases/v${v}.md"), "应优先读 docs/releases/v<版本>.md");
  assert(text.includes("## [${v}]"), "没有长文时应回落到 CHANGELOG 对应小节");
  // 422 说明 Release 已存在，重复执行不该报失败
  assert(text.includes("422"), "重复建 Release 要当成功处理");
  // 403 多半是 fine-grained token 少了 Contents 写权限，得说清楚
  assert(text.includes("Contents"), "403 时要提示缺 Contents 写权限");
});

test(".gitignore 兜住了 token 文件", async () => {
  // 万一有人把 token 放进仓库目录，git add -A 也不能把它带走。
  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  for (const pattern of ["*.release-token", "*.token", ".magpie-gptpool-release-token"]) {
    assert(ignore.includes(pattern), ".gitignore 缺少：" + pattern);
  }
});
