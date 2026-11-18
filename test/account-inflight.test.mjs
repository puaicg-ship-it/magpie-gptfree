import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  accountInflight,
  accountInflightSnapshot,
  clearAccountInflight,
  isAccountSaturated,
  noteAccountInflight,
} from "../lib/account-inflight.mjs";

// 这个 Map 是进程级的（跨请求共享），每个用例先清空。
const reset = () => clearAccountInflight();

test("inflight counts go up and down without ever going negative", () => {
  reset();
  assert.equal(accountInflight("a@example.com"), 0);
  assert.equal(noteAccountInflight("a@example.com", 1), 1);
  assert.equal(noteAccountInflight("a@example.com", 1), 2);
  assert.equal(noteAccountInflight("a@example.com", -1), 1);
  // 多减只归零：一个异常的 finally 不能把计数打成负数，否则这个号会被
  // 当成「永远空闲」，并发闸就失效了。
  assert.equal(noteAccountInflight("a@example.com", -5), 0);
  assert.equal(accountInflight("a@example.com"), 0);
});

test("different accounts are counted independently", () => {
  reset();
  noteAccountInflight("a@example.com", 1);
  noteAccountInflight("b@example.com", 1);
  noteAccountInflight("b@example.com", 1);
  assert.equal(accountInflight("a@example.com"), 1);
  assert.equal(accountInflight("b@example.com"), 2);
  assert.equal(accountInflightSnapshot().length, 2);
  clearAccountInflight();
  assert.equal(accountInflight("a@example.com"), 0);
});

test("junk identifiers are treated as idle instead of creating entries", () => {
  reset();
  for (const bad of ["", "   ", null, undefined, 42, {}]) {
    assert.equal(accountInflight(bad), 0);
    noteAccountInflight(bad, 1);
  }
  assert.equal(accountInflightSnapshot().length, 0, "认不出来的标识不该在 Map 里留下垃圾");
});

test("saturation compares against the limit, and a zero limit means unlimited", () => {
  reset();
  noteAccountInflight("a@example.com", 1);
  assert.equal(isAccountSaturated("a@example.com", 1), true);
  assert.equal(isAccountSaturated("a@example.com", 2), false);
  // 0 / 负数 / 非数字 = 不限制（这也是「老行为」的开关）
  assert.equal(isAccountSaturated("a@example.com", 0), false);
  assert.equal(isAccountSaturated("a@example.com", -1), false);
  assert.equal(isAccountSaturated("a@example.com", null), false);
  assert.equal(isAccountSaturated("a@example.com", "abc"), false);
});
