import assert from "node:assert/strict";

import {
  extractBalanceFromMessages,
  isAccountBannedFromMessages,
  fetchReserveAccountMessages,
} from "../src/outlook-mail.mjs";

// ========== extractBalanceFromMessages ==========

function buildCreditMessage(credits, receivedAt = "2026-08-10T12:00:00Z") {
  return {
    id: `credit-${credits}`,
    receivedDateTime: receivedAt,
    from: { emailAddress: { name: "OpenAI", address: "tm.openai.com" } },
    subject: "We've added credits to your account",
    bodyPreview: "",
    body: {
      contentType: "html",
      content: `<html><body><p>We've added ${credits} credits to your account.</p></body></html>`,
    },
  };
}

function buildTextMessage(text, receivedAt = "2026-08-09T12:00:00Z") {
  return {
    id: `msg-${text.slice(0, 10)}`,
    receivedDateTime: receivedAt,
    from: { emailAddress: { name: "Someone", address: "noreply@openai.com" } },
    subject: text,
    bodyPreview: "",
    body: { contentType: "html", content: `<html><body><p>${text}</p></body></html>` },
  };
}

// 测试：正常的余额提取（credits / 25）
{
  const messages = [buildCreditMessage(100)];
  const result = extractBalanceFromMessages(messages);
  assert.equal(result.hasBalance, true);
  assert.equal(result.balance, 4); // 100 / 25 = 4
}

// 测试：带逗号的数字
{
  const messages = [buildCreditMessage("1,250")];
  const result = extractBalanceFromMessages(messages);
  assert.equal(result.hasBalance, true);
  assert.equal(result.balance, 50); // 1250 / 25 = 50
}

// 测试：带小数的数字
{
  const messages = [buildCreditMessage("50.5")];
  const result = extractBalanceFromMessages(messages);
  assert.equal(result.hasBalance, true);
  assert.equal(result.balance, 2.02); // 50.5 / 25 = 2.02
}

// 测试：多封邮件取最近一封匹配的
{
  const messages = [
    buildCreditMessage(100, "2026-08-01T12:00:00Z"), // 旧
    buildCreditMessage(200, "2026-08-10T12:00:00Z"), // 新
  ];
  const result = extractBalanceFromMessages(messages);
  assert.equal(result.hasBalance, true);
  assert.equal(result.balance, 8); // 200 / 25 = 8
}

// 测试：无匹配邮件
{
  const messages = [buildTextMessage("Welcome to ChatGPT")];
  const result = extractBalanceFromMessages(messages);
  assert.equal(result.hasBalance, false);
}

// 测试：空列表
{
  const result = extractBalanceFromMessages([]);
  assert.equal(result.hasBalance, false);
}

// 测试：各种 we've 变体（we've / weve / we've）
{
  const variants = ["we've", "weve", "we've", "WE'VE", "We've"];
  for (const variant of variants) {
    const messages = [{
      id: "variant-test",
      receivedDateTime: "2026-08-10T12:00:00Z",
      from: { emailAddress: { address: "openai.com" } },
      subject: `${variant} added 25 credits`,
      body: { contentType: "html", content: "" },
    }];
    const result = extractBalanceFromMessages(messages);
    assert.equal(result.hasBalance, true, `variant "${variant}" should match`);
    assert.equal(result.balance, 1); // 25 / 25 = 1
  }
}

console.log("✓ extractBalanceFromMessages tests passed");

// ========== isAccountBannedFromMessages ==========

function buildBanMessage(text, receivedAt = "2026-08-10T12:00:00Z") {
  return {
    id: `ban-${text.slice(0, 10)}`,
    receivedDateTime: receivedAt,
    from: { emailAddress: { name: "OpenAI", address: "noreply@openai.com" } },
    subject: "Your account",
    bodyPreview: "",
    body: { contentType: "html", content: `<html><body><p>${text}</p></body></html>` },
  };
}

// 测试：account has been deactivated
{
  const messages = [buildBanMessage("Your account has been deactivated due to a violation.")];
  const result = isAccountBannedFromMessages(messages);
  assert.equal(result.banned, true);
}

// 测试：account_deactivated
{
  const messages = [buildBanMessage("Error: account_deactivated")];
  const result = isAccountBannedFromMessages(messages);
  assert.equal(result.banned, true);
}

// 测试：has been suspended
{
  const messages = [buildBanMessage("Your account has been suspended.")];
  const result = isAccountBannedFromMessages(messages);
  assert.equal(result.banned, true);
}

// 测试：正常邮件不封禁
{
  const messages = [
    buildCreditMessage(100),
    buildTextMessage("Welcome to ChatGPT! Enjoy your subscription."),
  ];
  const result = isAccountBannedFromMessages(messages);
  assert.equal(result.banned, false);
}

// 测试：空列表
{
  const result = isAccountBannedFromMessages([]);
  assert.equal(result.banned, false);
}

// 测试：扫描全部邮件（不只第一封）
{
  const messages = [
    buildCreditMessage(100, "2026-08-10T12:00:00Z"),
    buildBanMessage("account_deactivated", "2026-08-09T12:00:00Z"),
  ];
  const result = isAccountBannedFromMessages(messages);
  assert.equal(result.banned, true);
}

console.log("✓ isAccountBannedFromMessages tests passed");

// ========== fetchReserveAccountMessages ==========

// 测试：fetchReserveAccountMessages 调用 relay 并返回 messages
{
  let capturedBody = null;
  const fakeFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        ok: true,
        results: [{
          ok: true,
          email: "test@outlook.com",
          messages: [
            buildCreditMessage(50, "2026-08-10T12:00:00Z"),
            buildBanMessage("Welcome", "2026-08-09T12:00:00Z"),
          ],
        }],
      }),
    };
  };

  const messages = await fetchReserveAccountMessages({
    endpoint: "https://8t92.cc/api/fetch-mails",
    email: "test@outlook.com",
    clientId: "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
    refreshToken: "M.C509_BL2.0.U.-".repeat(30),
    password: "pass",
  }, { fetchImpl: fakeFetch });

  assert.equal(Array.isArray(messages), true);
  assert.equal(messages.length, 2);
  // 验证请求体格式
  assert.equal(capturedBody.options.maxMessages, 10); // RESERVE_MAIL_MAX_MESSAGES
  assert.equal(capturedBody.options.includeBody, true);
  assert.ok(capturedBody.lines.includes("test@outlook.com"));
}

// 测试：缺少参数抛错
{
  await assert.rejects(
    () => fetchReserveAccountMessages({ email: "", clientId: "x", refreshToken: "y" }),
    /缺少邮箱/,
  );
  await assert.rejects(
    () => fetchReserveAccountMessages({ email: "a@b.com", clientId: "", refreshToken: "y" }),
    /缺少 clientId/,
  );
}

console.log("✓ fetchReserveAccountMessages tests passed");

console.log("\n# All reserve pool mail tests passed");
