import { createHmac } from "node:crypto";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BASE32 = /^[A-Z2-7]+=*$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const MAX_ACCOUNTS = 100;
export const MAX_BYTES = 1024 * 1024;

const SEP_STRICT = /-{3,}/g;
const SEP_LOOSE = /-{2,}/g;

function splitBy(line, re) {
  const fields = [];
  let start = 0, match;
  re.lastIndex = 0;
  while (fields.length < 3 && (match = re.exec(line))) {
    fields.push(line.slice(start, match.index).trim());
    start = re.lastIndex;
  }
  fields.push(line.slice(start).trim());
  return fields;
}

function looksLikeSeed(value) {
  const seed = String(value ?? "").replace(/[\s-]/g, "").toUpperCase();
  return BASE32.test(seed) && seed.replace(/=+$/, "").length >= 16;
}

/**
 * Split on at most the first THREE separators; any dashes inside the last
 * URL/token remain untouched. Canonical separator is `----` (or `---`), but
 * a line written as `邮箱--密码--2FA` is accepted too: an e-mail address and a
 * Base32 secret never contain a dash, so `--` is unambiguous for the first
 * three columns. `--` is only a fallback, so files mixing both styles parse.
 */
export function splitAccountLine(line) {
  const strict = splitBy(line, SEP_STRICT);
  if (strict.length === 1) {
    const loose = splitBy(line, SEP_LOOSE);
    return loose.length > 1 ? loose : strict;
  }
  // Mixed line such as `a@b.com----pw--SECRET`: strict mode only finds two
  // columns, but a `--` split puts a real third column at the end.
  const loose = splitBy(line, SEP_LOOSE);
  const third = loose[2] ?? "";
  if (loose.length > strict.length &&
      (looksLikeSeed(third) || /^https?:\/\//i.test(third) || third.startsWith("eyJ"))) {
    return loose;
  }
  return strict;
}

function jwtPayload(token) {
  try {
    const raw = token.split(".")[1];
    if (!raw || raw.length > 65536) return null;
    const payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Local claims are never cryptographic validation. Even "unexpired" does
 * NOT mean OpenAI has accepted the token or granted Codex permission.
 */
export function accessTokenState(token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 8192 || !JWT.test(token))
    return { state: "invalid" };
  const payload = jwtPayload(token);
  if (!payload) return { state: "invalid" };
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp))
    return { state: "unknown" };
  const time = Math.floor(now / 1000);
  if (payload.exp <= time + 120) return { state: "expired" };
  if (typeof payload.nbf === "number" && payload.nbf > time + 60)
    return { state: "not_yet_valid" };
  return { state: "unexpired_unverified" };
}

function validateSafeHttpUrl(raw, errorLabel) {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol) || !u.hostname ||
        u.username || u.password || raw.length > 8192) {
      return { error: errorLabel };
    }
    return { ok: true, url: raw };
  } catch {
    return { error: errorLabel };
  }
}

export function validateProxyUrl(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: true, proxy: "" };
  let u;
  try { u = new URL(value); } catch {
    return { error: "代理地址格式不正确" };
  }
  if (!["http:", "https:"].includes(u.protocol) || !u.hostname ||
      u.username || u.password || value.length > 512) {
    return { error: "代理只允许无认证的 http(s) URL" };
  }
  return { ok: true, proxy: value };
}

/**
 * Split the 4th column into (col4, col5) when a 5th column was appended.
 * `----` always wins. `--` is only used when the tail is clearly a URL, so a
 * JWT signature that happens to contain `--` is never cut in half — a 5-column
 * line therefore has to use `----` (see FORK.md).
 */
function splitFourth(value) {
  const cut = (index, length) => [
    value.slice(0, index).trim(),
    value.slice(index + length).trim(),
  ];
  const strict = /-{3,}/.exec(value);
  if (strict) return cut(strict.index, strict[0].length);
  const beforeUrl = /-{2,}(?=https?:\/\/)/i.exec(value);
  if (beforeUrl) return cut(beforeUrl.index, beforeUrl[0].length);
  return null;
}

function classifyFourth(value, loose = false) {
  if (!value) return { error: "第四字段为空" };
  if (/^https?:\/\//i.test(value)) {
    const check = validateSafeHttpUrl(value, "邮箱链接格式不正确");
    if (check.error) return check;
    // Metadata only: not fetched, never sent to a different host.
    return { kind: "mail_link", mailUrl: check.url };
  }
  const split = splitFourth(value);
  if (split) {
    const [rawCol4, rawCol5] = split;
    if (!rawCol4) return { error: "第四字段为空" };
    if (!rawCol5) return { error: "第五字段为空" };
    const tok4 = rawCol4.replace(/^Bearer\s+/i, "").trim();
    if (tok4.startsWith("eyJ")) {
      const info4 = accessTokenState(tok4);
      if (info4.state === "invalid") return { error: "第四字段 JWT Token 格式不正确" };
      if (/^https?:\/\//i.test(rawCol5)) {
        const url5 = validateSafeHttpUrl(rawCol5, "第五字段邮箱链接格式不正确");
        if (url5.error) return url5;
        return { kind: "access_token", accessToken: tok4, tokenState: info4.state, mailUrl: url5.url };
      }
      if (rawCol5.length > 8192 || /[\r\n\0\s]/.test(rawCol5))
        return { error: "第五字段 Token 格式不正确" };
      // 第五列就是 refresh_token。以前只记了个 hasRefreshToken 布尔、值直接扔掉，
      // 于是这个号照样得靠密码反复重登 —— 现在把值带出去落库。
      return {
        kind: "access_token", accessToken: tok4, tokenState: info4.state,
        hasRefreshToken: true, refreshToken: rawCol5,
      };
    }
    const tok5 = rawCol5.replace(/^Bearer\s+/i, "").trim();
    if (tok5.startsWith("eyJ") && rawCol4.length <= 8192 && !/[\r\n\0\s]/.test(rawCol4)) {
      const info5 = accessTokenState(tok5);
      if (info5.state === "invalid") return { error: "第五字段 JWT Token 格式不正确" };
      // 反过来写的顺序：第四列是 refresh_token，第五列才是 access_token。
      return {
        kind: "access_token", accessToken: tok5, tokenState: info5.state,
        hasRefreshToken: true, refreshToken: rawCol4,
      };
    }
  }
  const token = value.replace(/^Bearer\s+/i, "").trim();
  if (token.startsWith("eyJ")) {
    // A JWT signature may contain `--`, so a `--`-separated 5th column cannot
    // be told apart from a signature tail. Refuse rather than glue them.
    if (loose && token.includes("--"))
      return { error: "Token 与后面的列请用 3 个以上连字符分隔" };
    const info = accessTokenState(token);
    if (info.state === "invalid") return { error: "第四字段 JWT Token 格式不正确" };
    return { kind: "access_token", accessToken: token, tokenState: info.state };
  }
  return { error: "第四字段只能是 http(s) 邮箱链接或 JWT access_token" };
}

export function parseAccounts(content) {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_BYTES)
    throw new Error("账号文件超过 1 MiB 或不是 UTF-8 文本");
  const accounts = [], errors = [], seen = new Set();
  let duplicates = 0;
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim(), number = i + 1;
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const cols = splitAccountLine(line);
    if (cols.length < 2 || cols.length > 4) {
      errors.push({ line: number, reason: "应为 邮箱----密码----2FA密钥[----邮箱链接/Token][----RefreshToken]（连字符写 2 个或 3 个以上都可以）" });
      continue;
    }
    const [rawEmail, password, rawSeed = "", fourth] = cols;
    const email = rawEmail.toLowerCase();
    const totp = rawSeed.replace(/[\s-]/g, "").toUpperCase();
    if (!EMAIL.test(email) || email.length > 254) {
      errors.push({ line: number, reason: "邮箱格式不正确" }); continue;
    }
    if (!password || password.length > 512 || /[\r\n\0]/.test(password)) {
      errors.push({ line: number, reason: "密码为空或太长" }); continue;
    }
    if (totp && (!BASE32.test(totp) || totp.replace(/=+$/, "").length < 16)) {
      errors.push({ line: number, reason: "2FA密钥不是合法的 Base32 TOTP Secret" }); continue;
    }
    const extra = cols.length === 4 ? classifyFourth(fourth, !/-{3,}/.test(line)) : { kind: "standard" };
    if (extra.error) {
      errors.push({ line: number, reason: extra.error }); continue;
    }
    if (seen.has(email)) { duplicates++; continue; }
    seen.add(email);
    accounts.push({ email, password, totp, line: number, ...extra });
    if (accounts.length > MAX_ACCOUNTS)
      throw new Error("单次最多导入 100 个账号；请分批执行");
  }
  return { accounts, errors, duplicates };
}

export function totpCode(seed, now = Date.now()) {
  const normalized = String(seed).toUpperCase().replace(/[\s=-]/g, "");
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized))
    throw new Error("TOTP Secret 无效");
  let bits = 0, buffer = 0;
  const bytes = [];
  for (const ch of normalized) {
    const v = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch);
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits -= 8)) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  const time = BigInt(Math.floor(now / 30000));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(time);
  const hash = createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
  const n = hash[hash.length - 1] & 0x0f;
  return String(((hash.readUInt32BE(n) & 0x7fffffff) % 1000000)).padStart(6, "0");
}

export function safeAccountName(email) {
  const [name, domain] = email.split("@");
  return name.length <= 2 ? "*@" + domain : name.slice(0, 2) + "***@" + domain;
}
