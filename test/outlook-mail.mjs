import assert from "node:assert/strict";

import {
  DEFAULT_OUTLOOK_ENDPOINT,
  fetchOutlookOtpCandidates,
  normalizeOutlookEndpoint,
  parseOutlookEntries,
  validateOutlookEndpoint,
} from "../src/outlook-mail.mjs";

const TARGET_EMAIL = "target@outlook.com";
const CLIENT_ID = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";
const REFRESH_TOKEN = "M.C509_BL2.0.U.-".repeat(30);
const PASSWORD = "outlook-pw-12345";

function buildMessage({ code, sender, receivedAt, subject = "Your verification code", bodyPreview = "" }) {
  return {
    id: `AAMk-${code}-${sender}`,
    receivedDateTime: receivedAt,
    from: { emailAddress: { name: "OpenAI", address: sender } },
    subject,
    bodyPreview,
    body: { contentType: "html", content: `<html><body><p>Your code is <strong>${code}</strong>.</p></body></html>` },
  };
}

function buildPayload(messages, email = TARGET_EMAIL, ok = true) {
  return {
    ok: true,
    results: [{ ok, email, grantType: "refresh_token", messages }],
  };
}

// 验证 endpoint 校验与归一化
assert.equal(validateOutlookEndpoint("https://8t92.cc/api/fetch-mails"), true);
assert.equal(validateOutlookEndpoint("not-a-url"), false);
assert.equal(normalizeOutlookEndpoint(""), DEFAULT_OUTLOOK_ENDPOINT);
assert.equal(normalizeOutlookEndpoint("https://custom.example/api"), "https://custom.example/api");
assert.equal(normalizeOutlookEndpoint("bad"), DEFAULT_OUTLOOK_ENDPOINT);

// 验证 parseOutlookEntries
const entries = parseOutlookEntries(
  `${TARGET_EMAIL}----${PASSWORD}----${CLIENT_ID}----${REFRESH_TOKEN}\nOther@x.com----pw----${CLIENT_ID}----${REFRESH_TOKEN}`,
);
assert.equal(entries.length, 2);
assert.equal(entries[0].email, TARGET_EMAIL);
assert.equal(entries[0].outlookPassword, PASSWORD);
assert.equal(entries[0].outlookClientId, CLIENT_ID);
assert.equal(entries[0].outlookRefreshToken, REFRESH_TOKEN);

// 缺段报错
assert.throws(() => parseOutlookEntries("a@b.com----pw----cid"), /格式错误/);
// 非法 clientId 报错
assert.throws(
  () => parseOutlookEntries(`${TARGET_EMAIL}----${PASSWORD}----not-uuid----${REFRESH_TOKEN}`),
  /clientId/,
);
// 重复邮箱报错
assert.throws(
  () => parseOutlookEntries(
    `${TARGET_EMAIL}----${PASSWORD}----${CLIENT_ID}----${REFRESH_TOKEN}\n${TARGET_EMAIL}----${PASSWORD}----${CLIENT_ID}----${REFRESH_TOKEN}`,
  ),
  /重复/,
);

// 核心场景：baseline 阶段不做时间过滤，记录所有 OpenAI 邮件的验证码
{
  const messages = [
    buildMessage({ code: "111222", sender: "noreply@tm.openai.com", receivedAt: "2026-08-12T01:00:00Z" }),
    buildMessage({ code: "222333", sender: "codex@chatgpt.com", receivedAt: "2026-08-12T02:00:00Z" }),
  ];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-type", "application/json"]]),
    json: async () => buildPayload(messages),
  });
  const candidates = await fetchOutlookOtpCandidates(
    { email: TARGET_EMAIL, clientId: CLIENT_ID, refreshToken: REFRESH_TOKEN, password: PASSWORD },
    { fetchImpl, baselineTime: null },
  );
  const codes = candidates.map((c) => c.code).sort();
  assert.deepEqual(codes, ["111222", "222333"], `baseline 应返回全部 OpenAI 验证码，实际: ${JSON.stringify(codes)}`);
}

// 核心场景：轮询阶段时间过滤——只接受 baselineTime 之后到达的邮件
{
  const baselineTime = Date.parse("2026-08-12T03:00:00Z");
  const messages = [
    // 旧邮件：基准时间之前，应被过滤
    buildMessage({ code: "999999", sender: "noreply@tm.openai.com", receivedAt: "2026-08-12T01:00:00Z" }),
    // 新邮件：基准时间之后，应被返回
    buildMessage({ code: "654321", sender: "noreply@tm.openai.com", receivedAt: "2026-08-12T03:00:30Z" }),
  ];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => buildPayload(messages),
  });
  const candidates = await fetchOutlookOtpCandidates(
    { email: TARGET_EMAIL, clientId: CLIENT_ID, refreshToken: REFRESH_TOKEN, password: PASSWORD },
    { fetchImpl, baselineTime },
  );
  const codes = candidates.map((c) => c.code);
  assert.deepEqual(codes, ["654321"], `轮询阶段应只返回基准时间之后的新验证码，实际: ${JSON.stringify(codes)}`);
}

// 核心场景：发件人过滤——非 OpenAI 发件人的邮件即便含验证码也不返回
{
  const messages = [
    buildMessage({ code: "777888", sender: "noreply@google.com", receivedAt: "2026-08-12T04:00:00Z" }),
    buildMessage({ code: "444555", sender: "email.openai.com", receivedAt: "2026-08-12T04:00:00Z" }),
  ];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => buildPayload(messages),
  });
  const candidates = await fetchOutlookOtpCandidates(
    { email: TARGET_EMAIL, clientId: CLIENT_ID, refreshToken: REFRESH_TOKEN, password: PASSWORD },
    { fetchImpl, baselineTime: null },
  );
  const codes = candidates.map((c) => c.code);
  assert.deepEqual(codes, ["444555"], `应只返回 OpenAI 发件人的验证码，实际: ${JSON.stringify(codes)}`);
}

// 多邮箱响应：从 results 中正确匹配目标 email
{
  const otherPayload = {
    ok: true,
    results: [
      { ok: true, email: "other@outlook.com", messages: [buildMessage({ code: "000000", sender: "noreply@tm.openai.com", receivedAt: "2026-08-12T05:00:00Z" })] },
      { ok: true, email: TARGET_EMAIL, messages: [buildMessage({ code: "123456", sender: "noreply@tm.openai.com", receivedAt: "2026-08-12T05:00:00Z" })] },
    ],
  };
  const fetchImpl = async () => ({ ok: true, status: 200, headers: new Map(), json: async () => otherPayload });
  const candidates = await fetchOutlookOtpCandidates(
    { email: TARGET_EMAIL, clientId: CLIENT_ID, refreshToken: REFRESH_TOKEN, password: PASSWORD },
    { fetchImpl, baselineTime: null },
  );
  const codes = candidates.map((c) => c.code);
  assert.deepEqual(codes, ["123456"], `应只返回目标邮箱的验证码，实际: ${JSON.stringify(codes)}`);
}

// HTTP 错误抛出
{
  const fetchImpl = async () => ({ ok: false, status: 502, headers: new Map(), json: async () => ({}) });
  await assert.rejects(
    fetchOutlookOtpCandidates(
      { email: TARGET_EMAIL, clientId: CLIENT_ID, refreshToken: REFRESH_TOKEN, password: PASSWORD },
      { fetchImpl, baselineTime: null },
    ),
    /HTTP 502/,
  );
}

console.log("outlook mail tests passed");
