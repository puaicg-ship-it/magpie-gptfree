/**
 * 浏览器 OAuth 的纯函数部分：PKCE、授权链接、回调解析。
 *
 * 这几条不联网也不开端口，但都是安全边界：state 校验错了就是 CSRF，
 * PKCE challenge 算错了整条授权直接失败。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  buildCodexAuthorizeUrl, extractIdentityFromTokens, generatePkcePair, parseCallbackInput,
} from "../lib/web-oauth.mjs";

test("PKCE challenge 是 verifier 的 S256，不是明文", () => {
  const { verifier, challenge } = generatePkcePair();
  assert.ok(verifier.length >= 43, "verifier 要够长（RFC 7636 要求 43+）");
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.notEqual(challenge, verifier);
});

test("授权链接带上 Codex 必需的参数", () => {
  const url = new URL(buildCodexAuthorizeUrl({
    state: "s1", codeChallenge: "c1", redirectUri: "http://localhost:1455/auth/callback",
  }));
  assert.equal(url.hostname, "auth.openai.com");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "c1");
  assert.equal(url.searchParams.get("state"), "s1");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.match(url.searchParams.get("scope") || "", /offline_access/,
    "没有 offline_access 就拿不到 refresh_token，续期功能等于没做");
});

test("回调可以贴完整链接、查询串或裸授权码", () => {
  const full = parseCallbackInput("http://localhost:1455/auth/callback?code=abc&state=s1", "s1");
  assert.deepEqual(full, { ok: true, code: "abc" });
  const query = parseCallbackInput("?code=abc&state=s1", "s1");
  assert.deepEqual(query, { ok: true, code: "abc" });
  const bare = parseCallbackInput("abcdefgh12345", "s1");
  assert.deepEqual(bare, { ok: true, code: "abcdefgh12345" });
});

test("state 不一致的回调必须拒绝（防 CSRF）", () => {
  const bad = parseCallbackInput("http://localhost:1455/auth/callback?code=abc&state=evil", "s1");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /state/);
  // 回调里根本没带 state 时同样要拒，不能当成空匹配放过。
  const missing = parseCallbackInput("http://localhost:1455/auth/callback?code=abc", "s1");
  assert.equal(missing.ok, false);
});

test("上游拒绝授权时把原因带回来，而不是假装成功", () => {
  const denied = parseCallbackInput("http://localhost:1455/auth/callback?error=access_denied&state=s1", "s1");
  assert.equal(denied.ok, false);
  assert.match(denied.error, /access_denied|拒绝/);
});

test("从 id_token 里解出邮箱和套餐，缺字段时返回空值而不是抛错", () => {
  const idToken = [
    Buffer.from('{"alg":"none"}').toString("base64url"),
    Buffer.from(JSON.stringify({
      email: "who@example.com",
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "acct_1" },
    })).toString("base64url"),
    "sig",
  ].join(".");
  const identity = extractIdentityFromTokens({ idToken });
  assert.equal(identity.email, "who@example.com");
  assert.equal(identity.planType, "plus");
  assert.equal(identity.accountId, "acct_1");
  assert.doesNotThrow(() => extractIdentityFromTokens({}));
});
