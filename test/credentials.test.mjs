import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parseAccounts, splitAccountLine, accessTokenState, totpCode, safeAccountName, validateProxyUrl,
} from "../lib/credentials.mjs";

const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const jwt = (exp) => [
  Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ exp, sub: "test" })).toString("base64url"),
  "signature",
].join(".");

test("format 1: three fields, both separators, and TOTP", () => {
  const a = parseAccounts(`user1@example.com----abc-123----${SEED}\nuser2@example.com---p2---${SEED}`);
  assert.equal(a.accounts.length, 2);
  assert.equal(a.errors.length, 0);
  assert.equal(a.accounts[0].kind, "standard");
  assert.equal(a.accounts[0].password, "abc-123");
  assert.equal(a.accounts[0].totp, SEED);
  assert.equal(a.accounts[1].kind, "standard");
  assert.equal(totpCode(SEED, 59000), "287082"); // RFC 6238 / 6 digits
});

test("format 2: 4th field is a mail link and the URL is never split or auto-used", () => {
  const url = "https://mail.xxx.store/abc---def?ticket=foo----bar";
  const a = parseAccounts(`user1@example.com----secret----${SEED}----${url}`);
  assert.equal(a.accounts.length, 1);
  assert.equal(a.accounts[0].mailUrl, url);
  assert.equal(a.accounts[0].kind, "mail_link");
  assert.equal(a.accounts[0].accessToken, undefined);
  assert.equal(splitAccountLine(`u---p---seed---${url}`).length, 4);
});

test("format 3: JWT is parsed as a candidate, never cryptographically trusted", () => {
  const future = jwt(Math.floor(Date.now() / 1000) + 3600);
  const old = jwt(Math.floor(Date.now() / 1000) - 3600);
  const a = parseAccounts(`user1@example.com----p1----${SEED}----${future}
user2@example.com---p2---${SEED}---${old}`);
  assert.equal(a.accounts.length, 2);
  assert.equal(a.accounts[0].kind, "access_token");
  assert.equal(a.accounts[0].accessToken, future);
  assert.equal(a.accounts[0].tokenState, "unexpired_unverified");
  assert.equal(a.accounts[1].tokenState, "expired");
  assert.equal(accessTokenState(future).state, "unexpired_unverified");
  assert.equal(accessTokenState(old).state, "expired");
  assert.equal(accessTokenState("eyJhbGci-no-dot").state, "invalid");
});

test("format 4: 5-column lines with JWT access_token and refresh_token or mail link", () => {
  const future = jwt(Math.floor(Date.now() / 1000) + 3600);
  const a = parseAccounts([
    `u1@example.com----p1----${SEED}----${future}----rt_secret_token_123`,
    `u2@example.com---p2---${SEED}---Bearer ${future}---https://mail.example.store/inbox`,
  ].join("\n"));
  assert.equal(a.errors.length, 0);
  assert.equal(a.accounts.length, 2);
  assert.equal(a.accounts[0].kind, "access_token");
  assert.equal(a.accounts[0].accessToken, future);
  assert.equal(a.accounts[0].hasRefreshToken, true);
  assert.equal(a.accounts[1].kind, "access_token");
  assert.equal(a.accounts[1].mailUrl, "https://mail.example.store/inbox");
});

test("invalid and duplicate records are reported without secrets", () => {
  const raw = `bademail----secret123----${SEED}
user1@example.com----p1----${SEED}----not-a-token
USER2@EXAMPLE.COM----p2----${SEED}
user2@example.com----p3----${SEED}
`;
  const parsed = parseAccounts(raw);
  assert.equal(parsed.accounts.length, 1);
  assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.errors.length, 2);
  assert.equal(JSON.stringify(parsed.errors).includes("secret123"), false);
  assert.equal(JSON.stringify(parsed.errors).includes("not-a-token"), false);
  assert.equal(safeAccountName("alex@example.com"), "al***@example.com");
});

test("rejects malformed JWT and mail-link credentials in fourth or fifth field", () => {
  const future = jwt(Math.floor(Date.now() / 1000) + 3600);
  const bad = parseAccounts(`a@example.com----p----${SEED}----eyJhbGci
b@example.com----p----${SEED}----https://u:p@mail.example/test
c@example.com----p----${SEED}----
d@example.com----p----${SEED}----${future}----
e@example.com----p----${SEED}----${future}----https://u:p@mail.example/x
`);
  assert.equal(bad.accounts.length, 0);
  assert.equal(bad.errors.length, 5);
});

test("validates optional http(s) proxy URLs safely", () => {
  assert.deepEqual(validateProxyUrl(""), { ok: true, proxy: "" });
  assert.deepEqual(validateProxyUrl("  http://127.0.0.1:7890 "), { ok: true, proxy: "http://127.0.0.1:7890" });
  assert.ok(validateProxyUrl("socks5://127.0.0.1:1080").error);
  assert.ok(validateProxyUrl("http://user:pass@127.0.0.1:7890").error);
  assert.ok(validateProxyUrl("not-a-url").error);
});

test("supports two fields as legacy input but never mistakes a link for TOTP", () => {
  assert.equal(parseAccounts("x@example.com----pw").accounts[0].totp, "");
  assert.equal(parseAccounts("x@example.com----pw----https://mail.test").errors.length, 1);
});

test("accepts the 2-dash line format and mixed separators in one file", () => {
  const line = `ev01g9um4c0@gmx-ist-cool.de--j0qOA4u8om6NKRxp--${SEED}`;
  const a = parseAccounts(line);
  assert.equal(a.errors.length, 0);
  assert.equal(a.accounts.length, 1);
  assert.equal(a.accounts[0].email, "ev01g9um4c0@gmx-ist-cool.de");
  assert.equal(a.accounts[0].password, "j0qOA4u8om6NKRxp");
  assert.equal(a.accounts[0].totp, SEED);
  assert.equal(a.accounts[0].kind, "standard");

  const mixed = parseAccounts([line, `b@example.com----pw----${SEED}`, `c@example.com--pw--${SEED}`].join("\n"));
  assert.equal(mixed.errors.length, 0);
  assert.equal(mixed.accounts.length, 3);
  assert.deepEqual(mixed.accounts.map((x) => x.totp), [SEED, SEED, SEED]);
});

test("2-dash lines still parse the optional 4th column, and 5 columns need 3+ dashes", () => {
  const future = jwt(Math.floor(Date.now() / 1000) + 3600);
  const link = parseAccounts(`a@example.com--pw--${SEED}--https://mail.example.store/inbox`);
  assert.equal(link.errors.length, 0);
  assert.equal(link.accounts[0].kind, "mail_link");
  assert.equal(link.accounts[0].mailUrl, "https://mail.example.store/inbox");

  const token = parseAccounts(`a@example.com--pw--${SEED}--${future}`);
  assert.equal(token.errors.length, 0);
  assert.equal(token.accounts[0].kind, "access_token");
  assert.equal(token.accounts[0].accessToken, future);

  // `--` cannot separate a token from a refresh_token: a JWT signature may
  // itself contain `--`, so the glued string would pass shape validation and
  // silently produce an unusable token. Refuse instead.
  const both = parseAccounts(`a@example.com--pw--${SEED}--${future}--rt_secret_123`);
  assert.equal(both.accounts.length, 0);
  assert.equal(both.errors.length, 1);
  assert.match(both.errors[0].reason, /连字符/);

  // With `----` the same 5-column line works.
  const dashed = parseAccounts(`a@example.com----pw----${SEED}----${future}----rt_secret_123`);
  assert.equal(dashed.errors.length, 0);
  assert.equal(dashed.accounts[0].accessToken, future);
  assert.equal(dashed.accounts[0].hasRefreshToken, true);
});

test("a `--` inside a password or a bad 2FA secret is reported, never silently accepted", () => {
  // password contains `--`: the tail is not a Base32 secret -> hard error.
  const broken = parseAccounts("a@example.com--pa--ss--short");
  assert.equal(broken.accounts.length, 0);
  assert.equal(broken.errors.length, 1);
  // JWT signature that legitimately contains `--` must survive untouched.
  const sig = "ab--cd";
  const future = `${jwt(Math.floor(Date.now() / 1000) + 3600).split(".").slice(0, 2).join(".")}.${sig}`;
  const a = parseAccounts(`a@example.com----pw----${SEED}----${future}`);
  assert.equal(a.errors.length, 0);
  assert.equal(a.accounts[0].accessToken, future);
});

test("caps total account count to avoid unbounded batch", () => {
  const raw = Array.from({ length: 101 }, (_, i) => `a${i}@example.com----p----${SEED}`).join("\n");
  assert.throws(() => parseAccounts(raw), /100/);
});
