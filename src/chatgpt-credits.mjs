import crypto from "node:crypto";

const CHATGPT_BASE = String(process.env.CHATGPT_BASE || "https://chatgpt.com").replace(/\/+$/, "");
const AUTH_BASE = String(process.env.AUTH_BASE || "https://auth.openai.com").replace(/\/+$/, "");
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 查询 ChatGPT 账号的 Credit 余额。
 *
 * 先用 access_token 调 GET /backend-api/wham/usage；若返回 401/403，
 * 用 refresh_token 刷新 access_token 后重试一次（刷新成功时把新 token 回传给调用方持久化）。
 *
 * @param {object} params - { accessToken, refreshToken, clientId?, fetchImpl?, timeoutMs? }
 * @returns {Promise<{balance: number, hasCredits: boolean, unlimited: boolean, planType: string|null, refreshedAccessToken?: string}>}
 *   balance 为 credits.balance 转成的数值；无 credits 字段时为 0。
 *   refreshedAccessToken 仅在发生刷新时返回，调用方应据此更新存储的 access_token。
 */
export async function fetchChatgptCredits(params) {
  const accessToken = String(params?.accessToken || "").trim();
  const refreshToken = String(params?.refreshToken || "").trim();
  const clientId = String(params?.clientId || DEFAULT_CLIENT_ID);
  const fetchImpl = params?.fetchImpl || fetch;
  const timeoutMs = params?.timeoutMs || DEFAULT_TIMEOUT_MS;
  if (!accessToken) throw new Error("缺少 access_token");

  const result = await queryUsage(fetchImpl, accessToken, timeoutMs);
  if (result.status === 401 || result.status === 403) {
    if (!refreshToken) throw new Error(`access_token 已过期且无 refresh_token 可刷新（HTTP ${result.status}）`);
    const refreshed = await refreshAccessToken({ fetchImpl, clientId, refreshToken, timeoutMs });
    const retry = await queryUsage(fetchImpl, refreshed.access_token, timeoutMs);
    if (retry.status === 401 || retry.status === 403) {
      throw new Error(`刷新 token 后仍无法查询余额（HTTP ${retry.status}）`);
    }
    return { ...parseUsage(retry.json), refreshedAccessToken: refreshed.access_token };
  }
  if (!result.ok) throw new Error(`查询余额失败：HTTP ${result.status}`);
  return parseUsage(result.json);
}

async function queryUsage(fetchImpl, accessToken, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${CHATGPT_BASE}/backend-api/wham/usage`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "oai-device-id": crypto.randomUUID(),
        "oai-language": "en-US",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, ok: res.ok, json };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("查询余额请求超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshAccessToken({ fetchImpl, clientId, refreshToken, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${AUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      const message = data?.error_description || data?.error?.message || data?.error || "刷新失败";
      throw new Error(`REFRESH_TOKEN_INVALID: OAuth 刷新失败，HTTP ${res.status}：${String(message).slice(0, 180)}`);
    }
    if (!data?.access_token) throw new Error("REFRESH_TOKEN_INVALID: OAuth 刷新响应缺少 access_token");
    return { access_token: data.access_token };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("刷新 token 请求超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseUsage(json) {
  const credits = json && typeof json === "object" ? json.credits : null;
  const balanceRaw = credits && typeof credits.balance !== "undefined" ? credits.balance : null;
  const balance = Number(balanceRaw);
  return {
    balance: Number.isFinite(balance) ? balance : 0,
    hasCredits: Boolean(credits && credits.has_credits),
    unlimited: Boolean(credits && credits.unlimited),
    planType: typeof json?.plan_type === "string" ? json.plan_type : null,
  };
}
