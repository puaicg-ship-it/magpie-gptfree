import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const SCRIPT = new URL("../scripts/release.sh", import.meta.url);
const source = () => readFile(SCRIPT, "utf8");

test("发版脚本语法正确", () => {
  // bash -n 只解析不执行
  execFileSync("bash", ["-n", SCRIPT.pathname], { stdio: "pipe" });
});

test("发版脚本里没有 \$VAR 紧跟中文的写法", async () => {
  // bash 对多字节字符的变量名边界判断不可靠：`$VERSION：xxx` 会被当成变量
  // `VERSION：`，set -u 下直接 unbound variable 中止。踩过两次（tag 消息、
  // 钥匙串提示），这里加个回归守卫，新写文案时立刻能发现。
  const text = await source();
  const offenders = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trimStart().startsWith("#")) continue;
    for (const match of line.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/g)) {
      offenders.push(`第 ${index + 1} 行: ${match[0]}`);
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
  ]) {
    assert(text.includes(needle), "缺少：" + needle);
  }
});
