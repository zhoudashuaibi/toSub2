import assert from "node:assert/strict";

import { fetchChatgptCredits } from "../src/chatgpt-credits.mjs";

const REFRESHED_TOKEN = "refreshed-access-token-xyz";

// 场景 1：access_token 有效，直接返回余额
{
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method || "GET" });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        credits: { has_credits: true, unlimited: false, balance: "920.0993" },
        plan_type: "free",
      }),
    };
  };
  const result = await fetchChatgptCredits({ accessToken: "valid-token", refreshToken: "rt", fetchImpl });
  assert.equal(result.balance, 920.0993);
  assert.equal(result.hasCredits, true);
  assert.equal(result.unlimited, false);
  assert.equal(result.planType, "free");
  assert.equal(result.refreshedAccessToken, undefined, "有效 token 不应触发刷新");
  assert.equal(calls.length, 1, "有效 token 应只调一次 wham/usage");
  assert.ok(calls[0].url.includes("/backend-api/wham/usage"));
}

// 场景 2：access_token 过期（401），用 refresh_token 刷新后重试成功
{
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url });
    // 第一次 wham/usage 返回 401
    if (url.includes("/backend-api/wham/usage") && calls.length === 1) {
      return { ok: false, status: 401, text: async () => '{"error":"unauthorized"}' };
    }
    // oauth/token 刷新
    if (url.includes("/oauth/token")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: REFRESHED_TOKEN }) };
    }
    // 第二次 wham/usage（用刷新后的 token）
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ credits: { has_credits: true, balance: "50" }, plan_type: "plus" }),
    };
  };
  const result = await fetchChatgptCredits({ accessToken: "expired-token", refreshToken: "rt", fetchImpl });
  assert.equal(result.balance, 50);
  assert.equal(result.planType, "plus");
  assert.equal(result.refreshedAccessToken, REFRESHED_TOKEN, "应回传刷新后的 token");
  assert.equal(calls.length, 3, "应调用：wham(401) → oauth/token → wham(200)");
}

// 场景 3：403 且无 refresh_token → 抛错
{
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '{"error":"forbidden"}' });
  await assert.rejects(
    fetchChatgptCredits({ accessToken: "bad-token", refreshToken: "", fetchImpl }),
    /access_token 已过期且无 refresh_token/,
  );
}

// 场景 4：无 credits 字段 → balance 为 0
{
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '{"plan_type":"free"}' });
  const result = await fetchChatgptCredits({ accessToken: "tok", refreshToken: "rt", fetchImpl });
  assert.equal(result.balance, 0);
  assert.equal(result.hasCredits, false);
}

// 场景 5：网络错误（500）
{
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'server error' });
  await assert.rejects(
    fetchChatgptCredits({ accessToken: "tok", refreshToken: "rt", fetchImpl }),
    /查询余额失败：HTTP 500/,
  );
}

console.log("chatgpt credits tests passed");
