#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";
import { createCredentialStore } from "./credential-store.mjs";
import { fetchChatgptCredits } from "./chatgpt-credits.mjs";
import { fetchMailboxOtpCandidates, validateMailApiUrl } from "./mail-otp.mjs";
import {
  DEFAULT_OUTLOOK_ENDPOINT,
  fetchOutlookOtpCandidates,
  fetchReserveAccountMessages,
  extractBalanceFromMessages,
  isAccountBannedFromMessages,
  normalizeOutlookEndpoint,
  parseOutlookEntries,
  validateOutlookEndpoint,
} from "./outlook-mail.mjs";
import { createSmsProvider, publicSmsProviderDefinitions } from "./sms-providers.mjs";
import { DirectTlsProfileProbe, proxySupportsSessionRotation } from "./tls-transport.mjs";

// 加载项目根目录的 .env（如果存在）。已有同名系统环境变量不会被覆盖。
// 这样可以在 .env 里配置 TOSUB2_CONSOLE_PASSWORD 等参数，免去每次启动手动传环境变量。
// 文件不存在时静默跳过；Node 20.12+ 内置，无需额外依赖。
try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"));
} catch (error) {
  if (error?.code !== "ENOENT" && error?.code !== "MODULE_NOT_FOUND") {
    console.warn(`[warn] 读取 .env 失败，已跳过：${error.message}`);
  }
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4399;
const MAX_ACTIVE_JOBS = 20;
const MAX_BATCH_JOBS = 500;
const MAX_PROXY_RISK_RETRIES = 10;
const MAX_PROXY_CONNECTION_FAILURES = 20;
const PROXY_CONNECTION_RETRY_BASE_MS = Math.max(1, Number(process.env.PROXY_CONNECTION_RETRY_BASE_MS || 1_000));
const PROXY_CONNECTION_RETRY_MAX_MS = 15_000;
const PAGE_SIZE = 20;
const MAX_LOG_CHARS = 80_000;
const JOB_META_FILENAME = "job-meta.json";
const LOGIN_CHECKPOINT_FILENAME = "login-checkpoint.json";
const TOTP_SETUP_RESULT_FILENAME = "totp-setup-result.json";
const SUB2API_MONITOR_FILENAME = "sub2api-monitor.json";
const OUTLOOK_FETCH_CONFIG_FILENAME = "outlook-fetch.json";
const RESERVE_POOL_FILENAME = "reserve-pool.json";
const RESERVE_MAIL_MAX_MESSAGES = 10;
const SUB2API_MONITOR_INTERVAL_MS = readDurationEnv("SUB2API_MONITOR_INTERVAL_MS", 5 * 60_000, 1_000);
const SUB2API_AUTO_REPAIR_COOLDOWN_MS = readDurationEnv("SUB2API_AUTO_REPAIR_COOLDOWN_MS", 5 * 60_000, 0);
const MAIL_POLL_INTERVAL_MS = 2_500;
const MAIL_POLL_TIMEOUT_MS = 10 * 60_000;
const SMS_POLL_INTERVAL_MS = Number(process.env.SMS_POLL_INTERVAL_MS || process.env.LUBAN_SMS_POLL_INTERVAL_MS || 3_000);
const SMS_POLL_TIMEOUT_MS = Number(process.env.SMS_POLL_TIMEOUT_MS || process.env.LUBAN_SMS_POLL_TIMEOUT_MS || 10 * 60_000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.join(TOOL_ROOT, "web");
const PROTOCOL_SCRIPT = path.resolve(process.env.ONBOARDING_PROTOCOL_SCRIPT || path.join(__dirname, "protocol-login.mjs"));
const WORKSPACE_ROOT = TOOL_ROOT;
const OUTPUT_ROOT = path.resolve(
  process.env.ONBOARDING_OUTPUT_ROOT || path.join(WORKSPACE_ROOT, "tmp", "chatgpt-onboarding-console"),
);
const SUB2API_MONITOR_PATH = path.join(OUTPUT_ROOT, SUB2API_MONITOR_FILENAME);
const OUTLOOK_FETCH_CONFIG_PATH = path.join(OUTPUT_ROOT, OUTLOOK_FETCH_CONFIG_FILENAME);
const RESERVE_POOL_PATH = path.join(OUTPUT_ROOT, RESERVE_POOL_FILENAME);
const credentialStore = createCredentialStore();
const consoleToken = crypto.randomBytes(24).toString("base64url");

// 控制台访问密码防护：启动时读取 TOSUB2_CONSOLE_PASSWORD，用 scrypt 哈希后只保存哈希，
// 不明文存储；验证时用固定时间比较，避免时序侧信道。未设置环境变量时关闭防护，
// 行为完全等同改造前（本机/可信局域网直接访问）。
const CONSOLE_PASSWORD_SCRYPT_KEYLEN = 64;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_DURATION_MS = 15 * 60_000;
const consolePasswordHash = computeConsolePasswordHash(process.env.TOSUB2_CONSOLE_PASSWORD);
const consolePasswordEnabled = Boolean(consolePasswordHash);
const loginAttempts = new Map(); // key: 客户端 IP -> { count, lockedUntil }

const CONSOLE_FEATURES = {
  retry: true,
  regenerate: true,
  phoneContext: true,
  batchDownload: true,
  bulkActions: true,
  pagination: true,
  uniqueEmail: true,
  smsProviders: publicSmsProviderDefinitions(),
  queue: true,
  sourceExport: true,
  cancelAll: true,
  sub2apiUpload: true,
  sub2apiMonitor: true,
  tlsFingerprint: true,
  totpSetup: true,
  forceRelogin: true,
};

const jobs = new Map();
const customSmsPoolPositions = new Map();
const emailJobLocks = new Map();
let outputSyncPromise = null;
let lastOutputSyncAt = 0;
let shuttingDown = false;
let queueSchedulingPaused = false;
let shutdownPromise = null;
let sub2ApiMonitorConfig = null;
let sub2ApiMonitorTimer = null;
let sub2ApiMonitorPromise = null;
const sub2ApiRequestControllers = new Set();
const sub2ApiRequestPromises = new Set();
const sub2ApiAutoRepairPromises = new Set();
const directTlsProfileProbe = new DirectTlsProfileProbe({
  explicitProfile: process.env.TOSUB2_TLS_PROFILE,
  validationUrl: `${String(process.env.CHATGPT_BASE || "https://chatgpt.com").replace(/\/$/, "")}/`,
});
const sub2ApiMonitorState = {
  running: false,
  lastCheckAt: null,
  nextCheckAt: null,
  lastError: null,
  lastResult: null,
};

// 备用号池（reserve pool）内存状态；敏感凭证存 credential store，这里只存非敏感信息。
let reservePoolAccounts = [];
let reservePoolWritePromise = Promise.resolve();

const hostArg = process.argv.find((item) => item.startsWith("--host="));
const hostIndex = process.argv.indexOf("--host");
const requestedHost = String(
  hostArg?.slice("--host=".length)
    || (hostIndex >= 0 ? process.argv[hostIndex + 1] : "")
    || process.env.ONBOARDING_HOST
    || DEFAULT_HOST,
).trim();
const portArg = process.argv.find((item) => item.startsWith("--port="));
const portIndex = process.argv.indexOf("--port");
const requestedPort = Number(
  portArg?.slice("--port=".length) || (portIndex >= 0 ? process.argv[portIndex + 1] : "") || DEFAULT_PORT,
);
const hmrPort = requestedPort <= 45_535 ? requestedPort + 20_000 : requestedPort - 20_000;

if (!requestedHost || requestedHost.startsWith("--")) {
  throw new Error("--host must be a valid hostname or IP address");
}

if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
  throw new Error("--port must be an integer between 1 and 65535");
}

await fs.mkdir(OUTPUT_ROOT, { recursive: true });
await loadSub2ApiMonitorConfiguration();
await loadReservePool();
await syncCompletedOutputs(true);
scheduleQueuedJobs();
scheduleSub2ApiMonitor();
void directTlsProfileProbe.resolve().catch((error) => {
  console.warn(`[warn] 本机直连 TLS 指纹预探测失败，将在无代理任务启动时重试：${error.message}`);
});

const vite = await createViteServer({
  root: WEB_ROOT,
  configFile: false,
  appType: "spa",
  plugins: [react()],
  server: {
    middlewareMode: true,
    hmr: { port: hmrPort, clientPort: hmrPort },
  },
});

const server = http.createServer(async (req, res) => {
  try {
    enforceUtf8ContentType(res);
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `${requestedHost}:${requestedPort}`}`);
    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(req, res, requestUrl);
      return;
    }
    vite.middlewares(req, res, (error) => {
      if (error) sendJson(res, 500, { error: error.message || "Page rendering failed" });
    });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Internal server error" });
  }
});

function enforceUtf8ContentType(res) {
  const setHeader = res.setHeader;
  res.setHeader = function setUtf8Header(name, value) {
    if (String(name).toLowerCase() === "content-type") {
      value = addUtf8Charset(value);
    }
    return setHeader.call(this, name, value);
  };
}

function addUtf8Charset(value) {
  if (typeof value !== "string" || /;\s*charset=/i.test(value)) return value;
  if (/^(?:text\/(?:html|css|javascript|plain)|application\/(?:javascript|json))(?:\s*;|$)/i.test(value)) {
    return `${value}; charset=utf-8`;
  }
  return value;
}

/**
 * 启动时把明文密码转成 scrypt 哈希。密码本身不会被保留在任何变量里。
 * 返回 { salt, hash }（均为 Buffer），或 null（未配置密码）。
 */
function computeConsolePasswordHash(rawPassword) {
  const password = String(rawPassword || "").trim();
  if (!password) return null;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, CONSOLE_PASSWORD_SCRYPT_KEYLEN);
  return { salt, hash };
}

/**
 * 固定时间比较输入密码的 scrypt 派生值与已存哈希，避免时序侧信道泄露信息。
 */
function verifyConsolePassword(input) {
  if (!consolePasswordHash) return false;
  const candidate = crypto.scryptSync(
    String(input || ""),
    consolePasswordHash.salt,
    CONSOLE_PASSWORD_SCRYPT_KEYLEN,
  );
  return candidate.length === consolePasswordHash.hash.length
    && crypto.timingSafeEqual(candidate, consolePasswordHash.hash);
}

/**
 * 取客户端 IP，优先读反向代理透传的 x-forwarded-for 首段，回退到 socket 直连地址。
 */
function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (forwarded) return forwarded;
  return String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
}

/**
 * 检查某 IP 的登录锁定状态，返回 { locked, retryAfterSeconds }。
 */
function getLoginAttemptState(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return { locked: false, retryAfterSeconds: 0 };
  if (entry.lockedUntil && entry.lockedUntil > Date.now()) {
    return { locked: true, retryAfterSeconds: Math.ceil((entry.lockedUntil - Date.now()) / 1000) };
  }
  return { locked: false, retryAfterSeconds: 0 };
}

function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOGIN_LOCK_DURATION_MS;
  }
  loginAttempts.set(ip, entry);
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

server.listen(requestedPort, requestedHost, () => {
  const urls = getConsoleUrls(requestedHost, requestedPort);
  console.log(`[ok] ChatGPT onboarding console: ${urls[0]}`);
  for (const url of urls.slice(1)) console.log(`[ok] LAN access: ${url}`);
  console.log(`[info] Output directory: ${OUTPUT_ROOT}`);
  if (consolePasswordEnabled) {
    console.log("[note] 控制台访问密码已启用，打开页面需要先输入密码。");
  } else if (isWildcardHost(requestedHost)) {
    console.log("[note] LAN access is enabled without authentication. Keep downloaded OAuth files private.");
  } else {
    console.log("[note] This server only listens on the configured host. Keep downloaded OAuth files private.");
  }
});

function isWildcardHost(host) {
  return host === "0.0.0.0" || host === "::";
}

function getConsoleUrls(host, port) {
  if (!isWildcardHost(host)) return [`http://${host}:${port}`];
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  return [
    `http://127.0.0.1:${port}`,
    ...[...new Set(addresses)].map((address) => `http://${address}:${port}`),
  ];
}

async function handleApi(req, res, requestUrl) {
  if (req.method === "GET" && requestUrl.pathname === "/api/bootstrap") {
    // 启用密码防护时，bootstrap 只告诉前端“需要登录”，不下发 token 也不暴露功能列表。
    // 未启用时行为不变，本机/可信局域网仍可直接拿到 token。
    if (consolePasswordEnabled) {
      sendJson(res, 200, { authRequired: true });
    } else {
      sendJson(res, 200, { token: consoleToken, features: CONSOLE_FEATURES });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/login") {
    const ip = getClientIp(req);
    if (!consolePasswordEnabled) {
      // 未启用密码防护时，/api/login 直接放行（兼容前端统一登录流程）。
      clearLoginAttempts(ip);
      sendJson(res, 200, { token: consoleToken, features: CONSOLE_FEATURES });
      return;
    }
    const lockState = getLoginAttemptState(ip);
    if (lockState.locked) {
      const minutes = Math.max(1, Math.ceil(lockState.retryAfterSeconds / 60));
      sendJson(res, 429, {
        error: `尝试次数过多，请 ${minutes} 分钟后再试`,
        retryAfterSeconds: lockState.retryAfterSeconds,
      });
      return;
    }
    const body = await readJson(req);
    if (verifyConsolePassword(body.password)) {
      clearLoginAttempts(ip);
      sendJson(res, 200, { token: consoleToken, features: CONSOLE_FEATURES });
    } else {
      recordLoginFailure(ip);
      const remaining = Math.max(0, LOGIN_MAX_ATTEMPTS - (loginAttempts.get(ip)?.count || 0));
      const justLocked = remaining === 0;
      sendJson(res, 401, {
        error: justLocked
          ? `密码错误次数过多，已锁定 ${Math.round(LOGIN_LOCK_DURATION_MS / 60_000)} 分钟`
          : `密码错误，剩余 ${remaining} 次尝试机会`,
        remaining,
        locked: justLocked,
      });
    }
    return;
  }

  if (req.headers["x-console-token"] !== consoleToken) {
    sendJson(res, 403, { error: "Invalid console token" });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/jobs") {
    const requestedPage = Math.max(1, Number.parseInt(requestUrl.searchParams.get("page") || "1", 10) || 1);
    await sendJobsPage(res, requestedPage);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/query") {
    const body = await readJson(req);
    const requestedPage = Math.max(1, Number.parseInt(body.page || "1", 10) || 1);
    await sendJobsPage(res, requestedPage, normalizeEmailFilter(body.emails));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs") {
    const body = await readJson(req);
    const email = String(body.email || "").trim();
    if (!isEmail(email)) {
      sendJson(res, 400, { error: "Please enter a valid email address" });
      return;
    }
    const hasCredentialUpdate = ["password", "mailApiUrl", "totpSecret"].some((key) => Object.hasOwn(body, key));
    const credentials = normalizeLoginCredentials(body);
    const hasProxyUpdate = Object.hasOwn(body, "proxyUrl");
    const proxyUrl = hasProxyUpdate ? normalizeProxyUrl(body.proxyUrl) : null;
    const result = await withEmailJobLock(email, async () => {
      const existing = findJobByEmail(email);
      if (existing) {
        if (hasCredentialUpdate) await updateJobCredentials(existing, credentials, { proxyUrl, hasProxyUpdate });
        else if (hasProxyUpdate) await updateJobProxy(existing, proxyUrl);
        return { job: existing, created: false, updated: hasCredentialUpdate || hasProxyUpdate };
      }
      return { job: await startJob(email, credentials, proxyUrl), created: true, updated: false };
    });
    sendJson(res, result.created ? 201 : 200, { ...result, job: publicJob(result.job) });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/batch") {
    const body = await readJson(req);
    const entries = parseBatchEntries(body.text);
    const proxyUrl = normalizeProxyUrl(body.proxyUrl);
    const results = await Promise.all(entries.map((entry) => withEmailJobLock(entry.email, async () => {
      const existing = findJobByEmail(entry.email);
      if (existing) {
        await updateJobCredentials(existing, entry, { proxyUrl, hasProxyUpdate: true });
        return { job: existing, updated: true };
      }
      return { job: await startJob(entry.email, entry, proxyUrl), updated: false };
    })));
    sendJson(res, 201, {
      jobs: results.map((item) => publicJob(item.job)),
      created: results.filter((item) => !item.updated).length,
      updated: results.filter((item) => item.updated).length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/outlook-batch") {
    const body = await readJson(req);
    let entries;
    try {
      entries = parseOutlookEntries(body.text);
    } catch (error) {
      throw httpError(400, error.message);
    }
    if (entries.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多添加 ${MAX_BATCH_JOBS} 条任务`);
    const proxyUrl = normalizeProxyUrl(body.proxyUrl);
    const results = await Promise.all(entries.map((entry) => withEmailJobLock(entry.email, async () => {
      const credentials = {
        email: entry.email,
        loginMode: "email_otp",
        mailApiUrl: null,
        password: "",
        totpSecret: "",
        outlookClientId: entry.outlookClientId,
        outlookRefreshToken: entry.outlookRefreshToken,
        outlookPassword: entry.outlookPassword,
      };
      const existing = findJobByEmail(entry.email);
      if (existing) {
        await updateJobCredentials(existing, credentials, { proxyUrl, hasProxyUpdate: true });
        return { job: existing, updated: true };
      }
      return { job: await startJob(entry.email, credentials, proxyUrl), updated: false };
    })));
    sendJson(res, 201, {
      jobs: results.map((item) => publicJob(item.job)),
      created: results.filter((item) => !item.updated).length,
      updated: results.filter((item) => item.updated).length,
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/outlook-fetch-config") {
    sendJson(res, 200, await loadOutlookFetchConfig());
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/outlook-fetch-config") {
    const body = await readJson(req);
    const rawEndpoint = String(body.endpoint || "").trim();
    if (rawEndpoint && !validateOutlookEndpoint(rawEndpoint)) {
      throw httpError(400, "Outlook 取件接口必须是有效的 HTTP 或 HTTPS 地址");
    }
    const endpoint = normalizeOutlookEndpoint(rawEndpoint);
    const saved = await saveOutlookFetchConfig(endpoint);
    sendJson(res, 200, saved);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/download-batch") {
    const body = await readJson(req);
    await downloadBatchResult(res, body.ids);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/export-source") {
    const body = await readJson(req);
    await exportSourceAccounts(res, body.ids);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/delete-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const emails = [...new Set(selected.map((job) => job.email.toLowerCase()))];
    await Promise.all(emails.map((email) => withEmailJobLock(email, () => deleteJobsByEmail(email))));
    sendJson(res, 200, { deleted: emails.length });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/refresh-credits") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids).filter((job) => job.resultSaved);
    await Promise.all(selected.map((job) => withEmailJobLock(job.email, () => refreshJobCreditBalance(job))));
    sendJson(res, 200, {
      jobs: selected.map((job) => publicJob(job)),
      checked: selected.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/reauthorize-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const unsupported = selected.find(
      (job) => !["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    );
    if (unsupported) throw httpError(409, `${unsupported.email} 当前仍在进行中，不能重新授权`);
    await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (job.status === "completed") await regenerateJob(job, body);
      else await retryJob(job, body);
    })));
    sendJson(res, 200, { jobs: selected.map(publicJob), started: selected.length });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/relogin-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const started = await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (!canForceRelogin(job)) return null;
      await forceReloginJob(job, body);
      return job;
    })));
    const eligible = started.filter(Boolean);
    if (!eligible.length) throw httpError(409, "选中的账号当前都不能重新登录");
    sendJson(res, 200, {
      jobs: eligible.map(publicJob),
      started: eligible.length,
      skipped: selected.length - eligible.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/setup-2fa-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const started = await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (!canSetupTotp(job)) return null;
      await startTotpSetup(job, body);
      return job;
    })));
    const eligible = started.filter(Boolean);
    if (!eligible.length) throw httpError(409, "选中的账号都不能设置 2FA");
    sendJson(res, 200, {
      jobs: eligible.map(publicJob),
      started: eligible.length,
      skipped: selected.length - eligible.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/cancel-all") {
    const canceled = await cancelAllJobs();
    sendJson(res, 200, { canceled });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/groups") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const payload = await requestSub2Api(config, "/api/v1/admin/groups/all?platform=openai");
    const groups = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    sendJson(res, 200, {
      groups: groups
        .filter((group) => group && Number.isInteger(Number(group.id)))
        .map((group) => ({
          id: Number(group.id),
          name: String(group.name || `号池 ${group.id}`),
          status: String(group.status || "active"),
        })),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/options") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const [groupPayload, proxyPayload] = await Promise.all([
      requestSub2Api(config, "/api/v1/admin/groups/all?platform=openai"),
      requestSub2Api(config, "/api/v1/admin/proxies/all"),
    ]);
    const groups = Array.isArray(groupPayload) ? groupPayload : Array.isArray(groupPayload?.data) ? groupPayload.data : [];
    const proxies = Array.isArray(proxyPayload) ? proxyPayload : Array.isArray(proxyPayload?.data) ? proxyPayload.data : [];
    sendJson(res, 200, {
      groups: groups
        .filter((group) => group && Number.isInteger(Number(group.id)))
        .map((group) => ({ id: Number(group.id), name: String(group.name || `号池 ${group.id}`), status: String(group.status || "active") })),
      proxies: proxies
        .filter((proxy) => proxy && Number.isInteger(Number(proxy.id)))
        .map((proxy) => ({
          id: Number(proxy.id),
          name: String(proxy.name || `代理 ${proxy.id}`),
          protocol: String(proxy.protocol || ""),
          host: String(proxy.host || ""),
          port: Number(proxy.port || 0),
          ipAddress: String(proxy.ip_address || ""),
          status: String(proxy.status || "active"),
        })),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/upload") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const selected = resolveSelectedJobs(body.ids);
    const downloadable = selected.filter((job) => job.resultSaved);
    if (downloadable.length === 0) throw httpError(409, "选中的任务里没有已完成的导入文件");
    const result = await uploadJobsToSub2Api(config, downloadable);
    sendJson(res, 200, {
      selected: selected.length,
      uploaded: downloadable.length,
      skipped: selected.length - downloadable.length,
      ...result,
      groupIds: config.groupIds,
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/sub2api/monitor") {
    sendJson(res, 200, publicSub2ApiMonitorState());
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/monitor") {
    const body = await readJson(req);
    if (body.enabled) {
      const config = normalizeSub2ApiConfig(body.config);
      sub2ApiMonitorConfig = { ...config, enabled: true };
    } else {
      sub2ApiMonitorConfig = null;
    }
    sub2ApiMonitorState.lastError = null;
    await persistSub2ApiMonitorConfiguration();
    scheduleSub2ApiMonitor();
    sendJson(res, 200, publicSub2ApiMonitorState());
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/monitor/check") {
    if (!sub2ApiMonitorConfig?.enabled) throw httpError(409, "请先启用 Sub2API 号池监控");
    const result = await runSub2ApiMonitor("manual");
    sendJson(res, 200, { ...publicSub2ApiMonitorState(), result });
    return;
  }

  // ===================== 备用号池（reserve pool） =====================

  if (req.method === "GET" && requestUrl.pathname === "/api/reserve-pool") {
    sendJson(res, 200, {
      accounts: reservePoolAccounts.map(publicReserveAccount),
      available: reservePoolAccounts.filter((a) => a.status === "idle" && !a.banned).length,
      total: reservePoolAccounts.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/reserve-pool/import") {
    const body = await readJson(req);
    let entries;
    try {
      entries = parseOutlookEntries(body.text);
    } catch (error) {
      throw httpError(400, error.message);
    }
    if (entries.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多导入 ${MAX_BATCH_JOBS} 条账号`);

    // 构建主任务列表中已有邮箱的集合（避免和已在号池/任务队列中的号重复）
    const jobEmails = new Set();
    for (const job of listUniqueJobs()) {
      if (job.email) jobEmails.add(job.email.toLowerCase());
    }

    // 如果配置了 Sub2API，查远程号池中已有邮箱，避免导入已在号池中的号。
    // 优先用监控配置（已持久化），其次用前端本次传入的 config。
    const sub2ApiEmails = new Set();
    let dedupConfig = null;
    if (sub2ApiMonitorConfig?.baseUrl && sub2ApiMonitorConfig?.adminApiKey) {
      dedupConfig = sub2ApiMonitorConfig;
    } else if (body.config?.baseUrl && body.config?.adminApiKey) {
      try { dedupConfig = normalizeSub2ApiConfig(body.config); } catch {}
    }
    if (dedupConfig) {
      try {
        const remoteAccounts = await listAllSub2ApiOpenAiAccounts(dedupConfig);
        for (const acc of remoteAccounts) {
          const email = sub2ApiAccountEmail(acc);
          if (email) sub2ApiEmails.add(email);
        }
      } catch {
        // Sub2API 查询失败不阻断导入，降级为只查本地
      }
    }

    let created = 0;
    let skipped = 0;
    let duplicated = 0;
    for (const entry of entries) {
      if (findReserveAccount(entry.email)) {
        skipped += 1; // 备用号池内部已存在
        continue;
      }
      if (jobEmails.has(entry.email) || sub2ApiEmails.has(entry.email)) {
        duplicated += 1; // 已在主任务列表或 Sub2API 号池中
        continue;
      }
      reservePoolAccounts.push(normalizeReserveAccount({
        email: entry.email,
        hasBalance: false,
        banned: false,
        status: "idle",
        importedAt: new Date().toISOString(),
      }));
      await saveReserveCredentials(entry);
      created += 1;
    }
    void persistReservePool();
    // 异步拉取邮件获取余额/封禁状态
    const outlookConfig = await loadOutlookFetchConfig();
    for (const entry of entries) {
      const acc = findReserveAccount(entry.email);
      if (acc && acc.status === "idle") {
        void refreshReserveAccountStatus(acc, outlookConfig.endpoint);
      }
    }
    sendJson(res, 201, {
      accounts: reservePoolAccounts.map(publicReserveAccount),
      created,
      skipped,
      duplicated,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/reserve-pool/refresh") {
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const outlookConfig = await loadOutlookFetchConfig();
    if (email) {
      const acc = findReserveAccount(email);
      if (!acc) throw httpError(404, "备用号池中未找到该账号");
      await refreshReserveAccountStatus(acc, outlookConfig.endpoint);
    } else {
      // 全部刷新（串行避免并发拉太多邮件）
      for (const acc of reservePoolAccounts) {
        if (acc.status === "joined") continue;
        await refreshReserveAccountStatus(acc, outlookConfig.endpoint);
      }
    }
    sendJson(res, 200, {
      accounts: reservePoolAccounts.map(publicReserveAccount),
      available: reservePoolAccounts.filter((a) => a.status === "idle" && !a.banned).length,
      total: reservePoolAccounts.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/reserve-pool/join") {
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const acc = findReserveAccount(email);
    if (!acc) throw httpError(404, "备用号池中未找到该账号");
    if (acc.status === "joined") throw httpError(409, "该账号已加入号池");
    if (acc.status === "joining") throw httpError(409, "该账号正在加入号池");
    if (acc.banned) throw httpError(409, "该账号已被标记为封禁，无法加入");
    // 需要有 Sub2API 配置才能上传。优先用监控配置，其次用前端本次传入的 config。
    let joinConfig = null;
    if (sub2ApiMonitorConfig?.baseUrl && sub2ApiMonitorConfig?.adminApiKey) {
      joinConfig = { ...sub2ApiMonitorConfig, groupIds: [...sub2ApiMonitorConfig.groupIds] };
    } else if (body.config?.baseUrl && body.config?.adminApiKey) {
      try { joinConfig = normalizeSub2ApiConfig(body.config); } catch {}
    }
    if (!joinConfig) {
      throw httpError(409, "请先在 Sub2API 配置中填写后端地址和管理员 Key");
    }
    // 异步执行加入流程
    void joinReserveToPool(email, joinConfig, "manual");
    sendJson(res, 202, { email, status: "joining" });
    return;
  }

  if (req.method === "DELETE" && requestUrl.pathname === "/api/reserve-pool") {
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const idx = reservePoolAccounts.findIndex((acc) => acc.email === email);
    if (idx < 0) throw httpError(404, "备用号池中未找到该账号");
    if (reservePoolAccounts[idx].status === "joining") {
      throw httpError(409, "该账号正在加入号池，无法删除");
    }
    reservePoolAccounts.splice(idx, 1);
    await deleteReserveCredentials(email);
    void persistReservePool();
    sendJson(res, 200, {
      accounts: reservePoolAccounts.map(publicReserveAccount),
      available: reservePoolAccounts.filter((a) => a.status === "idle" && !a.banned).length,
      total: reservePoolAccounts.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/reserve-pool/clear") {
    const body = await readJson(req);
    // 支持批量删除指定邮箱；如果没有传 emails 则不做任何操作（前端必须传选中列表）
    const emailsToDelete = Array.isArray(body.emails)
      ? [...new Set(body.emails.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))]
      : [];
    if (!emailsToDelete.length) throw httpError(400, "请选择要删除的账号");
    // 正在加入号池的不能删
    const toDelete = [];
    const blockedJoining = [];
    for (const email of emailsToDelete) {
      const acc = findReserveAccount(email);
      if (!acc) continue;
      if (acc.status === "joining") {
        blockedJoining.push(email);
        continue;
      }
      toDelete.push(acc);
    }
    if (blockedJoining.length) throw httpError(409, `${blockedJoining.length} 个账号正在加入号池，无法删除`);
    for (const acc of toDelete) {
      await deleteReserveCredentials(acc.email);
    }
    reservePoolAccounts = reservePoolAccounts.filter((acc) => !toDelete.includes(acc));
    void persistReservePool();
    sendJson(res, 200, {
      accounts: reservePoolAccounts.map(publicReserveAccount),
      available: reservePoolAccounts.filter((a) => a.status === "idle" && !a.banned).length,
      total: reservePoolAccounts.length,
    });
    return;
  }

  const providerOptionsMatch = /^\/api\/sms-providers\/([a-z0-9_-]+)\/options$/.exec(requestUrl.pathname);
  if (req.method === "POST" && providerOptionsMatch) {
    const body = await readJson(req);
    let smsClient;
    try {
      smsClient = createSmsProvider(providerOptionsMatch[1], body.config, {
        lubanApiBase: process.env.LUBAN_SMS_API_BASE,
        smsBowerApiBase: process.env.SMSBOWER_API_BASE,
      });
      if (!smsClient.listNumberOptions) throw httpError(400, "该接码平台不支持价格查询");
      const options = await smsClient.listNumberOptions();
      sendJson(res, 200, { providerId: smsClient.id, options });
    } catch (error) {
      if (error?.status) throw error;
      throw httpError(502, safeSmsProviderError(error, body.config?.apiKey));
    }
    return;
  }

  const match = /^\/api\/jobs\/([a-f0-9-]+)(?:\/(input|cancel|retry|regenerate|relogin|setup-2fa|logs|download|sms-number|luban-number))?$/.exec(requestUrl.pathname);
  if (!match) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const job = jobs.get(match[1]);
  if (!job) {
    sendJson(res, 404, { error: "Login flow not found" });
    return;
  }

  const action = match[2];
  if (req.method === "GET" && action === "logs") {
    sendJson(res, 200, { id: job.id, logs: job.logs });
    return;
  }
  if (req.method === "GET" && action === "download") {
    await downloadResult(res, job);
    return;
  }
  if (req.method === "POST" && ["sms-number", "luban-number"].includes(action)) {
    const body = await readJson(req);
    const providerId = action === "luban-number" ? "luban" : body.providerId;
    const config = action === "luban-number"
      ? { apiKey: body.apiKey, serviceId: body.serviceId }
      : body.config;
    await withEmailJobLock(job.email, () => acquireSmsNumber(job, providerId, config));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "cancel") {
    await withEmailJobLock(job.email, () => cancelJob(job));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "retry") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => retryJob(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "regenerate") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => regenerateJob(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "relogin") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => forceReloginJob(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "setup-2fa") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => startTotpSetup(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "input") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => submitJobInput(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function sendJobsPage(res, requestedPage, emailFilter = null) {
  await syncCompletedOutputs();
  const allJobs = listUniqueJobs();
  const emailSet = emailFilter?.length ? new Set(emailFilter) : null;
  const visibleJobs = emailSet
    ? allJobs.filter((job) => emailSet.has(job.email.toLowerCase()))
    : allJobs;
  const total = visibleJobs.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * PAGE_SIZE;
  sendJson(res, 200, {
    jobs: visibleJobs.slice(start, start + PAGE_SIZE).map(publicJob),
    selection: visibleJobs.map(publicSelectionJob),
    pagination: { page, pageSize: PAGE_SIZE, total, totalPages, totalAll: allJobs.length },
    filter: { active: Boolean(emailSet), requested: emailFilter?.length || 0, matched: total },
    stats: {
      active: allJobs.filter(occupiesActiveSlot).length,
      queued: allJobs.filter((job) => job.status === "queued").length,
      completed: allJobs.filter((job) => job.status === "completed").length,
    },
  });
}

function normalizeEmailFilter(value) {
  if (!Array.isArray(value) || value.length === 0) throw httpError(400, "请至少输入一个筛选邮箱");
  if (value.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多筛选 ${MAX_BATCH_JOBS} 个邮箱`);
  const unique = new Set();
  value.forEach((item, index) => {
    const email = String(item || "").trim().toLowerCase();
    if (!isEmail(email)) throw httpError(400, `第 ${index + 1} 个筛选邮箱格式错误`);
    unique.add(email);
  });
  return [...unique];
}

async function startJob(email, credentials = {}, proxyUrl = null) {
  const { loginMode, mailApiUrl, password, totpSecret, outlookClientId, outlookRefreshToken, outlookPassword } =
    normalizeLoginCredentials(credentials);
  await saveStoredLoginCredentials(email, {
    password,
    totpSecret,
    proxyUrl,
    outlookClientId,
    outlookRefreshToken,
    outlookPassword,
  });
  const id = crypto.randomUUID();
  const outputDir = path.join(OUTPUT_ROOT, id);
  const outputPath = path.join(outputDir, "sub2api-import-oauth.json");
  const checkpointPath = path.join(outputDir, LOGIN_CHECKPOINT_FILENAME);
  const totpResultPath = path.join(outputDir, TOTP_SETUP_RESULT_FILENAME);
  await fs.mkdir(outputDir, { recursive: true });

  const job = {
    id,
    email,
    status: "queued",
    prompt: "已加入任务队列",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    outputPath,
    checkpointPath,
    totpResultPath,
    logs: "",
    lastError: null,
    child: null,
    parserTail: "",
    resultSaved: false,
    creditBalance: null,
    loginMode,
    password,
    totpSecret,
    hasPasswordCredential: Boolean(password),
    hasTotpCredential: Boolean(totpSecret),
    proxyUrl,
    mailApiUrl,
    mailSource: resolveMailSource({ mailApiUrl, outlookClientId, outlookRefreshToken }),
    mailBaselineTime: null,
    outlookClientId,
    outlookRefreshToken,
    outlookPassword,
    mailSeenCandidateKeys: new Set(),
    mailCandidateCounts: new Map(),
    mailStatus: mailApiUrl || (outlookClientId && outlookRefreshToken) ? "baseline" : "manual",
    mailApiError: null,
    mailPollRunning: false,
    mailPollToken: null,
    currentPhone: null,
    phoneError: null,
    restartRequired: false,
    attempt: 1,
    runId: null,
    runMode: null,
    queuedMode: "full",
    queuedAt: new Date().toISOString(),
    queuedStartPrompt: "正在建立登录会话",
    fallbackInProgress: false,
    totpSetupSecret: null,
    totpSetupUri: null,
    totpSetupError: null,
    totpKnownEnabled: false,
    totpSetupAttempt: 0,
    totpResultLoading: false,
    proxyRiskRetryCount: 0,
    proxyConnectionFailureCount: 0,
    proxyRiskRestarting: false,
    proxySessionAttemptIds: new Set(),
    proxyAttemptParserTail: "",
    queueRunId: null,
    lastAuthAutomated: false,
    lastAuthAutomationReason: "尚未完成可验证的全自动登录",
    lastAuthAutomatedAt: null,
    lastAuthRequirements: null,
    authAutomationAttempt: null,
    autoRepairBlocked: false,
    autoRepairBlockedReason: null,
    autoRepairBlockedAt: null,
    autoRepairLastAttemptAt: null,
    autoRepairLastSuccessAt: null,
    autoRepairLastError: null,
    autoRepairPendingAccountIds: [],
    autoRepairPendingBackend: null,
    autoRepairOperation: null,
    ...newSmsState(),
  };
  beginAuthorizationAutomationAttempt(job, "initial");
  jobs.set(id, job);
  await saveJobMetadata(job);
  scheduleQueuedJobs();
  return job;
}

function scheduleQueuedJobs() {
  if (shuttingDown || queueSchedulingPaused) return;
  let availableSlots = MAX_ACTIVE_JOBS - [...jobs.values()].filter(occupiesActiveSlot).length;
  if (availableSlots <= 0) return;
  const queuedJobs = [...jobs.values()]
    .filter((job) => job.status === "queued")
    .sort((a, b) => String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt)));
  for (const job of queuedJobs.slice(0, availableSlots)) {
    const mode = job.queuedMode || "full";
    const queueRunId = crypto.randomUUID();
    job.queueRunId = queueRunId;
    job.status = mode === "refresh" ? "refreshing" : mode === "totp_setup" ? "totp_starting" : "starting";
    job.prompt = job.queuedStartPrompt || (mode === "refresh"
      ? "正在使用已有刷新令牌直接生成新授权"
      : mode === "totp_setup" ? "正在重新验证账号并准备设置 2FA" : "正在建立登录会话");
    job.queuedAt = null;
    touch(job);
    void saveJobMetadata(job).catch(() => {});
    void prepareAndLaunchJob(job, mode, queueRunId);
    availableSlots -= 1;
    if (availableSlots <= 0) break;
  }
}

async function prepareAndLaunchJob(job, mode, queueRunId) {
  try {
    if (["full", "totp_setup"].includes(mode) && job.mailSource !== "none") await loadMailboxBaseline(job);
    if (!isActive(job.status) || job.status === "queued" || job.queueRunId !== queueRunId) return;
    let tlsProfile = "";
    if (["full", "totp_setup"].includes(mode) && !job.proxyUrl) {
      job.prompt = "正在等待本机直连 TLS 指纹探测";
      touch(job);
      tlsProfile = await directTlsProfileProbe.resolve();
      if (!isActive(job.status) || job.status === "queued" || job.queueRunId !== queueRunId) return;
    }
    launchJob(job, { mode, tlsProfile });
  } catch (error) {
    if (mode === "totp_setup") {
      restoreTotpSetupFailure(job, `准备 2FA 设置失败：${error.message}`);
    } else {
      failJob(job, `准备登录任务失败：${error.message}`);
    }
    scheduleQueuedJobs();
  }
}

function enqueueJob(job, mode, startPrompt) {
  job.queueRunId = null;
  job.status = "queued";
  job.prompt = "已加入任务队列";
  job.queuedMode = mode;
  job.queuedAt = new Date().toISOString();
  job.queuedStartPrompt = startPrompt;
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

function launchJob(job, options = {}) {
  const mode = options.mode || "full";
  if (mode === "full" && !job.authAutomationAttempt) {
    beginAuthorizationAutomationAttempt(job, "login");
  }
  const runId = crypto.randomUUID();
  job.runId = runId;
  job.runMode = mode;
  const args = mode === "refresh"
    ? [
        PROTOCOL_SCRIPT,
        "--refresh-sub2api",
        job.outputPath,
        "--sub2api-out",
        job.outputPath,
        "--verbose",
      ]
    : mode === "totp_setup"
      ? [
          PROTOCOL_SCRIPT,
          "--email",
          job.email,
          "--setup-totp",
          "--totp-result",
          job.totpResultPath,
          "--verbose",
        ]
    : [
        PROTOCOL_SCRIPT,
        "--email",
        job.email,
        "--output-mode",
        "sub2api",
        "--sub2api-out",
        job.outputPath,
        "--checkpoint",
        job.checkpointPath,
        "--resume-checkpoint",
        job.checkpointPath,
        "--verbose",
      ];
  const child = spawn(process.execPath, args, {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      CHATGPT_LOGIN_PASSWORD: job.password || "",
      CHATGPT_TOTP_SECRET: job.totpSecret || "",
      CHATGPT_PROXY_URL: job.proxyUrl || "",
      CHATGPT_PROXY_MAX_ATTEMPTS: String(Math.max(0, MAX_PROXY_RISK_RETRIES - (job.proxyRiskRetryCount || 0))),
      TOSUB2_TLS_PROFILE:
        String(process.env.TOSUB2_TLS_PROFILE || "").trim()
        || (!job.proxyUrl ? String(options.tlsProfile || directTlsProfileProbe.profile || "") : ""),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  job.child = child;

  child.stdout.on("data", (chunk) => {
    if (job.runId === runId) consumeOutput(job, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    if (job.runId === runId) consumeOutput(job, chunk.toString("utf8"));
  });
  child.on("error", (error) => {
    void withEmailJobLock(job.email, async () => {
      if (job.runId !== runId) return;
      if (mode === "totp_setup") restoreTotpSetupFailure(job, `无法启动 2FA 设置进程：${error.message}`);
      else failJob(job, `无法启动登录进程：${error.message}`);
    });
  });
  child.on("close", (code, signal) => {
    void withEmailJobLock(job.email, () => handleChildClose(job, { code, signal, mode, runId }))
      .catch((error) => {
        handleChildCloseFailure(job, mode, runId, error);
      });
  });
}

/**
 * 查询任务账号的 ChatGPT Credit 余额并写入 job.creditBalance。
 * 读取导入文件里的 access_token/refresh_token 调 wham/usage；
 * 若触发 token 刷新，把新 access_token 回写到导入文件。
 * 失败时记录 creditError 但不阻断主流程。
 */
async function refreshJobCreditBalance(job) {
  if (!job.resultSaved || !(await fileExists(job.outputPath))) return;
  try {
    const data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
    const account = Array.isArray(data?.accounts) ? data.accounts.find((a) => a?.credentials) : null;
    if (!account?.credentials) return;
    const creds = account.credentials;
    if (!creds.access_token) return;
    const result = await fetchChatgptCredits({
      accessToken: creds.access_token,
      refreshToken: creds.refresh_token,
      clientId: creds.client_id,
    });
    job.creditBalance = result.balance;
    job.creditError = null;
    // token 刷新成功时回写导入文件，避免下次还用过期的 access_token
    if (result.refreshedAccessToken && result.refreshedAccessToken !== creds.access_token) {
      creds.access_token = result.refreshedAccessToken;
      const tempPath = `${job.outputPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tempPath, job.outputPath);
    }
  } catch (error) {
    job.creditError = String(error?.message || error).slice(0, 200);
  }
  touch(job);
}

async function handleChildClose(job, { code, signal, mode, runId }) {
  if (job.runId !== runId) return;
  stopMailPolling(job);
  job.child = null;
  if (mode === "totp_setup") {
    await finishTotpSetup(job, code, signal);
    scheduleQueuedJobs();
    return;
  }
  if (["canceled", "reauth_required"].includes(job.status)) {
    await finishSub2ApiAutoRepairFailure(job);
    scheduleQueuedJobs();
    return;
  }
  if (code === 0 && job.resultSaved && (await fileExists(job.outputPath))) {
    if (mode === "full") completeAuthorizationAutomationAttempt(job);
    job.status = "completed";
    job.prompt = "授权完成，可以下载导入文件";
    job.completedAt = new Date().toISOString();
    touch(job);
    await saveJobMetadata(job);
    void refreshJobCreditBalance(job).then(() => saveJobMetadata(job)).catch(() => {});
    await finishSub2ApiAutoRepairSuccess(job);
    // 备用号池补号任务完成 → 自动上传到 Sub2API
    if (job.reserveJoinConfig) {
      void finishReserveJoinUpload(job).catch((error) => {
        console.warn(`[warn] 备用号池上传失败：${String(error?.message || error).slice(0, 180)}`);
      });
    }
    scheduleQueuedJobs();
    return;
  }
  if (job.status !== "failed") {
    if (await fileExists(job.checkpointPath)) {
      markResumeAvailable(job, signal ? `登录进程被 ${signal} 终止` : "登录流程中断");
    } else {
      failJob(job, signal ? `登录进程被 ${signal} 终止` : `登录进程退出，代码 ${code ?? "未知"}`);
    }
  }
  await finishSub2ApiAutoRepairFailure(job);
  scheduleQueuedJobs();
}

function handleChildCloseFailure(job, mode, runId, error) {
  if (job.runId !== runId && !(mode === "totp_setup" && job.runId === null)) return;
  const message = `收尾处理失败：${error.message}`;
  if (mode === "totp_setup") {
    job.status = "completed";
    job.prompt = "原授权文件仍然可用，2FA 密钥尚未完成安全保存";
    job.totpSetupError = `${message}；已保留 2FA 结果文件，请重试保存`;
    job.runMode = null;
    job.runId = null;
  } else {
    failJob(job, message);
  }
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

async function retryJob(job, options = {}) {
  if (!["failed", "canceled", "reauth_required", "resume_available"].includes(job.status)) {
    throw httpError(409, "当前任务不需要重新授权");
  }
  const retryingSecurityCheck = Boolean(job.securityCheckRequired);
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    const persisted = await saveStoredLoginCredentials(job.email, job);
  }
  const resumingCheckpoint = job.status === "resume_available"
    || (retryingSecurityCheck && await fileExists(job.checkpointPath));
  stopMailPolling(job);
  if (resumingCheckpoint) stopSmsPolling(job);
  else releaseSmsNumber(job, "idle");
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  const startPrompt = retryingSecurityCheck && resumingCheckpoint
    ? "正在使用已有登录状态重试手机号绑定"
    : "正在重新建立登录会话";
  job.lastError = null;
  job.parserTail = "";
  job.completedAt = null;
  job.currentPhone = resumingCheckpoint ? (job.currentPhone || job.smsNumber) : null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.attempt += 1;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.mailCandidateCounts.clear();
  clearAutoRepairBlock(job);
  job.autoRepairOperation = null;
  job.autoRepairPendingAccountIds = [];
  job.autoRepairPendingBackend = null;
  beginAuthorizationAutomationAttempt(job, "manual_retry");
  appendJobLog(
    job,
    retryingSecurityCheck
      ? `\n[retry] 开始第 ${job.attempt} 次手动重试；优先复用已有登录检查点。\n`
      : `\n[retry] 开始第 ${job.attempt} 次授权登录。\n`,
  );
  enqueueJob(job, "full", startPrompt);
}

async function regenerateJob(job, options = {}) {
  if (job.status !== "completed" || !job.resultSaved) {
    throw httpError(409, "只能为已经完成的任务重新生成授权");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  releaseSmsNumber(job, "idle");
  job.restartRequired = false;
  job.completedAt = null;
  job.attempt += 1;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  appendJobLog(job, `\n[refresh] 第 ${job.attempt} 次生成：优先使用已有刷新令牌。\n`);
  enqueueJob(job, "refresh", "正在使用已有刷新令牌直接生成新授权");
}

async function forceReloginJob(job, options = {}, context = {}) {
  if (!canForceRelogin(job)) {
    throw httpError(409, "当前任务正在进行中，不能重新登录");
  }
  await reloadMissingJobCredentials(job);
  if (!canForceRelogin(job)) {
    throw httpError(409, "当前任务正在进行中，不能重新登录");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  await Promise.all([
    removePrivateFile(job.checkpointPath),
    removePrivateFile(job.totpResultPath),
  ]);
  job.lastError = null;
  job.parserTail = "";
  job.completedAt = null;
  job.currentPhone = null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupError = null;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.mailCandidateCounts.clear();
  job.attempt += 1;
  if (!context.autoRepair) {
    clearAutoRepairBlock(job);
    job.autoRepairPendingAccountIds = [];
    job.autoRepairPendingBackend = null;
  }
  job.autoRepairOperation = context.autoRepair || null;
  if (context.autoRepair) {
    job.autoRepairLastAttemptAt = new Date().toISOString();
    job.autoRepairLastError = null;
    job.autoRepairPendingAccountIds = [...new Set(context.autoRepair.accountIds || [])];
    job.autoRepairPendingBackend = context.autoRepair.backend || null;
  }
  beginAuthorizationAutomationAttempt(job, context.autoRepair ? "sub2api_monitor" : "manual_relogin");
  appendJobLog(job, `\n[relogin] 第 ${job.attempt} 次授权：跳过刷新令牌并强制重新登录。\n`);
  if (job.hasTotpCredential && !job.totpSecret) {
    appendJobLog(job, "[mfa] 本地未能读取已记录的 2FA 密钥，遇到 2FA 时需要手动输入验证码。\n");
  }
  enqueueJob(job, "full", "正在强制重新登录并完成授权");
}

async function reloadMissingJobCredentials(job) {
  if (
    (job.password || !job.hasPasswordCredential)
    && (job.totpSecret || !job.hasTotpCredential)
    && job.proxyUrl
  ) return;
  const stored = await loadStoredLoginCredentials(job.email);
  job.password ||= stored.password;
  job.totpSecret ||= stored.totpSecret;
  job.proxyUrl ||= stored.proxyUrl;
  if (job.password) job.hasPasswordCredential = true;
  if (job.totpSecret) job.hasTotpCredential = true;
  if (stored.password || stored.totpSecret || stored.proxyUrl) {
    await saveStoredLoginCredentials(job.email, job);
  }
}

async function startTotpSetup(job, options = {}) {
  if (job.status !== "completed" || !job.resultSaved) {
    throw httpError(409, "只能为已经完成授权的账号设置 2FA");
  }
  if (job.totpSecret || job.hasTotpCredential) {
    throw httpError(409, "该账号已经保存了 2FA 密钥，无需重复设置");
  }
  if (job.totpKnownEnabled) {
    throw httpError(409, "该账号已经启用 2FA，但本地没有它的原始密钥，无法重复创建");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = normalizeProxyUrl(options.proxyUrl);
    await saveStoredLoginCredentials(job.email, job);
  }
  await removePrivateFile(job.totpResultPath);
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupError = null;
  job.totpSetupAttempt = (job.totpSetupAttempt || 0) + 1;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.lastError = null;
  job.parserTail = "";
  appendJobLog(job, `\n[2fa] 开始第 ${job.totpSetupAttempt} 次 2FA 设置，原授权文件保持不变。\n`);
  enqueueJob(job, "totp_setup", "正在重新验证账号并准备设置 2FA");
}

async function loadTotpSetupResult(job) {
  const data = JSON.parse(await fs.readFile(job.totpResultPath, "utf8"));
  if (data?.version !== 1) throw new Error("2FA 设置结果文件格式不正确");
  if (data.already_enabled) {
    job.totpKnownEnabled = true;
    job.totpSetupSecret = null;
    job.totpSetupUri = null;
    return data;
  }
  const secret = normalizeTotpSecret(data.secret);
  const uri = String(data.otpauth_uri || "");
  if (!uri.startsWith("otpauth://totp/")) throw new Error("2FA 设置地址格式不正确");
  job.totpSetupSecret = secret;
  job.totpSetupUri = uri;
  if (data.activation_mode === "automatic") {
    if (job.status !== "totp_setup_otp") setStage(job, "working", "2FA 密钥已生成，正在自动激活");
  } else {
    setStage(job, "totp_setup_otp", "密钥已生成，请添加到验证器后输入当前 6 位验证码");
  }
  return data;
}

async function finishTotpSetup(job, code, signal) {
  let result = null;
  try {
    result = await loadTotpSetupResult(job);
  } catch (error) {
    if (error?.code !== "ENOENT" && !job.totpSetupError) job.totpSetupError = error.message;
  }

  const activationSucceeded = result?.activation_succeeded === true;
  let removeResult = false;
  if (code === 0 && result?.already_enabled) {
    job.totpKnownEnabled = true;
    job.prompt = "账号已经启用 2FA，但服务端不会返回原始密钥";
    job.totpSetupError = "如需自动登录，请重新导入这个账号原有的 2FA 密钥";
    removeResult = true;
  } else if ((code === 0 || activationSucceeded) && result?.secret) {
    const secret = normalizeTotpSecret(result.secret);
    job.totpSecret = secret;
    job.hasTotpCredential = true;
    job.totpKnownEnabled = true;
    const persisted = await saveStoredLoginCredentials(job.email, job);
    job.prompt = activationSucceeded && code !== 0
      ? "2FA 已激活并保存，但最终状态确认未完成"
      : "2FA 已设置并安全保存，可以继续下载或重新授权";
    job.totpSetupError = !persisted
      ? "当前系统不支持持久凭据存储，2FA 密钥已保留在私有结果文件中，请不要删除该任务目录"
      : activationSucceeded && code !== 0
      ? "激活接口已返回成功，但后续确认请求失败；密钥已保留"
      : null;
    appendJobLog(job, persisted
      ? "[2fa] 2FA 设置成功，密钥已写入系统凭据存储，未写入协议日志。\n"
      : "[2fa] 2FA 设置成功，但当前系统不支持持久凭据存储；密钥已保留在私有结果文件中。\n");
    removeResult = persisted;
  } else {
    job.prompt = "授权文件仍然可用，本次 2FA 设置未完成";
    job.totpSetupError ||= signal
      ? `2FA 设置进程被 ${signal} 终止`
      : `2FA 设置进程退出，代码 ${code ?? "未知"}`;
  }

  job.status = "completed";
  job.runMode = null;
  job.runId = null;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  if (removeResult || !result?.secret || result?.activation_succeeded === false) {
    await removePrivateFile(job.totpResultPath);
  }
  touch(job);
  await saveJobMetadata(job);
}

async function removePrivateFile(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function restoreTotpSetupFailure(job, message) {
  job.status = "completed";
  job.prompt = "授权文件仍然可用，本次 2FA 设置未完成";
  job.totpSetupError = message;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.runMode = null;
  job.child?.kill("SIGTERM");
  job.child = null;
  void removePrivateFile(job.totpResultPath).catch(() => {});
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

async function fallbackFromRefresh(job) {
  if (job.runMode !== "refresh" || job.fallbackInProgress) return;
  job.fallbackInProgress = true;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.status = "starting";
  job.prompt = "已有授权状态已过期，正在重新进行邮箱登录";
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  beginAuthorizationAutomationAttempt(job, "refresh_fallback");
  appendJobLog(job, "[refresh] 刷新令牌已失效，自动回退到邮箱验证码登录。\n");
  job.fallbackInProgress = false;
  if (job.status !== "canceled") {
    enqueueJob(job, "full", "刷新令牌已失效，正在重新登录并授权");
  }
  touch(job);
}

function consumeOutput(job, rawText) {
  const proxyAttemptScan = `${job.proxyAttemptParserTail || ""}${rawText}`;
  job.proxyAttemptParserTail = proxyAttemptScan.slice(-160);
  let proxyAttemptNotices = "";
  for (const match of proxyAttemptScan.matchAll(/\[proxy-session-attempt\]\s+([a-f0-9-]{36})/gi)) {
    const attemptId = match[1].toLowerCase();
    if (job.proxySessionAttemptIds.has(attemptId)) continue;
    job.proxySessionAttemptIds.add(attemptId);
    job.proxyRiskRetryCount = Math.min(MAX_PROXY_RISK_RETRIES, (job.proxyRiskRetryCount || 0) + 1);
    job.proxyConnectionFailureCount = 0;
    proxyAttemptNotices += `[proxy] 正在检测第 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个新代理会话。\n`;
    void saveJobMetadata(job).catch(() => {});
  }
  const text = `${proxyAttemptNotices}${sanitizeLog(rawText)}`
    .replace(/^\[proxy-session-attempt\][^\r\n]*(?:\r?\n)?/gim, "");
  job.logs = `${job.logs}${text}`.slice(-MAX_LOG_CHARS);
  const scan = `${job.parserTail}${text}`;
  job.parserTail = scan.slice(-2_000);

  if (scan.includes("[3/5] Password login page reached.")) {
    markAuthorizationRequirement(job, "password");
    if (job.password) markAuthorizationAutomatic(job, "password");
  }
  if (scan.includes("[3/5] Email OTP page reached.")) {
    markAuthorizationRequirement(job, "emailOtp");
  }

  if (scan.includes("[proxy-risk-retry]")) {
    void restartAfterProxyRisk(job, {
      connectionFailure: scan.includes("PROXY_CONNECTION_RETRY"),
    }).catch((error) => {
      finishProxyRiskRetries(job, `自动更换代理会话失败：${error.message}`);
    });
    return;
  }

  if (job.runMode === "refresh" && scan.includes("REFRESH_TOKEN_INVALID")) {
    void fallbackFromRefresh(job);
    return;
  }

  if (job.runMode === "totp_setup" && scan.includes("[2fa-setup-ready]") && !job.totpResultLoading && !job.totpSetupSecret) {
    job.totpResultLoading = true;
    setStage(job, "working", "2FA 密钥已经生成，正在安全读取");
    void loadTotpSetupResult(job)
      .catch((error) => {
        job.totpSetupError = `无法读取 2FA 密钥：${error.message}`;
        job.child?.kill("SIGTERM");
        touch(job);
      })
      .finally(() => {
        job.totpResultLoading = false;
      });
  }

  if (job.runMode === "totp_setup" && scan.includes("[2fa-already-enabled]")) {
    job.totpKnownEnabled = true;
    setStage(job, "working", "账号已经启用 2FA，正在收尾");
  }

  if (job.runMode === "totp_setup" && scan.includes("[ok] 2FA setup activated")) {
    setStage(job, "working", "2FA 已激活，正在安全保存密钥");
  }

  if (scan.includes("[security-check-required]")) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "本次登录需要浏览器安全校验，2FA 尚未设置";
      touch(job);
      return;
    }
    requireBrowserSecurityCheck(job);
    return;
  }

  if (scan.includes("[profile-security-check-required]")) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "账号资料校验未通过，2FA 尚未设置";
      touch(job);
      return;
    }
    requireProfileSecurityCheck(job);
    return;
  }

  if (scan.includes("ACCOUNT_PROFILE_REQUIRED")) {
    failAccountProfileRequired(job);
    return;
  }

  const sessionErrorLines = [...scan.matchAll(/^\[error\]\s*([^\r\n]+)/gim)];
  const latestSessionError = sessionErrorLines.at(-1)?.[1] || "";
  if (/Your sign-in session is no longer valid|["']code["']\s*:\s*["']invalid_state["']/i.test(latestSessionError)) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "设置 2FA 时登录状态失效，请稍后重试";
      touch(job);
      return;
    }
    requireReauthorization(job, "当前登录状态已经失效，继续更换手机号也无法发送验证码");
    return;
  }

  if (scan.includes("[auth-expired]")) {
    stopSmsPolling(job);
    releaseSmsNumber(job, "idle");
    job.currentPhone = null;
    job.phoneError = null;
    setStage(job, "starting", "新登录状态被服务端拒绝，正在自动重新获取邮箱验证码");
  }

  if (scan.includes("Email OTP (r=resend, q=quit):")) {
    markAuthorizationRequirement(job, "emailOtp");
    const rejected = scan.includes("[email-otp-rejected]");
    setStage(
      job,
      "email_otp",
      rejected
        ? "邮箱验证码错误，请重新输入或重新发送"
        : job.mailSource !== "none"
          ? "正在等待收码接口返回新验证码，也可以手动输入"
          : "请输入邮箱验证码",
    );
    if (job.mailSource !== "none") void beginMailPolling(job);
  }
  if (scan.includes("Password (q=quit):")) {
    markAuthorizationRequirement(job, "password");
    stopMailPolling(job);
    setStage(job, "password", "请输入账号密码");
  }
  if (scan.includes("2FA setup OTP (6 digits, q=quit):")) {
    setStage(job, "totp_setup_otp", "请将密钥添加到验证器后输入当前 6 位验证码");
  }
  const mfaReachedIndex = scan.lastIndexOf("[mfa] TOTP 2FA challenge reached.");
  const mfaPromptIndex = scan.lastIndexOf("2FA OTP (6 digits, q=quit):");
  if (mfaReachedIndex > mfaPromptIndex) {
    markAuthorizationRequirement(job, "mfa");
    setStage(job, "working", job.totpSecret ? "正在自动完成 2FA 验证" : "正在准备 2FA 验证");
  } else if (mfaPromptIndex > mfaReachedIndex) {
    markAuthorizationRequirement(job, "mfa");
    setStage(job, "mfa_otp", "请输入 6 位 2FA 验证码");
  }
  if (scan.includes("[mfa] Generated a 6-digit code from the configured 2FA key.")) {
    markAuthorizationAutomatic(job, "mfa");
  }
  const phoneNumberPromptIndex = scan.lastIndexOf("Phone number, E.164 format");
  const phoneOtpPromptIndex = scan.lastIndexOf("Phone OTP (r=resend, p=change phone, q=quit):");
  if (phoneNumberPromptIndex > phoneOtpPromptIndex) {
    stopMailPolling(job);
    setStage(job, "phone", "请输入需要绑定的手机号");
  } else if (phoneOtpPromptIndex > phoneNumberPromptIndex) {
    if (job.smsStatus !== "error") job.phoneError = null;
    setStage(
      job,
      "phone_otp",
      job.currentPhone ? `短信验证码已发送至 ${job.currentPhone}` : "请输入手机短信验证码",
    );
    if (job.smsOrderId && job.smsNumber === job.currentPhone) void beginSmsPolling(job);
  }

  const sendFailures = [...scan.matchAll(/\[warn\] Could not send SMS to (\+\d+):\s*([^\r\n]+)/g)];
  if (sendFailures.length) {
    const latest = sendFailures.at(-1);
    job.currentPhone = latest[1];
    job.phoneError = friendlyPhoneError(latest[2]);
    if (job.smsOrderId && job.smsNumber === job.currentPhone) {
      releaseSmsNumber(job, "error", "该平台手机号无法接收验证码，请重新取号或手动输入其他手机号");
    }
    setStage(job, "phone", `手机号 ${job.currentPhone} 无法接收验证码，请更换手机号`);
  }

  const validationFailures = [...scan.matchAll(/\[warn\] Phone OTP validation failed:\s*([^\r\n]+)/g)];
  if (validationFailures.length) {
    const validationMessage = validationFailures.at(-1)[1];
    job.phoneError = friendlyPhoneOtpError(validationMessage);
    stopSmsPolling(job);
    if (job.smsStatus === "submitted") {
      job.smsStatus = "error";
      job.smsError = "平台返回的验证码未通过验证，请重新发送或更换手机号";
    }
    setStage(
      job,
      "phone_otp",
      job.currentPhone ? `请重新输入发送至 ${job.currentPhone} 的验证码` : "请重新输入手机验证码",
    );
    if (shouldChangePhoneAfterOtpFailure(validationMessage)) {
      job.smsError = job.phoneError;
      appendJobLog(job, "[sms] 当前手机号已被服务端拒绝，停止提交旧验证码并自动返回换号步骤。\n");
      void submitJobInput(job, { action: "change_phone", value: "" }, {
        preservePhoneError: true,
      }).catch((error) => {
        failJob(job, `无法自动返回换号步骤：${error.message}`);
      });
      touch(job);
      return;
    }
  }
  if (scan.includes("[ok] Phone OTP validated")) {
    completeSmsNumber(job);
  }
  if (scan.includes("[5/5] Select workspace") || scan.includes("[6/6] Convert OAuth callback")) {
    setStage(job, "finalizing", "正在完成授权并生成文件");
  }
  if (scan.includes("[4/5] Existing workspace/session selected")) {
    setStage(job, "finalizing", "账号已绑定手机号，正在继续授权");
  }
  if (scan.includes("[ok] Saved sub2api import:")) {
    job.resultSaved = true;
    setStage(job, "finalizing", "导入文件已生成，正在收尾");
  }

  const errorMatches = [...scan.matchAll(/\[error\]\s*([^\r\n]+)/g)];
  if (errorMatches.length) {
    const errorMessage = extractResponseMessage(errorMatches.at(-1)[1]);
    if (job.runMode === "totp_setup") {
      job.totpSetupError = errorMessage;
    } else {
      failJob(job, errorMessage);
    }
  }
  touch(job);
}

async function restartAfterProxyRisk(job, options = {}) {
  if (job.proxyRiskRestarting || isTerminalStatus(job.status)) return;
  job.proxyRiskRestarting = true;
  const mode = job.runMode || job.queuedMode || "full";
  try {
    if (!job.proxyUrl || !proxySupportsSessionRotation(job.proxyUrl)) {
      finishProxyRiskRetries(
        job,
        job.proxyUrl
          ? "当前代理没有可识别的会话编号，无法自动轮换；请更换代理配置后重试"
          : "当前使用本地 IP，无法自动更换出口；请配置可轮换代理后重试",
      );
      return;
    }
    if ((job.proxyRiskRetryCount || 0) >= MAX_PROXY_RISK_RETRIES) {
      finishProxyRiskRetries(job, `代理会话已自动更换 ${MAX_PROXY_RISK_RETRIES} 次，仍然触发安全校验`);
      return;
    }
    if (options.connectionFailure) {
      job.proxyConnectionFailureCount = (job.proxyConnectionFailureCount || 0) + 1;
      if (job.proxyConnectionFailureCount >= MAX_PROXY_CONNECTION_FAILURES) {
        finishProxyRiskRetries(
          job,
          `代理连接连续失败 ${MAX_PROXY_CONNECTION_FAILURES} 次，已停止自动重试`,
        );
        return;
      }
    }

    stopMailPolling(job);
    stopSmsPolling(job);
    releaseSmsNumber(job, "idle");
    job.queueRunId = null;
    job.runId = crypto.randomUUID();
    const restartRunId = job.runId;
    job.child?.kill("SIGTERM");
    job.child = null;
    if (mode === "full") await removePrivateFile(job.checkpointPath);
    job.parserTail = "";
    job.lastError = null;
    job.currentPhone = null;
    job.phoneError = null;
    job.securityCheckRequired = false;
    job.restartRequired = false;
    appendJobLog(
      job,
      options.connectionFailure
        ? `[proxy] 代理连接失败，HTTP 检测次数仍为 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES}；连接失败 ${job.proxyConnectionFailureCount}/${MAX_PROXY_CONNECTION_FAILURES}。\n`
        : `[proxy] 登录阶段触发安全校验，已使用 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个代理会话，正在继续更换。\n`,
    );
    if (options.connectionFailure) {
      const retryDelay = Math.min(
        PROXY_CONNECTION_RETRY_MAX_MS,
        PROXY_CONNECTION_RETRY_BASE_MS * (2 ** Math.min(job.proxyConnectionFailureCount - 1, 4)),
      );
      job.status = "starting";
      job.prompt = `代理连接失败，${Math.ceil(retryDelay / 1_000)} 秒后更换会话`;
      touch(job);
      await saveJobMetadata(job);
      await delay(retryDelay);
      if (job.runId !== restartRunId || isTerminalStatus(job.status)) return;
    }
    job.proxyRiskRestarting = false;
    enqueueJob(
      job,
      mode,
      options.connectionFailure
        ? `代理连接失败，正在更换会话；HTTP 检测次数仍为 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES}`
        : `代理触发安全校验，已使用 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个代理会话`,
    );
  } finally {
    job.proxyRiskRestarting = false;
  }
}

function finishProxyRiskRetries(job, message) {
  job.proxyRiskRestarting = false;
  if (job.runMode === "totp_setup" || job.queuedMode === "totp_setup") {
    restoreTotpSetupFailure(job, message);
    return;
  }
  if (job.resultSaved) {
    job.status = "completed";
    job.prompt = "原授权文件仍然可用，自动更换代理未能完成本次操作";
    job.lastError = message;
    job.runMode = null;
    job.child?.kill("SIGTERM");
    job.child = null;
    touch(job);
    void saveJobMetadata(job).catch(() => {});
    scheduleQueuedJobs();
    return;
  }
  failJob(job, message);
  job.child?.kill("SIGTERM");
  job.child = null;
  scheduleQueuedJobs();
}

function requireReauthorization(job, message) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "reauth_required";
  job.prompt = "登录状态已失效，需要重新授权";
  job.lastError = message;
  job.phoneError = null;
  job.restartRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
}

function requireBrowserSecurityCheck(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "手机号绑定需要浏览器安全校验";
  job.lastError = "邮箱登录已经成功，但服务端拒绝了本次纯协议短信请求；可以手动重试，若仍被拒绝则需要稍后再试";
  job.phoneError = null;
  job.securityCheckRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
}

function requireProfileSecurityCheck(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "账号资料创建需要安全校验";
  job.lastError = "邮箱验证码已经通过，但账号资料创建仍被 Sentinel 安全校验拒绝；可以点击重新授权再次生成动态校验令牌";
  job.phoneError = null;
  job.securityCheckRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function failAccountProfileRequired(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "账号注册资料未完成";
  job.lastError = "邮箱验证已经成功，但该邮箱还没有完成账号资料填写。请先在官方页面完成姓名和出生日期后再重新授权。";
  job.phoneError = null;
  job.child?.kill("SIGTERM");
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function markResumeAvailable(job, reason = "登录流程中断") {
  stopMailPolling(job);
  stopSmsPolling(job);
  job.status = "resume_available";
  job.prompt = "邮箱登录检查点仍然有效，可以继续手机号绑定";
  job.lastError = `${reason}，继续时会优先恢复已保存状态；状态失效才重新获取邮箱验证码`;
  job.child = null;
  job.currentPhone = null;
  touch(job);
}

function friendlyPhoneError(message) {
  const text = String(message || "");
  if (/suspicious behavior/i.test(text)) return "该手机号触发了风控，请更换手机号或稍后重试";
  if (/too many|rate.?limit|HTTP 429/i.test(text)) return "短信发送过于频繁，请稍后重试或更换手机号";
  if (/already|used|unsupported|invalid phone/i.test(text)) return "该手机号不可用或已被使用，请更换手机号";
  return "短信验证码发送失败，请更换手机号后重试";
}

function extractResponseMessage(value) {
  const text = String(value || "").trim();
  const jsonAt = text.indexOf("{");
  if (jsonAt >= 0) {
    try {
      const payload = JSON.parse(text.slice(jsonAt));
      const message = payload?.error?.message || payload?.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {}
  }
  const match = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`).trim();
    } catch {
      return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim();
    }
  }
  return text;
}

function friendlyPhoneOtpError(message) {
  const text = String(message || "");
  if (/phone_recently_used|phone number was recently used/i.test(text)) {
    return "该手机号近期已被使用，已停止重复提交，请更换手机号";
  }
  if (/phone_number_in_use|phone number already in use/i.test(text)) {
    return "该手机号已绑定其他账号，请更换手机号";
  }
  if (/expired/i.test(text)) return "手机验证码已过期，请重新发送或更换手机号";
  if (/too many|rate.?limit|HTTP 429/i.test(text)) {
    return "验证次数过多，已停止自动提交，请稍后更换手机号";
  }
  return "手机验证码不正确，请重新输入；也可以重新发送或更换手机号";
}

function shouldChangePhoneAfterOtpFailure(message) {
  return /phone_recently_used|phone number was recently used|phone_number_in_use|phone number already in use|too many|rate.?limit|HTTP 429/i
    .test(String(message || ""));
}

function acquireCustomSmsEntry(entries) {
  const poolKey = crypto.createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("base64url");
  const nextIndex = customSmsPoolPositions.get(poolKey) || 0;
  if (nextIndex >= entries.length) return null;
  customSmsPoolPositions.set(poolKey, nextIndex + 1);
  return entries[nextIndex];
}

async function acquireSmsNumber(job, providerId, config) {
  requireStage(job, "phone");
  if (job.smsStatus === "requesting") throw httpError(409, "正在获取手机号，请不要重复提交");

  let smsClient;
  try {
    smsClient = createSmsProvider(providerId, config, {
      lubanApiBase: process.env.LUBAN_SMS_API_BASE,
      smsBowerApiBase: process.env.SMSBOWER_API_BASE,
      acquireCustomSmsEntry,
    });
  } catch (error) {
    throw httpError(400, safeSmsProviderError(error, config?.apiKey));
  }

  releaseSmsNumber(job, "idle");
  job.smsClient = smsClient;
  job.smsProviderId = smsClient.id;
  job.smsProviderName = smsClient.name;
  job.smsServiceLabel = smsClient.serviceLabel;
  job.smsStatus = "requesting";
  job.smsError = null;
  touch(job);

  let order;
  try {
    order = await smsClient.getNumber();
    if (job.status !== "phone" || !job.child) {
      void smsClient.release(order.requestId).catch(() => {});
      throw httpError(409, "任务已经不在手机号输入步骤，平台号码已释放");
    }
    job.smsOrderId = order.requestId;
    job.smsNumber = order.number;
    job.smsStatus = "number_acquired";
    job.smsError = null;
    await saveJobMetadata(job);
    appendJobLog(job, `[sms] 已从 ${smsClient.name} 获取手机号并提交，等待短信发送结果。\n`);
    await submitJobInput(job, { action: "phone", value: order.number }, { source: "sms-provider" });
  } catch (error) {
    if (order?.requestId && job.smsOrderId === order.requestId) releaseSmsNumber(job, "error");
    if (job.status === "phone") {
      job.smsStatus = "error";
      job.smsError = safeSmsProviderError(error, smsClient.apiKey);
      if (!order) job.smsClient = null;
      touch(job);
    }
    if (error?.status) throw error;
    throw httpError(502, safeSmsProviderError(error, smsClient.apiKey));
  }
}

async function beginSmsPolling(job) {
  if (
    !job.smsClient
    || !job.smsOrderId
    || job.smsPollToken
    || job.status !== "phone_otp"
    || !["number_acquired", "waiting_sms"].includes(job.smsStatus)
  ) return;
  const pollToken = crypto.randomUUID();
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  const startedAt = Date.now();
  job.smsPollToken = pollToken;
  job.smsStatus = "waiting_sms";
  job.smsError = null;
  touch(job);

  try {
    if (smsClient.markReady) {
      await smsClient.markReady(requestId).catch((error) => {
        appendJobLog(job, `[sms] ${smsClient.name} 更新号码就绪状态失败：${safeSmsProviderError(error)}\n`);
      });
    }
    while (
      job.smsPollToken === pollToken &&
      job.smsOrderId === requestId &&
      job.status === "phone_otp" &&
      job.child &&
      Date.now() - startedAt < SMS_POLL_TIMEOUT_MS
    ) {
      try {
        const result = await smsClient.getSms(requestId);
        if (job.smsPollToken !== pollToken || job.status !== "phone_otp" || !job.child) return;
        if (result.status === "received") {
          if (job.smsLastSubmittedCode === result.code) {
            job.smsStatus = "error";
            job.smsError = "接码平台仍返回已提交过的验证码，已停止重复提交";
            appendJobLog(job, `[sms] ${smsClient.name} 返回了已提交过的验证码，已停止本次自动轮询。\n`);
            touch(job);
            return;
          }
          job.smsLastSubmittedCode = result.code;
          job.smsStatus = "submitting";
          job.smsError = null;
          appendJobLog(job, `[sms] 已从 ${smsClient.name} 获取短信验证码并自动提交。\n`);
          await submitJobInput(job, { action: "phone_otp", value: result.code }, { source: "sms-provider" });
          return;
        }
        job.smsStatus = "waiting_sms";
        job.smsError = null;
      } catch (error) {
        if (job.smsPollToken !== pollToken) return;
        if (error?.terminal) {
          job.smsStatus = "error";
          job.smsError = `${safeSmsProviderError(error)}，可以手动输入验证码或更换手机号`;
          touch(job);
          return;
        }
        job.smsStatus = "waiting_sms";
        job.smsError = `${safeSmsProviderError(error)}，正在自动重试`;
        touch(job);
      }
      await delay(SMS_POLL_INTERVAL_MS);
    }

    if (job.smsPollToken === pollToken && job.status === "phone_otp") {
      job.smsStatus = "error";
      job.smsError = "等待平台短信超时，可以手动输入验证码或更换手机号";
      touch(job);
    }
  } finally {
    if (job.smsPollToken === pollToken) {
      job.smsPollToken = null;
      touch(job);
    }
  }
}

function stopSmsPolling(job) {
  job.smsPollToken = null;
}

function releaseSmsNumber(job, nextStatus = "idle", errorMessage = null) {
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  const providerName = job.smsProviderName || smsClient?.name || "接码平台";
  stopSmsPolling(job);
  job.smsOrderId = null;
  job.smsNumber = null;
  job.smsClient = null;
  job.smsLastSubmittedCode = null;
  job.smsStatus = nextStatus;
  job.smsError = errorMessage;
  if (nextStatus === "idle") {
    job.smsProviderId = null;
    job.smsProviderName = null;
    job.smsServiceLabel = null;
  }
  if (requestId && smsClient) {
    void smsClient.release(requestId).catch(() => {
      appendJobLog(job, `[sms] ${providerName} 号码释放请求失败，请在平台控制台检查订单。\n`);
    });
  }
  if (job.outputPath) void saveJobMetadata(job).catch(() => {});
}

function completeSmsNumber(job) {
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  if (!requestId || !smsClient) return;
  stopSmsPolling(job);
  job.smsOrderId = null;
  job.smsClient = null;
  job.smsLastSubmittedCode = null;
  job.smsStatus = "completed";
  job.smsError = null;
  appendJobLog(job, `[sms] 手机验证码已通过，正在完成 ${smsClient.name} 订单。\n`);
  if (smsClient.complete) {
    void smsClient.complete(requestId).catch((error) => {
      appendJobLog(job, `[sms] ${smsClient.name} 完成订单失败：${safeSmsProviderError(error)}\n`);
      touch(job);
    });
  }
  touch(job);
  if (job.outputPath) void saveJobMetadata(job).catch(() => {});
}

function newSmsState() {
  return {
    smsProviderId: null,
    smsProviderName: null,
    smsServiceLabel: null,
    smsOrderId: null,
    smsNumber: null,
    smsClient: null,
    smsStatus: "idle",
    smsError: null,
    smsPollToken: null,
    smsLastSubmittedCode: null,
  };
}

function restoredSmsState(metadata = {}) {
  const orderId = metadata.sms_order_id || metadata.luban_request_id;
  const number = metadata.sms_number || metadata.luban_number;
  if (!orderId || !number) return newSmsState();
  return {
    smsProviderId: metadata.sms_provider_id || "luban",
    smsProviderName: metadata.sms_provider_name || (metadata.sms_provider_id === "smsbower" ? "SMSBower" : "LubanSMS"),
    smsServiceLabel: metadata.sms_service_label || metadata.luban_service_id || null,
    smsOrderId: String(orderId),
    smsNumber: String(number),
    smsClient: null,
    smsStatus: "error",
    smsError: "服务重启后已停止自动收短信，可手动输入验证码或换号",
    smsPollToken: null,
    smsLastSubmittedCode: null,
  };
}

function safeSmsProviderError(error, apiKey = "") {
  let message = String(error?.message || "接码平台请求失败");
  if (apiKey) message = message.replaceAll(apiKey, "<已隐藏密钥>");
  return message
    .replace(/apikey=[^&\s]+/gi, "apikey=<已隐藏>")
    .replace(/api_key=[^&\s]+/gi, "api_key=<已隐藏>")
    .replace(/https?:\/\/\S+/gi, "<已隐藏接口地址>")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 220);
}

async function submitJobInput(job, body, options = {}) {
  if (!job.child || !isActive(job.status)) {
    throw httpError(409, "This login flow is not waiting for input");
  }
  const action = String(body.action || "");
  const rawValue = String(body.value || "");
  const value = rawValue.trim();
  let inputValue = "";

  if (action === "password") {
    requireStage(job, "password");
    if (!rawValue) throw httpError(400, "密码不能为空");
    await saveStoredLoginCredentials(job.email, {
      password: rawValue,
      totpSecret: job.totpSecret,
      proxyUrl: job.proxyUrl,
    });
    job.loginMode = "password";
    job.password = rawValue;
    job.hasPasswordCredential = true;
    markAuthorizationManual(job, "password");
    await saveJobMetadata(job);
    inputValue = rawValue;
    setStage(job, "working", "正在验证账号密码");
  } else if (action === "mfa_otp") {
    requireStage(job, "mfa_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "2FA 验证码必须是 6 位数字");
    inputValue = value;
    markAuthorizationManual(job, "mfa");
    setStage(job, "working", "正在验证 2FA 验证码");
  } else if (action === "totp_setup_otp") {
    requireStage(job, "totp_setup_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "设置 2FA 的验证码必须是 6 位数字");
    inputValue = value;
    setStage(job, "working", "正在激活新的 2FA");
  } else if (action === "email_otp") {
    requireStage(job, "email_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "Email code must be 6 digits");
    stopMailPolling(job);
    job.parserTail = "";
    markAuthorizationManual(job, "emailOtp");
    inputValue = value;
    setStage(job, "working", "正在验证邮箱验证码");
  } else if (action === "resend_email") {
    requireStage(job, "email_otp");
    stopMailPolling(job);
    job.parserTail = "";
    inputValue = "r";
    setStage(job, "working", "正在重新发送邮箱验证码");
  } else if (action === "phone") {
    requireStage(job, "phone");
    if (!/^\+[1-9]\d{6,14}$/.test(value)) throw httpError(400, "Phone number must use E.164 format, for example +60123456789");
    if (options.source !== "sms-provider") releaseSmsNumber(job, "idle");
    job.currentPhone = value;
    job.phoneError = null;
    inputValue = value;
    setStage(job, "working", `正在向 ${value} 发送手机验证码`);
  } else if (action === "phone_otp") {
    requireStage(job, "phone_otp");
    if (!/^\d{4,8}$/.test(value)) throw httpError(400, "Phone code must be 4 to 8 digits");
    stopSmsPolling(job);
    if (job.smsOrderId) job.smsStatus = options.source === "sms-provider" ? "submitted" : "manual_submitted";
    job.phoneError = null;
    inputValue = value;
    setStage(job, "working", "正在验证手机验证码");
  } else if (action === "resend_phone") {
    requireStage(job, "phone_otp");
    stopSmsPolling(job);
    if (job.smsOrderId) job.smsStatus = "number_acquired";
    job.phoneError = null;
    inputValue = "r";
    setStage(job, "working", job.currentPhone ? `正在向 ${job.currentPhone} 重新发送验证码` : "正在重新发送手机验证码");
  } else if (action === "change_phone") {
    requireStage(job, "phone_otp");
    const preservedPhoneError = options.preservePhoneError ? job.phoneError : null;
    releaseSmsNumber(
      job,
      options.preservePhoneError ? "error" : "idle",
      options.preservePhoneError ? preservedPhoneError : null,
    );
    job.currentPhone = null;
    job.phoneError = preservedPhoneError;
    inputValue = "p";
    setStage(
      job,
      "working",
      options.preservePhoneError ? "当前手机号不可用，正在返回换号步骤" : "正在返回手机号输入",
    );
  } else {
    throw httpError(400, "Unsupported input action");
  }

  job.parserTail = "";
  job.child.stdin.write(`${inputValue}\n`);
  touch(job);
}

async function cancelJob(job) {
  if (!isActive(job.status)) return;
  if (job.runMode === "totp_setup" || job.queuedMode === "totp_setup") {
    stopMailPolling(job);
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    await finishTotpSetup(job, 1, "SIGTERM");
    if (!job.totpKnownEnabled) {
      job.prompt = "授权文件仍然可用，2FA 设置已取消";
      job.totpSetupError = "用户取消了本次 2FA 设置";
      touch(job);
      await saveJobMetadata(job);
    }
    scheduleQueuedJobs();
    return;
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "canceled";
  job.prompt = "流程已取消";
  job.child?.kill("SIGTERM");
  job.child = null;
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

async function cancelAllJobs() {
  const activeJobs = [...jobs.values()].filter((job) => isActive(job.status));
  if (!activeJobs.length) return 0;
  queueSchedulingPaused = true;
  try {
    await Promise.all(activeJobs.map((job) => withEmailJobLock(job.email, () => cancelJob(job))));
    await Promise.all(activeJobs.map((job) => saveJobMetadata(job)));
  } finally {
    queueSchedulingPaused = false;
  }
  scheduleQueuedJobs();
  return activeJobs.length;
}

async function downloadResult(res, job) {
  if (!job.resultSaved || !(await fileExists(job.outputPath))) {
    sendJson(res, 409, { error: "The sub2api import file is not ready" });
    return;
  }
  const safeEmail = job.email.replace(/[^a-zA-Z0-9@._+-]/g, "_");
  const data = await fs.readFile(job.outputPath);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${safeEmail}-sub2api-import-oauth-${downloadTimestamp()}.json"`,
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

async function downloadBatchResult(res, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw httpError(400, "请至少选择一个已完成任务");
  }
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  if (uniqueIds.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多下载 ${MAX_BATCH_JOBS} 个账号`);

  const selected = uniqueIds.map((id) => jobs.get(id));
  if (selected.some((job) => !job)) throw httpError(404, "部分任务不存在，请刷新页面后重试");
  const downloadable = selected.filter((job) => job.resultSaved);
  if (downloadable.length === 0) throw httpError(409, "选中的任务里没有已完成的导入文件");

  const accounts = [];
  const proxies = [];
  for (const job of downloadable) {
    if (!(await fileExists(job.outputPath))) throw httpError(409, `${job.email} 的导入文件不存在`);
    const data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
    if (data.type !== "sub2api-data" || !Array.isArray(data.accounts)) {
      throw httpError(409, `${job.email} 的导入文件格式不正确`);
    }
    accounts.push(...data.accounts);
    if (Array.isArray(data.proxies)) proxies.push(...data.proxies);
  }

  const payload = Buffer.from(`${JSON.stringify({
    type: "sub2api-data",
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: uniqueByJson(proxies),
    accounts,
  }, null, 2)}\n`);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="sub2api-import-oauth-${accounts.length}-accounts-${downloadTimestamp()}.json"`,
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

async function buildSub2ApiUploadPayload(downloadable) {
  const accounts = [];
  const proxies = [];
  for (const job of downloadable) {
    if (!(await fileExists(job.outputPath))) throw httpError(409, `${job.email} 的导入文件不存在`);
    const data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
    if (data.type !== "sub2api-data" || !Array.isArray(data.accounts)) {
      throw httpError(409, `${job.email} 的导入文件格式不正确`);
    }
    accounts.push(...data.accounts);
    if (Array.isArray(data.proxies)) proxies.push(...data.proxies);
  }
  return {
    type: "sub2api-data",
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: uniqueByJson(proxies),
    accounts,
  };
}

/**
 * 将已完成的 job 上传到 Sub2API（从 HTTP 端点和备用号池补号路径共用）。
 * @param {object} config normalizeSub2ApiConfig 返回值
 * @param {Array} downloadable 已完成的 job 列表（有 resultSaved）
 * @returns {Promise<{created:number,updated:number,updatedAccountIds:number[],updateFailed:Array,result:*}>}
 */
async function uploadJobsToSub2Api(config, downloadable) {
  const payload = await buildSub2ApiUploadPayload(downloadable);
  const idempotencyKey = `tosub2-upload-${crypto.randomUUID()}`;

  // 未手动指定代理且开启自动选择时，为每个账号独立选择当前绑定账号最少的代理。
  let proxySelection = null;
  if (!config.proxyId && config.autoSelectProxy) {
    try {
      const proxyPayload = await requestSub2Api(config, "/api/v1/admin/proxies/all");
      const proxies = Array.isArray(proxyPayload) ? proxyPayload : Array.isArray(proxyPayload?.data) ? proxyPayload.data : [];
      const activeProxyIds = new Set(
        proxies
          .filter((proxy) => proxy && Number.isInteger(Number(proxy.id)) && String(proxy.status || "active") === "active")
          .map((proxy) => Number(proxy.id)),
      );
      if (activeProxyIds.size) {
        const accounts0 = await listAllSub2ApiOpenAiAccounts(config);
        const counts = new Map();
        for (const account of accounts0) {
          const pid = Number(account?.proxy_id);
          if (Number.isSafeInteger(pid) && pid > 0) counts.set(pid, (counts.get(pid) || 0) + 1);
        }
        proxySelection = { activeProxyIds, counts };
      }
    } catch {
      proxySelection = null;
    }
  }

  const accounts = payload.accounts.map((account) => {
    const { proxy_key: _proxyKey, ...accountData } = account;
    const credentials = { ...(account.credentials || {}) };
    if (config.modelWhitelist.length) {
      credentials.model_mapping = Object.fromEntries(config.modelWhitelist.map((model) => [model, model]));
    }
    let proxyIdForAccount = config.proxyId || 0;
    if (!proxyIdForAccount && proxySelection) {
      let minBound = Infinity;
      const candidates = [];
      for (const pid of proxySelection.activeProxyIds) {
        const bound = proxySelection.counts.get(pid) || 0;
        if (bound < minBound) {
          minBound = bound;
          candidates.length = 0;
          candidates.push(pid);
        } else if (bound === minBound) {
          candidates.push(pid);
        }
      }
      if (candidates.length) {
        proxyIdForAccount = candidates[Math.floor(Math.random() * candidates.length)];
        proxySelection.counts.set(proxyIdForAccount, (proxySelection.counts.get(proxyIdForAccount) || 0) + 1);
      }
    }
    const extra = { ...(accountData.extra && typeof accountData.extra === "object" ? accountData.extra : {}) };
    if (config.disableAutoPause5h) extra.auto_pause_5h_disabled = true;
    else delete extra.auto_pause_5h_disabled;
    if (config.disableAutoPause7d) extra.auto_pause_7d_disabled = true;
    else delete extra.auto_pause_7d_disabled;
    return {
      ...accountData,
      credentials,
      extra,
      status: "active",
      schedulable: true,
      group_ids: config.groupIds.length ? config.groupIds : (account.group_ids || []),
      ...(proxyIdForAccount ? { proxy_id: proxyIdForAccount } : {}),
      ...(config.concurrency !== null ? { concurrency: config.concurrency } : {}),
      ...(config.loadFactor !== null ? { load_factor: config.loadFactor } : {}),
      ...(config.priority !== null ? { priority: config.priority } : {}),
    };
  });

  // 上传前查重：按 email 匹配远程已有账户，避免重复。
  const existing = await listAllSub2ApiOpenAiAccounts(config);
  const remoteByEmail = new Map();
  for (const acc of existing) {
    const email = sub2ApiAccountEmail(acc);
    if (email) remoteByEmail.set(email, Number(acc.id));
  }
  const toCreate = [];
  const toUpdate = [];
  for (const account of accounts) {
    const email = sub2ApiAccountEmail(account);
    const accountId = email ? remoteByEmail.get(email) : null;
    if (Number.isSafeInteger(accountId) && accountId > 0) toUpdate.push({ account, accountId });
    else toCreate.push(account);
  }

  // 首次导入的账户：追加初始余额后缀
  if (toCreate.length) {
    const jobByEmail = new Map();
    for (const job of downloadable) {
      const email = String(job.email || "").trim().toLowerCase();
      if (email && isEmail(email)) jobByEmail.set(email, job);
    }
    await Promise.all(toCreate.map(async (account) => {
      const email = sub2ApiAccountEmail(account);
      const job = email ? jobByEmail.get(email) : null;
      if (job) await appendInitialBalanceSuffix(account, job);
    }));
  }

  // 新增组
  let createResult = null;
  if (toCreate.length) {
    createResult = await requestSub2Api(config, "/api/v1/admin/accounts/batch", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ accounts: toCreate }),
    });
  }

  // 覆盖组
  const updatedAccountIds = [];
  const updateFailed = [];
  for (const { account, accountId } of toUpdate) {
    try {
      await requestSub2Api(config, `/api/v1/admin/accounts/${accountId}`, {
        method: "PUT",
        body: JSON.stringify({ credentials: account.credentials || {} }),
      });
      await requestSub2Api(config, `/api/v1/admin/accounts/${accountId}/clear-error`, {
        method: "POST",
        body: "{}",
      });
      await requestSub2Api(config, `/api/v1/admin/accounts/${accountId}/schedulable`, {
        method: "POST",
        body: JSON.stringify({ schedulable: true }),
      });
      updatedAccountIds.push(accountId);
    } catch (error) {
      updateFailed.push({ accountId, error: String(error?.message || error).slice(0, 500) });
    }
  }

  return {
    created: toCreate.length,
    updated: updatedAccountIds.length,
    updatedAccountIds,
    updateFailed,
    result: createResult,
  };
}

function normalizeSub2ApiConfig(value) {
  const config = value && typeof value === "object" ? value : {};
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const adminApiKey = String(config.adminApiKey || "").trim();
  if (!baseUrl) throw httpError(400, "请填写 Sub2API 后端地址");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw httpError(400, "Sub2API 后端地址格式不正确");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw httpError(400, "Sub2API 后端地址必须使用 HTTP 或 HTTPS");
  }
  if (!adminApiKey || adminApiKey.length > 512 || /[\r\n]/.test(adminApiKey)) {
    throw httpError(400, "请填写有效的 Sub2API 管理员 API Key");
  }
  const rawGroupIds = Array.isArray(config.groupIds)
    ? config.groupIds
    : String(config.groupId || "").trim() ? [config.groupId] : [];
  const groupIds = [...new Set(rawGroupIds.map((value) => String(value).trim()).filter(Boolean))].map((value) => {
    if (!/^\d+$/.test(value) || Number(value) <= 0 || Number(value) > Number.MAX_SAFE_INTEGER) {
      throw httpError(400, "目标号池 ID 无效");
    }
    return Number(value);
  });
  const proxyText = String(config.proxyId || "").trim();
  if (proxyText && (!/^\d+$/.test(proxyText) || Number(proxyText) <= 0 || Number(proxyText) > Number.MAX_SAFE_INTEGER)) {
    throw httpError(400, "代理 ID 无效");
  }
  const proxyId = proxyText ? Number(proxyText) : 0;
  const concurrency = parseOptionalSub2ApiInteger(config.concurrency, "并发数", 0, 10000);
  const loadFactor = parseOptionalSub2ApiInteger(config.loadFactor, "负载因子", 0, 10000);
  const priority = parseOptionalSub2ApiInteger(config.priority, "优先级", 0, 10000);
  const modelWhitelist = parseSub2ApiModelWhitelist(config.modelWhitelist);
  const autoSelectProxy = config.autoSelectProxy !== false;
  const disableAutoPause5h = config.disableAutoPause5h === true;
  const disableAutoPause7d = config.disableAutoPause7d === true;
  const reserveThresholdRaw = Number(config.reserveThreshold);
  const reserveThreshold = Number.isFinite(reserveThresholdRaw) && reserveThresholdRaw >= 0 && reserveThresholdRaw <= 100000
    ? Math.floor(reserveThresholdRaw)
    : 0;
  return { baseUrl, adminApiKey, groupIds, proxyId, concurrency, loadFactor, priority, modelWhitelist, autoSelectProxy, disableAutoPause5h, disableAutoPause7d, reserveThreshold };
}

function readDurationEnv(name, fallback, minimum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function parseOptionalSub2ApiInteger(value, label, min, max) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw httpError(400, `${label}必须是数字`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw httpError(400, `${label}范围必须是 ${min} 到 ${max}`);
  return parsed;
}

function parseSub2ApiModelWhitelist(value) {
  const models = String(value || "")
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (models.length > 200) throw httpError(400, "支持模型最多填写 200 个");
  if (models.some((model) => model.length > 200 || /[\r\n]/.test(model))) throw httpError(400, "支持模型名称格式不正确");
  return [...new Set(models)];
}

function requestSub2Api(config, endpoint, options = {}) {
  const requestPromise = performSub2ApiRequest(config, endpoint, options);
  sub2ApiRequestPromises.add(requestPromise);
  void requestPromise.then(
    () => sub2ApiRequestPromises.delete(requestPromise),
    () => sub2ApiRequestPromises.delete(requestPromise),
  );
  return requestPromise;
}

async function performSub2ApiRequest(config, endpoint, options = {}) {
  const controller = new AbortController();
  sub2ApiRequestControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${config.baseUrl}${endpoint}`, {
      ...options,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": config.adminApiKey,
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = sub2ApiResponseMessage(payload, text).slice(0, 500);
      const error = httpError(502, `Sub2API 返回 HTTP ${response.status}${message ? `：${message}` : ""}`);
      error.remoteStatus = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.status) throw error;
    if (error?.name === "AbortError") {
      throw httpError(shuttingDown ? 503 : 504, shuttingDown ? "Sub2API 请求已因服务关闭而取消" : "Sub2API 请求超时");
    }
    throw httpError(502, `无法连接 Sub2API 后端：${error.message}`);
  } finally {
    clearTimeout(timeout);
    sub2ApiRequestControllers.delete(controller);
  }
}

function sub2ApiResponseMessage(payload, text) {
  const message = payload?.error?.message || payload?.message || payload?.error || "";
  return typeof message === "string" && message.trim()
    ? message.trim()
    : extractResponseMessage(text);
}

async function loadSub2ApiMonitorConfiguration() {
  try {
    const saved = JSON.parse(await fs.readFile(SUB2API_MONITOR_PATH, "utf8"));
    const config = normalizeSub2ApiConfig(saved.config);
    sub2ApiMonitorConfig = { ...config, enabled: saved.enabled === true };
    sub2ApiMonitorState.lastCheckAt = saved.state?.lastCheckAt || null;
    sub2ApiMonitorState.lastError = saved.state?.lastError || null;
    sub2ApiMonitorState.lastResult = saved.state?.lastResult && typeof saved.state.lastResult === "object"
      ? saved.state.lastResult
      : null;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[warn] Sub2API 号池监控配置无法读取：${String(error?.message || error).slice(0, 180)}`);
    }
    sub2ApiMonitorConfig = null;
  }
}

async function persistSub2ApiMonitorConfiguration() {
  if (!sub2ApiMonitorConfig) {
    await fs.rm(SUB2API_MONITOR_PATH, { force: true });
    return;
  }
  const payload = {
    version: 1,
    enabled: Boolean(sub2ApiMonitorConfig.enabled),
    config: {
      baseUrl: sub2ApiMonitorConfig.baseUrl,
      adminApiKey: sub2ApiMonitorConfig.adminApiKey,
      groupIds: sub2ApiMonitorConfig.groupIds,
      proxyId: sub2ApiMonitorConfig.proxyId,
      concurrency: sub2ApiMonitorConfig.concurrency,
      loadFactor: sub2ApiMonitorConfig.loadFactor,
      priority: sub2ApiMonitorConfig.priority,
      modelWhitelist: sub2ApiMonitorConfig.modelWhitelist,
      reserveThreshold: sub2ApiMonitorConfig.reserveThreshold || 0,
    },
    state: {
      lastCheckAt: sub2ApiMonitorState.lastCheckAt,
      lastError: sub2ApiMonitorState.lastError,
      lastResult: sub2ApiMonitorState.lastResult,
    },
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${SUB2API_MONITOR_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, SUB2API_MONITOR_PATH);
}

function publicSub2ApiMonitorState() {
  return {
    configured: Boolean(sub2ApiMonitorConfig?.baseUrl && sub2ApiMonitorConfig?.adminApiKey),
    enabled: Boolean(sub2ApiMonitorConfig?.enabled),
    baseUrl: sub2ApiMonitorConfig?.baseUrl || null,
    groupIds: sub2ApiMonitorConfig?.groupIds || [],
    intervalMinutes: Math.max(1, Math.round(SUB2API_MONITOR_INTERVAL_MS / 60_000)),
    cooldownMinutes: Math.max(1, Math.round(SUB2API_AUTO_REPAIR_COOLDOWN_MS / 60_000)),
    running: sub2ApiMonitorState.running,
    lastCheckAt: sub2ApiMonitorState.lastCheckAt,
    nextCheckAt: sub2ApiMonitorState.nextCheckAt,
    lastError: sub2ApiMonitorState.lastError,
    lastResult: sub2ApiMonitorState.lastResult,
    reserveThreshold: sub2ApiMonitorConfig?.reserveThreshold || 0,
  };
}

function scheduleSub2ApiMonitor() {
  if (sub2ApiMonitorTimer) {
    clearInterval(sub2ApiMonitorTimer);
    sub2ApiMonitorTimer = null;
  }
  sub2ApiMonitorState.nextCheckAt = null;
  if (!sub2ApiMonitorConfig?.enabled || shuttingDown) return;
  const interval = Number.isFinite(SUB2API_MONITOR_INTERVAL_MS) && SUB2API_MONITOR_INTERVAL_MS >= 1_000
    ? SUB2API_MONITOR_INTERVAL_MS
    : 5 * 60_000;
  sub2ApiMonitorState.nextCheckAt = new Date(Date.now() + interval).toISOString();
  sub2ApiMonitorTimer = setInterval(() => {
    sub2ApiMonitorState.nextCheckAt = new Date(Date.now() + interval).toISOString();
    void runSub2ApiMonitor("scheduled").catch((error) => {
      console.warn(`[warn] Sub2API 号池巡检失败：${String(error?.message || error).slice(0, 180)}`);
    });
  }, interval);
  sub2ApiMonitorTimer.unref?.();
}

async function runSub2ApiMonitor(trigger = "scheduled") {
  if (!sub2ApiMonitorConfig?.enabled) throw httpError(409, "Sub2API 号池监控未启用");
  if (sub2ApiMonitorPromise) return sub2ApiMonitorPromise;
  const config = { ...sub2ApiMonitorConfig, groupIds: [...sub2ApiMonitorConfig.groupIds] };
  sub2ApiMonitorPromise = (async () => {
    sub2ApiMonitorState.running = true;
    sub2ApiMonitorState.lastError = null;
    const summary = {
      trigger,
      checked: 0,
      matched: 0,
      started: 0,
      updated: 0,
      missingTask: 0,
      ineligible: 0,
      blocked: 0,
      busy: 0,
      cooldown: 0,
      outsideGroups: 0,
      missingEmail: 0,
    };
    try {
      await syncCompletedOutputs(true);
      await retryPendingSub2ApiUploads(config, summary);
      if (shuttingDown) throw httpError(503, "服务正在关闭，已停止号池巡检");
      const remoteAccounts = await listSub2ApiErrorAccounts(config);
      summary.checked = remoteAccounts.length;
      const grouped = new Map();
      for (const account of remoteAccounts) {
        if (!isSub2ApiAccountInMonitoredGroups(account, config.groupIds)) {
          summary.outsideGroups += 1;
          continue;
        }
        const email = sub2ApiAccountEmail(account);
        if (!email) {
          summary.missingEmail += 1;
          continue;
        }
        if (!grouped.has(email)) grouped.set(email, []);
        grouped.get(email).push(account);
      }

      for (const [email, accounts] of grouped) {
        await withEmailJobLock(email, async () => {
          const job = findJobByEmail(email);
          if (!job) {
            summary.missingTask += accounts.length;
            return;
          }
          summary.matched += accounts.length;
          if (job.autoRepairBlocked) {
            summary.blocked += accounts.length;
            return;
          }
          if (isActive(job.status) || job.autoRepairOperation) {
            summary.busy += accounts.length;
            return;
          }
          if (isAutoRepairCoolingDown(job)) {
            summary.cooldown += accounts.length;
            return;
          }
          await reloadMissingJobCredentials(job);
          const eligibility = getAutoRepairEligibility(job);
          if (!eligibility.eligible) {
            summary.ineligible += accounts.length;
            return;
          }

          const operation = createSub2ApiAutoRepairOperation(config, accounts);
          await forceReloginJob(job, {}, { autoRepair: operation });
          appendJobLog(job, `[monitor] Sub2API 号池发现 ${accounts.length} 条异常记录，已自动加入重新登录并授权队列。\n`);
          await saveJobMetadata(job);
          summary.started += accounts.length;
        });
      }

      // ===================== 备用号池补号逻辑 =====================
      // 当号池中正常账号（status=active 且 schedulable）少于阈值时，从备用号池补充。
      if (config.reserveThreshold > 0) {
        try {
          const allAccounts = await listAllSub2ApiOpenAiAccounts(config);
          // 正常账号 = 本项目上传的（oauth--- 前缀）且 status=active 且 schedulable
          const normalCount = allAccounts.filter((acc) =>
            /^oauth---/.test(String(acc.name || ""))
            && String(acc.status || "") === "active"
            && acc.schedulable !== false,
          ).length;
          summary.normalAccounts = normalCount;
          summary.reserveThreshold = config.reserveThreshold;
          summary.reserveAvailable = reservePoolHasAvailable();
          summary.reserveAdded = 0;

          if (normalCount < config.reserveThreshold && reservePoolHasAvailable()) {
            let toAdd = config.reserveThreshold - normalCount;
            while (toAdd > 0) {
              const candidate = pickNextReserveAccount();
              if (!candidate) {
                summary.reserveExhausted = true;
                appendJobLogSafe(`[monitor] 备用号池已无可用账号，停止补号（正常账号 ${normalCount}/${config.reserveThreshold}）。`);
                break;
              }
              // 异步触发加入流程（不等待完成，避免阻塞巡检）
              void joinReserveToPool(candidate.email, config, "monitor");
              summary.reserveAdded += 1;
              toAdd -= 1;
            }
          } else if (normalCount < config.reserveThreshold && !reservePoolHasAvailable()) {
            summary.reserveExhausted = true;
            appendJobLogSafe(`[monitor] 正常账号 ${normalCount}/${config.reserveThreshold}，但备用号池已空，仅继续 401 修复。`);
          }
        } catch (error) {
          summary.reserveError = String(error?.message || error).slice(0, 300);
        }
      }

      sub2ApiMonitorState.lastCheckAt = new Date().toISOString();
      sub2ApiMonitorState.lastResult = summary;
      await persistSub2ApiMonitorConfiguration();
      return summary;
    } catch (error) {
      sub2ApiMonitorState.lastCheckAt = new Date().toISOString();
      sub2ApiMonitorState.lastError = String(error?.message || error).slice(0, 500);
      await persistSub2ApiMonitorConfiguration().catch(() => {});
      throw error;
    } finally {
      sub2ApiMonitorState.running = false;
    }
  })().finally(() => {
    sub2ApiMonitorPromise = null;
  });
  return sub2ApiMonitorPromise;
}

function createSub2ApiAutoRepairOperation(config, accounts) {
  const validAccounts = accounts.filter((account) => {
    const id = Number(account?.id);
    return Number.isSafeInteger(id) && id > 0;
  });
  return {
    accountIds: validAccounts.map((account) => Number(account.id)),
    accounts: validAccounts,
    backend: monitorBackendIdentity(config),
    config,
    startedAt: new Date().toISOString(),
  };
}

async function retryPendingSub2ApiUploads(config, summary) {
  const backend = monitorBackendIdentity(config);
  for (const candidate of listUniqueJobs()) {
    await withEmailJobLock(candidate.email, async () => {
      const job = findJobByEmail(candidate.email);
      const pendingIds = [...new Set(job?.autoRepairPendingAccountIds || [])]
        .map(Number)
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      if (
        !job
        || pendingIds.length === 0
        || job.autoRepairPendingBackend !== backend
        || !job.resultSaved
        || job.status !== "completed"
        || job.autoRepairOperation
        || isAutoRepairCoolingDown(job)
      ) return;

      const accounts = [];
      const missingIds = [];
      try {
        for (const accountId of pendingIds) {
          const account = await getSub2ApiAccount(config, accountId);
          if (account) accounts.push(account);
          else missingIds.push(accountId);
        }
      } catch (error) {
        job.autoRepairLastAttemptAt = new Date().toISOString();
        job.autoRepairLastError = String(error?.message || error).slice(0, 500);
        appendJobLog(job, `[monitor] 读取待重传的 Sub2API 账号失败：${job.autoRepairLastError}。\n`);
        touch(job);
        await saveJobMetadata(job);
        return;
      }

      if (missingIds.length) {
        const missing = new Set(missingIds);
        job.autoRepairPendingAccountIds = pendingIds.filter((id) => !missing.has(id));
        appendJobLog(job, `[monitor] ${missingIds.length} 条待重传账号已从 Sub2API 删除，已停止重试。\n`);
      }
      if (!accounts.length) {
        job.autoRepairPendingBackend = null;
        job.autoRepairLastError = null;
        touch(job);
        await saveJobMetadata(job);
        return;
      }

      job.autoRepairOperation = createSub2ApiAutoRepairOperation(config, accounts);
      job.autoRepairLastAttemptAt = new Date().toISOString();
      appendJobLog(job, `[monitor] 正在重传 ${accounts.length} 条上次未完成的 Sub2API 更新，不重复登录。\n`);
      if (await finishSub2ApiAutoRepairSuccess(job)) summary.updated += accounts.length;
    });
  }
}

async function getSub2ApiAccount(config, accountId) {
  try {
    const payload = await requestSub2Api(config, `/api/v1/admin/accounts/${accountId}`);
    const account = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    if (!account || Number(account.id) !== Number(accountId)) {
      throw new Error(`Sub2API 账号 ${accountId} 返回数据不完整`);
    }
    return account;
  } catch (error) {
    if (error?.remoteStatus === 404) return null;
    throw error;
  }
}

async function listSub2ApiErrorAccounts(config) {
  const accounts = [];
  let page = 1;
  let pages = 1;
  do {
    const query = new URLSearchParams({
      page: String(page),
      page_size: "100",
      platform: "openai",
      status: "error",
    });
    const payload = await requestSub2Api(config, `/api/v1/admin/accounts?${query}`);
    const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    accounts.push(...items.filter((account) => account && String(account.platform || "openai") === "openai" && String(account.status || "error") === "error"));
    const reportedPages = Number(data?.pages);
    pages = Number.isSafeInteger(reportedPages) && reportedPages > 0
      ? reportedPages
      : items.length >= 100 ? page + 1 : page;
    page += 1;
  } while (page <= pages && page <= 1_000);
  return accounts;
}

/**
 * 分页拉取 Sub2API 中全部 OpenAI 平台账号（不限状态）。
 * 用于统计每个代理当前绑定的账号数量。
 */
async function listAllSub2ApiOpenAiAccounts(config) {
  const accounts = [];
  let page = 1;
  let pages = 1;
  do {
    const query = new URLSearchParams({ page: String(page), page_size: "100", platform: "openai" });
    const payload = await requestSub2Api(config, `/api/v1/admin/accounts?${query}`);
    const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    accounts.push(...items.filter((account) => account && String(account.platform || "openai") === "openai"));
    const reportedPages = Number(data?.pages);
    pages = Number.isSafeInteger(reportedPages) && reportedPages > 0
      ? reportedPages
      : items.length >= 100 ? page + 1 : page;
    page += 1;
  } while (page <= pages && page <= 1_000);
  return accounts;
}

/**
 * 从 Sub2API 代理池中选择当前绑定账号最少的可用代理。
 * - 只考虑 active 状态的代理。
 * - 统计所有 OpenAI 账号的 proxy_id 分布。
 * - 绑定数最少的代理中随机选一个（并列时随机）。
 * - 没有可用代理时返回 null（调用方应跳过自动选择，不设置 proxy_id）。
 *
 * @param {object} counts - 已统计的 proxyId→账号数 映射（可选，用于批量场景复用）
 * @param {object} activeProxyIds - 已获取的可用代理 id 集合（可选，用于批量场景复用）
 * @returns {Promise<{proxyId: number, bound: number}|null>}
 */
async function selectLeastBoundSub2ApiProxy(config, { counts, activeProxyIds } = {}) {
  if (!activeProxyIds) {
    const proxyPayload = await requestSub2Api(config, "/api/v1/admin/proxies/all");
    const proxies = Array.isArray(proxyPayload) ? proxyPayload : Array.isArray(proxyPayload?.data) ? proxyPayload.data : [];
    activeProxyIds = new Set(
      proxies
        .filter((proxy) => proxy && Number.isInteger(Number(proxy.id)) && String(proxy.status || "active") === "active")
        .map((proxy) => Number(proxy.id)),
    );
  }
  if (!activeProxyIds.size) return null;

  if (!counts) {
    const accounts = await listAllSub2ApiOpenAiAccounts(config);
    counts = new Map();
    for (const account of accounts) {
      const proxyId = Number(account?.proxy_id);
      if (Number.isSafeInteger(proxyId) && proxyId > 0) {
        counts.set(proxyId, (counts.get(proxyId) || 0) + 1);
      }
    }
  }

  let minBound = Infinity;
  const candidates = [];
  for (const proxyId of activeProxyIds) {
    const bound = counts.get(proxyId) || 0;
    if (bound < minBound) {
      minBound = bound;
      candidates.length = 0;
      candidates.push(proxyId);
    } else if (bound === minBound) {
      candidates.push(proxyId);
    }
  }
  if (!candidates.length) return null;
  const proxyId = candidates[Math.floor(Math.random() * candidates.length)];
  return { proxyId, bound: minBound };
}

function sub2ApiAccountEmail(account) {
  const direct = [account?.credentials?.email, account?.extra?.email]
    .map((value) => String(value || "").trim().toLowerCase())
    .find(isEmail);
  if (direct) return direct;
  const match = String(account?.name || "").toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match && isEmail(match[0]) ? match[0] : null;
}

/**
 * Credit 余额 → 整数美元后缀字符串。
 * credits balance / 25 得到美元，四舍五入取整，形如 "---4"。
 * balance 不是有效数字时返回空串（表示不加后缀）。
 */
function formatCreditBalanceSuffix(balance) {
  if (balance === null || balance === undefined) return "";
  const usd = Math.round(Number(balance) / 25);
  return Number.isFinite(usd) ? `---${usd}` : "";
}

/**
 * 判断 account.name 是否已带余额后缀（以 ---数字 结尾），避免重复追加。
 */
function hasBalanceSuffixInName(name) {
  return /---\d+$/.test(String(name || ""));
}

/**
 * 为首次导入的 account 追加初始余额后缀。
 * 只有名字尚未带后缀时才处理：若余额还没查过则实时查一次，再按整数美元追加。
 * 任何异常（余额查询失败等）都不阻断主流程，此时保持原名不加后缀。
 */
async function appendInitialBalanceSuffix(account, job) {
  if (!account || hasBalanceSuffixInName(account.name)) return;
  if (!job) return;
  try {
    if (job.creditBalance === null && !job.creditError) {
      await refreshJobCreditBalance(job);
    }
    const suffix = formatCreditBalanceSuffix(job.creditBalance);
    if (suffix) account.name = `${account.name}${suffix}`;
  } catch {
    // 余额查询失败时保持原名，不阻断上传
  }
}

function isSub2ApiAccountInMonitoredGroups(account, groupIds) {
  if (!groupIds.length) return true;
  const accountGroupIds = [
    ...(Array.isArray(account?.group_ids) ? account.group_ids : []),
    ...(Array.isArray(account?.account_groups) ? account.account_groups.map((item) => item?.group_id) : []),
  ].map(Number).filter(Number.isSafeInteger);
  return groupIds.some((id) => accountGroupIds.includes(Number(id)));
}

function monitorBackendIdentity(config) {
  return crypto.createHash("sha256").update(String(config?.baseUrl || "")).digest("hex").slice(0, 24);
}

function isAutoRepairCoolingDown(job) {
  if (!job.autoRepairLastAttemptAt || !Number.isFinite(SUB2API_AUTO_REPAIR_COOLDOWN_MS) || SUB2API_AUTO_REPAIR_COOLDOWN_MS <= 0) return false;
  return Date.now() - new Date(job.autoRepairLastAttemptAt).getTime() < SUB2API_AUTO_REPAIR_COOLDOWN_MS;
}

function getAutoRepairEligibility(job) {
  if (job.autoRepairBlocked) return { eligible: false, reason: "账号已确认封禁、删除或永久停用" };
  if (!job.lastAuthAutomated) return { eligible: false, reason: job.lastAuthAutomationReason || "上次授权不是全自动完成" };
  const requirements = job.lastAuthRequirements || {};
  if (requirements.password && !job.password) return { eligible: false, reason: "已保存的密码无法读取" };
  if (requirements.emailOtp && job.mailSource === "none") return { eligible: false, reason: "缺少可自动收取邮箱验证码的 API" };
  if (requirements.mfa && !job.totpSecret) return { eligible: false, reason: "已保存的 2FA 密钥无法读取" };
  if (!job.password && job.mailSource === "none") return { eligible: false, reason: "缺少可自动登录的密码或邮件收码 API" };
  if (job.hasTotpCredential && !job.totpSecret) return { eligible: false, reason: "2FA 密钥在当前系统上无法恢复" };
  return { eligible: true, reason: "上次完整登录全自动完成，所需资料仍可用" };
}

function finishSub2ApiAutoRepairSuccess(job) {
  const operationPromise = performSub2ApiAutoRepairSuccess(job);
  sub2ApiAutoRepairPromises.add(operationPromise);
  void operationPromise.then(
    () => sub2ApiAutoRepairPromises.delete(operationPromise),
    () => sub2ApiAutoRepairPromises.delete(operationPromise),
  );
  return operationPromise;
}

async function performSub2ApiAutoRepairSuccess(job) {
  const operation = job.autoRepairOperation;
  if (!operation) return false;
  job.autoRepairPendingAccountIds = [...new Set(operation.accountIds)];
  job.autoRepairPendingBackend = operation.backend;
  try {
    const payload = await buildSub2ApiUploadPayload([job]);
    const localAccount = payload.accounts.find((account) => sub2ApiAccountEmail(account) === job.email.toLowerCase())
      || payload.accounts[0];
    if (!localAccount?.credentials) throw new Error("新授权文件中没有可更新的账号凭据");

    const pendingIds = new Set(job.autoRepairPendingAccountIds);
    for (const remoteAccount of operation.accounts) {
      const accountId = Number(remoteAccount.id);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
      const credentials = {
        ...(remoteAccount.credentials && typeof remoteAccount.credentials === "object" ? remoteAccount.credentials : {}),
        ...localAccount.credentials,
      };
      await requestSub2Api(operation.config, `/api/v1/admin/accounts/${accountId}`, {
        method: "PUT",
        body: JSON.stringify({ credentials }),
      });
      await requestSub2Api(operation.config, `/api/v1/admin/accounts/${accountId}/clear-error`, {
        method: "POST",
        body: "{}",
      });
      await requestSub2Api(operation.config, `/api/v1/admin/accounts/${accountId}/schedulable`, {
        method: "POST",
        body: JSON.stringify({ schedulable: true }),
      });
      pendingIds.delete(accountId);
      job.autoRepairPendingAccountIds = [...pendingIds];
    }

    job.autoRepairLastSuccessAt = new Date().toISOString();
    job.autoRepairLastError = null;
    job.autoRepairPendingAccountIds = [];
    job.autoRepairPendingBackend = null;
    job.autoRepairOperation = null;
    clearAutoRepairBlock(job);
    appendJobLog(job, `[monitor] 已用新授权覆盖更新 Sub2API 中的 ${operation.accountIds.length} 条账号记录。\n`);
    touch(job);
    await saveJobMetadata(job);
    return true;
  } catch (error) {
    job.autoRepairLastAttemptAt = new Date().toISOString();
    job.autoRepairLastError = String(error?.message || error).slice(0, 500);
    job.autoRepairOperation = null;
    appendJobLog(job, `[monitor] 新授权已生成，但更新 Sub2API 失败：${job.autoRepairLastError}。下次巡检会优先重传，不会重复登录。\n`);
    touch(job);
    await saveJobMetadata(job);
    return false;
  }
}

async function finishSub2ApiAutoRepairFailure(job) {
  if (!job.autoRepairOperation) return;
  const operation = job.autoRepairOperation;
  job.autoRepairOperation = null;
  job.autoRepairLastAttemptAt = new Date().toISOString();
  job.autoRepairLastError = job.autoRepairBlockedReason || job.lastError || "自动重新登录并授权未完成";
  appendJobLog(job, job.autoRepairBlocked
    ? "[monitor] 自动授权确认账号已永久不可用，已停止后续巡检。\n"
    : `[monitor] 本次自动授权未完成，${Math.max(1, Math.round(SUB2API_AUTO_REPAIR_COOLDOWN_MS / 60_000))} 分钟内不会重复启动。\n`);
  if (!job.autoRepairBlocked) {
    job.autoRepairPendingAccountIds = [];
    job.autoRepairPendingBackend = operation.backend;
  }
  touch(job);
  await saveJobMetadata(job);
}

async function exportSourceAccounts(res, ids) {
  const selected = resolveSelectedJobs(ids);
  const lines = [];
  for (const job of selected) {
    let password = job.password || "";
    let totpSecret = job.totpSecret || "";
    if ((!password && job.hasPasswordCredential) || (!totpSecret && job.hasTotpCredential)) {
      const storedCredentials = await loadStoredLoginCredentials(job.email);
      password ||= storedCredentials.password;
      totpSecret ||= storedCredentials.totpSecret;
    }
    if ((job.loginMode === "password" || job.hasPasswordCredential) && !password) {
      throw httpError(409, `${job.email} 的密码未能从系统安全凭据存储读取，请重新导入该账号资料`);
    }
    if (job.hasTotpCredential && !totpSecret) {
      throw httpError(409, `${job.email} 的 2FA 密钥未能从系统安全凭据存储读取，请重新导入该账号资料`);
    }
    if (job.mailSource === "outlook") {
      let { outlookClientId, outlookRefreshToken, outlookPassword } = job;
      if ((!outlookClientId || !outlookRefreshToken || !outlookPassword)) {
        const stored = await loadStoredLoginCredentials(job.email);
        outlookClientId ||= stored.outlookClientId;
        outlookRefreshToken ||= stored.outlookRefreshToken;
        outlookPassword ||= stored.outlookPassword;
      }
      if (!outlookRefreshToken) {
        throw httpError(409, `${job.email} 的 Outlook 刷新令牌未能从系统安全凭据存储读取，请重新导入该账号资料`);
      }
      lines.push(`${job.email}----${outlookPassword || ""}----${outlookClientId || ""}----${outlookRefreshToken}`);
      continue;
    }
    if (password) {
      const parts = [job.email, password];
      if (job.mailApiUrl) parts.push(job.mailApiUrl);
      if (totpSecret) parts.push(totpSecret);
      lines.push(parts.join("----"));
      continue;
    }
    if (job.mailApiUrl) {
      lines.push(totpSecret
        ? `${job.email}----${job.mailApiUrl}----${totpSecret}`
        : `${job.email}----${job.mailApiUrl}`);
      continue;
    }
    if (job.loginMode === "manual") {
      throw httpError(409, `${job.email} 是旧版本任务，原始登录资料未保存，请重新导入该账号资料后再导出`);
    }
    lines.push(totpSecret ? `${job.email}--------${totpSecret}` : job.email);
  }
  const payload = Buffer.from(`\uFEFF${lines.join("\n")}\n`, "utf8");
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="chatgpt-account-source-${lines.length}-accounts-${downloadTimestamp()}.txt"`,
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function publicJob(job) {
  const autoRepair = getAutoRepairEligibility(job);
  return {
    id: job.id,
    email: job.email,
    status: job.status,
    prompt: job.status === "queued"
      ? `排队中，前方还有 ${Math.max(0, getQueuePosition(job) - 1)} 条任务`
      : job.prompt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    lastError: job.lastError,
    canDownload: Boolean(job.resultSaved),
    creditBalance: job.creditBalance ?? null,
    creditError: job.creditError || null,
    loginMode: job.loginMode || (job.mailSource === "none" ? "manual" : "email_otp"),
    hasTotpKey: Boolean(job.totpSecret || job.hasTotpCredential),
    autoEmailOtp: job.mailSource !== "none",
    mailSource: job.mailSource || "none",
    hasOutlookCredential: Boolean(job.outlookRefreshToken),
    mailStatus: job.mailStatus,
    mailApiError: job.mailApiError,
    currentPhone: job.currentPhone,
    phoneError: job.phoneError,
    totpSetupSecret: job.status === "totp_setup_otp" ? job.totpSetupSecret : null,
    totpSetupUri: job.status === "totp_setup_otp" ? job.totpSetupUri : null,
    totpSetupError: job.totpSetupError || null,
    smsProviderId: job.smsProviderId,
    smsProviderName: job.smsProviderName,
    smsServiceLabel: job.smsServiceLabel,
    smsStatus: job.smsStatus,
    smsError: job.smsError,
    securityCheckRequired: Boolean(job.securityCheckRequired),
    canRetry: ["failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    canResume: job.status === "resume_available",
    canRegenerate: job.status === "completed" && job.resultSaved,
    canForceRelogin: canForceRelogin(job),
    canSetupTotp: canSetupTotp(job),
    restartRequired: job.restartRequired,
    proxyConfigured: Boolean(job.proxyUrl),
    autoRepairEligible: autoRepair.eligible,
    autoRepairEligibilityReason: autoRepair.reason,
    autoRepairBlocked: Boolean(job.autoRepairBlocked),
    autoRepairBlockedReason: job.autoRepairBlockedReason || null,
    autoRepairLastAttemptAt: job.autoRepairLastAttemptAt || null,
    autoRepairLastSuccessAt: job.autoRepairLastSuccessAt || null,
    autoRepairLastError: job.autoRepairLastError || null,
    attempt: job.attempt,
    queuePosition: job.status === "queued" ? getQueuePosition(job) : 0,
  };
}

function publicSelectionJob(job) {
  return {
    id: job.id,
    email: job.email,
    status: job.status,
    canDownload: Boolean(job.resultSaved),
    canRetry: ["failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    canRegenerate: job.status === "completed" && job.resultSaved,
    canForceRelogin: canForceRelogin(job),
    canSetupTotp: canSetupTotp(job),
  };
}

function canForceRelogin(job) {
  return ["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(job.status);
}

function canSetupTotp(job) {
  return job.status === "completed"
    && job.resultSaved
    && !job.totpSecret
    && !job.hasTotpCredential
    && !job.totpKnownEnabled;
}

function setStage(job, status, prompt) {
  if (isTerminalStatus(job.status)) return;
  job.status = status;
  job.prompt = prompt;
  job.lastError = null;
  touch(job);
}

function failJob(job, message) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "流程失败";
  job.lastError = message;
  if (isPermanentAccountFailure(message)) markAutoRepairBlocked(job, message);
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function beginAuthorizationAutomationAttempt(job, source) {
  job.authAutomationAttempt = {
    source,
    startedAt: new Date().toISOString(),
    requirements: { password: false, emailOtp: false, mfa: false },
    automatic: { password: false, emailOtp: false, mfa: false },
    manual: { password: false, emailOtp: false, mfa: false },
  };
}

function markAuthorizationRequirement(job, field) {
  if (!job.authAutomationAttempt?.requirements || !Object.hasOwn(job.authAutomationAttempt.requirements, field)) return;
  job.authAutomationAttempt.requirements[field] = true;
}

function markAuthorizationAutomatic(job, field) {
  if (!job.authAutomationAttempt?.automatic || !Object.hasOwn(job.authAutomationAttempt.automatic, field)) return;
  job.authAutomationAttempt.automatic[field] = true;
}

function markAuthorizationManual(job, field) {
  if (!job.authAutomationAttempt?.manual || !Object.hasOwn(job.authAutomationAttempt.manual, field)) return;
  job.authAutomationAttempt.manual[field] = true;
}

function completeAuthorizationAutomationAttempt(job) {
  const attempt = job.authAutomationAttempt;
  if (!attempt) return;
  const reasons = [];
  for (const [field, label] of [["password", "密码"], ["emailOtp", "邮箱验证码"], ["mfa", "登录 2FA 验证码"]]) {
    if (attempt.manual[field]) reasons.push(`${label}由用户手动输入`);
    else if (attempt.requirements[field] && !attempt.automatic[field]) reasons.push(`${label}未记录为自动完成`);
  }
  const hasAutomaticLoginSource = attempt.requirements.password
    || attempt.requirements.emailOtp
    || Boolean(job.password || job.mailSource !== "none");
  if (!hasAutomaticLoginSource) reasons.push("没有可用于下次自动登录的密码或邮件收码接口");

  job.lastAuthAutomated = reasons.length === 0;
  job.lastAuthAutomationReason = reasons.length ? reasons.join("；") : "上次完整登录未需要人工输入密码、邮箱码或登录 2FA";
  job.lastAuthAutomatedAt = new Date().toISOString();
  job.lastAuthRequirements = { ...attempt.requirements };
  job.authAutomationAttempt = null;
  appendJobLog(job, job.lastAuthAutomated
    ? "[automation] 本次完整登录已记录为可自动修复。\n"
    : `[automation] 本次完整登录不可自动修复：${job.lastAuthAutomationReason}。\n`);
}

function clearAutoRepairBlock(job) {
  job.autoRepairBlocked = false;
  job.autoRepairBlockedReason = null;
  job.autoRepairBlockedAt = null;
}

function markAutoRepairBlocked(job, reason) {
  job.autoRepairBlocked = true;
  job.autoRepairBlockedReason = String(reason || "账号已被永久停用").slice(0, 500);
  job.autoRepairBlockedAt = new Date().toISOString();
  job.autoRepairLastError = job.autoRepairBlockedReason;
  job.autoRepairPendingAccountIds = [];
  job.autoRepairPendingBackend = null;
  job.autoRepairOperation = null;
  appendJobLog(job, "[monitor] 已确认账号被封禁、删除或永久停用，后续号池巡检将直接跳过。\n");
}

function isPermanentAccountFailure(message) {
  const text = String(message || "");
  return /(?:account|user)_(?:deactivated|deleted|suspended|disabled)|(?:your|this) account (?:has been|is) (?:deleted|deactivated|suspended|disabled)|account has been (?:deleted|deactivated|suspended|disabled)|deleted or deactivated|do not have an account because it has been deleted/i.test(text);
}

function requireStage(job, expected) {
  if (job.status !== expected) {
    throw httpError(409, `The flow is currently at ${job.status}, not ${expected}`);
  }
}

function touch(job) {
  job.updatedAt = new Date().toISOString();
}

function sanitizeLog(text) {
  return String(text)
    .replace(/([?&](?:code|token|state|csrf|nonce|otp|login_hint|code_challenge)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(access_token|refresh_token|id_token|password|totp_secret|2fa_key)\s*[=:]\s*[^\s,}]+/gi, "$1=<redacted>");
}

function isActive(status) {
  return !isTerminalStatus(status);
}

function occupiesActiveSlot(job) {
  return isActive(job.status) && job.status !== "queued";
}

function getQueuePosition(job) {
  if (job.status !== "queued") return 0;
  return [...jobs.values()]
    .filter((item) => item.status === "queued")
    .sort((a, b) => String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt)))
    .findIndex((item) => item.id === job.id) + 1;
}

function isTerminalStatus(status) {
  return ["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(status);
}

function uniqueByJson(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listUniqueJobs() {
  const seen = new Set();
  return [...jobs.values()].sort(sortNewestFirst).filter((job) => {
    const key = job.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findJobByEmail(email) {
  const key = String(email || "").toLowerCase();
  return listUniqueJobs().find((job) => job.email.toLowerCase() === key) || null;
}

async function withEmailJobLock(email, operation) {
  const key = String(email || "").trim().toLowerCase();
  const previous = emailJobLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  emailJobLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (emailJobLocks.get(key) === current) emailJobLocks.delete(key);
  }
}

function resolveSelectedJobs(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw httpError(400, "请至少选择一条任务");
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  if (uniqueIds.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多操作 ${MAX_BATCH_JOBS} 条任务`);
  const selected = uniqueIds.map((id) => jobs.get(id));
  if (selected.some((job) => !job)) throw httpError(404, "部分任务不存在，请刷新页面后重试");
  return selected;
}

async function deleteJobsByEmail(email) {
  const matching = [...jobs.values()].filter((job) => job.email.toLowerCase() === email);
  const directories = new Set();
  matching.forEach((job) => {
    job.deleted = true;
    stopMailPolling(job);
    releaseSmsNumber(job, "idle");
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    directories.add(path.dirname(job.outputPath));
    jobs.delete(job.id);
  });
  await Promise.allSettled(matching.map((job) => job.metadataWritePromise).filter(Boolean));
  await Promise.all([
    ...[...directories].map((directory) => fs.rm(directory, { recursive: true, force: true })),
    deleteStoredLoginCredentials(email),
  ]);
  scheduleQueuedJobs();
}

function downloadTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function syncCompletedOutputs(force = false) {
  if (!force && Date.now() - lastOutputSyncAt < 2_000) return;
  if (outputSyncPromise) return outputSyncPromise;
  outputSyncPromise = (async () => {
    lastOutputSyncAt = Date.now();
    let entries = [];
    try {
      entries = await fs.readdir(OUTPUT_ROOT, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      if (jobs.has(entry.name)) return;
      const outputDir = path.join(OUTPUT_ROOT, entry.name);
      const outputPath = path.join(outputDir, "sub2api-import-oauth.json");
      const checkpointPath = path.join(outputDir, LOGIN_CHECKPOINT_FILENAME);
      const totpResultPath = path.join(outputDir, TOTP_SETUP_RESULT_FILENAME);
      let metadata = {};
      try {
        metadata = JSON.parse(await fs.readFile(path.join(outputDir, JOB_META_FILENAME), "utf8"));
      } catch {}

      try {
        const [raw, stat] = await Promise.all([fs.readFile(outputPath, "utf8"), fs.stat(outputPath)]);
        const data = JSON.parse(raw);
        if (data.type !== "sub2api-data" || !Array.isArray(data.accounts) || !data.accounts.length) throw new Error("invalid output");
        const account = data.accounts[0];
        const email = metadata.email || account?.credentials?.email || account?.extra?.email || account?.name || `restored-${entry.name}`;
        const mailState = resolveRestoredMailState(metadata, await loadStoredLoginCredentials(email));
        const mailApiUrl = mailState.mailApiUrl;
        let storedCredentials = await loadStoredLoginCredentials(email);
        const completedAt = stat.mtime.toISOString();
        const updatedAt = metadata.updated_at || completedAt;
        const totpRecovery = await recoverActivatedTotpCredential({
          email,
          resultPath: totpResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = totpRecovery.credentials;
        const restoredOperation = restoredOutputOperationState(metadata, completedAt, totpRecovery);
        jobs.set(entry.name, {
          id: entry.name,
          email,
          status: restoredOperation.status,
          prompt: restoredOperation.prompt,
          createdAt: metadata.created_at || completedAt,
          updatedAt,
          completedAt: metadata.completed_at || completedAt,
          outputPath,
          checkpointPath,
          totpResultPath,
          logs: restoredOperation.log,
          lastError: restoredOperation.lastError,
          child: null,
          parserTail: "",
          resultSaved: true,
          creditBalance: null,
          creditError: null,
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailState.mailSource !== "none" ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailSource: mailState.mailSource,
          mailBaselineTime: mailState.mailBaselineTime,
          outlookClientId: mailState.outlookClientId,
          outlookRefreshToken: mailState.outlookRefreshToken,
          outlookPassword: mailState.outlookPassword,
          proxyUrl: storedCredentials.proxyUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailState.mailSource !== "none" ? "ready" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: metadata.sms_number || metadata.luban_number || null,
          phoneError: null,
          restartRequired: false,
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          runId: null,
          runMode: null,
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          ...restoredAutoRepairState(metadata),
          totpSetupError: restoredOperation.totpSetupError,
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...newSmsState(),
        });
        return;
      } catch {}

      try {
        const [raw, stat] = await Promise.all([fs.readFile(checkpointPath, "utf8"), fs.stat(checkpointPath)]);
        const checkpoint = JSON.parse(raw);
        if (checkpoint?.version !== 1 || typeof checkpoint.email !== "string" || !checkpoint.email) return;
        const email = metadata.email || checkpoint.email;
        const storedCredentials = await loadStoredLoginCredentials(email);
        const mailState = resolveRestoredMailState(metadata, storedCredentials);
        const mailApiUrl = mailState.mailApiUrl;
        const restoredAt = stat.mtime.toISOString();
        const savedStatus = String(metadata.status || "");
        const restoredStatus = isTerminalStatus(savedStatus) ? savedStatus : "resume_available";
        jobs.set(entry.name, {
          id: entry.name,
          email,
          status: restoredStatus,
          prompt: metadata.prompt || (restoredStatus === "resume_available"
            ? "检测到邮箱登录检查点，可以继续手机号绑定"
            : "已恢复上次操作状态，登录检查点仍然保留"),
          createdAt: metadata.created_at || restoredAt,
          updatedAt: metadata.updated_at || restoredAt,
          completedAt: null,
          outputPath,
          checkpointPath,
          totpResultPath,
          logs: `[restore] 已恢复 ${checkpoint.stage || "unknown"} 阶段的登录检查点。\n`,
          lastError: metadata.last_error || (restoredStatus === "resume_available"
            ? "上次流程在生成授权文件前中断"
            : null),
          child: null,
          parserTail: "",
          resultSaved: false,
          creditBalance: null,
          creditError: null,
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailState.mailSource !== "none" ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailSource: mailState.mailSource,
          mailBaselineTime: mailState.mailBaselineTime,
          outlookClientId: mailState.outlookClientId,
          outlookRefreshToken: mailState.outlookRefreshToken,
          outlookPassword: mailState.outlookPassword,
          proxyUrl: storedCredentials.proxyUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailState.mailSource !== "none" ? "ready" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: checkpoint.oauth?.phone || metadata.sms_number || metadata.luban_number || null,
          phoneError: null,
          restartRequired: false,
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          runId: null,
          runMode: null,
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          ...restoredAutoRepairState(metadata),
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...restoredSmsState(metadata),
        });
      } catch {
        if (
          !metadata.email
          || !isEmail(metadata.email)
        ) return;
        const storedCredentials = await loadStoredLoginCredentials(metadata.email);
        const mailState = resolveRestoredMailState(metadata, storedCredentials);
        const mailApiUrl = mailState.mailApiUrl;
        const restoredAt = metadata.updated_at || new Date().toISOString();
        const missingStoredCredentials = restoredMissingCredentials(metadata, storedCredentials);
        const storedCredentialsMissing = missingStoredCredentials.length > 0;
        const savedStatus = String(metadata.status || "");
        const restartable = ["queued", "starting"].includes(savedStatus);
        const interrupted = Boolean(savedStatus) && !isTerminalStatus(savedStatus) && !restartable;
        const restoredStatus = storedCredentialsMissing && restartable
          ? "reauth_required"
          : restartable
            ? "queued"
            : interrupted || !savedStatus
              ? "failed"
              : savedStatus;
        const restoredPrompt = storedCredentialsMissing && restartable
          ? "登录资料需要重新确认"
          : restartable
            ? "服务重启后已恢复，等待任务槽位"
            : interrupted || !savedStatus
              ? "上次流程因服务重启中断，可以重新授权"
              : metadata.prompt || "已恢复上次任务状态";
        const restoredError = storedCredentialsMissing && restartable
          ? `请重新导入或填写${missingStoredCredentials.join("、")}后重试，任务不会使用缺失的资料自动登录`
          : interrupted || !savedStatus
            ? metadata.last_error || `上次 ${savedStatus || "未知"} 阶段未完成`
            : metadata.last_error || null;
        jobs.set(entry.name, {
          id: entry.name,
          email: metadata.email,
          status: restoredStatus,
          prompt: restoredPrompt,
          createdAt: metadata.created_at || restoredAt,
          updatedAt: restoredAt,
          completedAt: metadata.completed_at || null,
          outputPath,
          checkpointPath,
          totpResultPath,
          logs: storedCredentialsMissing && restartable
            ? `[restore] 系统安全凭据存储中无法恢复${missingStoredCredentials.join("、")}，已停止自动启动。\n`
            : restartable
              ? "[restore] 已恢复排队任务，等待可用任务槽位。\n"
              : interrupted || !savedStatus
                ? "[restore] 上次任务在生成授权文件前中断，已恢复为可重试状态。\n"
                : "[restore] 已恢复上次任务状态。\n",
          lastError: restoredError,
          child: null,
          parserTail: "",
          resultSaved: false,
          creditBalance: null,
          creditError: null,
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailState.mailSource !== "none" ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailSource: mailState.mailSource,
          mailBaselineTime: mailState.mailBaselineTime,
          outlookClientId: mailState.outlookClientId,
          outlookRefreshToken: mailState.outlookRefreshToken,
          outlookPassword: mailState.outlookPassword,
          proxyUrl: storedCredentials.proxyUrl,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailState.mailSource !== "none" ? "baseline" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: metadata.sms_number || null,
          phoneError: null,
          restartRequired: restoredStatus === "reauth_required",
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          runId: null,
          runMode: null,
          queuedMode: restoredStatus === "queued" && metadata.queued_mode === "refresh" ? "refresh" : "full",
          queuedAt: restoredStatus === "queued" ? metadata.queued_at || restoredAt : null,
          queuedStartPrompt: metadata.queued_mode === "refresh"
            ? "正在使用已有刷新令牌直接生成新授权"
            : "正在建立登录会话",
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          ...restoredAutoRepairState(metadata),
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...newSmsState(),
        });
      }
    }));
  })().finally(() => {
    outputSyncPromise = null;
  });
  return outputSyncPromise;
}

async function recoverActivatedTotpCredential({ email, resultPath, credentials }) {
  let result;
  try {
    result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { credentials, recovered: false, error: null };
    return { credentials, recovered: false, error: `2FA 结果文件无法读取：${error.message}` };
  }
  if (result?.activation_succeeded !== true || !result?.secret) {
    return { credentials, recovered: false, error: null };
  }
  try {
    const secret = normalizeTotpSecret(result.secret);
    const nextCredentials = { ...credentials, totpSecret: secret };
    const persisted = await saveStoredLoginCredentials(email, nextCredentials);
    if (!persisted) {
      return {
        credentials: nextCredentials,
        recovered: false,
        error: "2FA 已激活，但当前系统不支持持久凭据存储；结果文件已保留",
      };
    }
    await removePrivateFile(resultPath);
    return { credentials: nextCredentials, recovered: true, error: null };
  } catch (error) {
    return {
      credentials,
      recovered: false,
      error: `2FA 已激活，但密钥恢复失败：${error.message}；结果文件已保留`,
    };
  }
}

function restoredOutputOperationState(metadata, completedAt, totpRecovery) {
  const savedStatus = String(metadata.status || "");
  const interrupted = savedStatus && !isTerminalStatus(savedStatus);
  const status = !savedStatus || savedStatus === "completed"
    ? "completed"
    : interrupted ? "failed" : savedStatus;
  if (totpRecovery.recovered) {
    return {
      status: "completed",
      prompt: "已恢复上次成功激活的 2FA 密钥，原授权文件仍可下载",
      lastError: null,
      totpSetupError: null,
      log: "[restore] 已从中断的 2FA 设置流程恢复并安全保存密钥。\n",
    };
  }
  if (totpRecovery.error) {
    return {
      status: "completed",
      prompt: "原授权文件仍可下载，2FA 密钥需要重试恢复",
      lastError: metadata.last_error || null,
      totpSetupError: totpRecovery.error,
      log: `[restore] ${totpRecovery.error}\n`,
    };
  }
  if (interrupted) {
    return {
      status,
      prompt: "上次操作因服务重启中断，旧授权文件仍可下载",
      lastError: metadata.last_error || `上次 ${savedStatus} 阶段未完成`,
      totpSetupError: savedStatus.startsWith("totp_") ? "服务重启时 2FA 设置未完成" : null,
      log: "[restore] 检测到旧授权文件，同时保留了上次中断的操作状态。\n",
    };
  }
  return {
    status,
    prompt: metadata.prompt || (status === "completed"
      ? "已从本地输出目录恢复，可以下载导入文件"
      : "旧授权文件仍可下载，已恢复最近一次操作状态"),
    lastError: metadata.last_error || null,
    totpSetupError: savedStatus.startsWith("totp_") ? "服务重启时 2FA 设置未完成" : null,
    log: `[restore] 已恢复任务状态，旧授权文件时间 ${completedAt}。\n`,
  };
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw httpError(400, "账号代理必须是完整的 http://、https://、socks5:// 或 socks5h:// 地址");
  }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) || !parsed.hostname) {
    throw httpError(400, "账号代理只支持 http、https、socks5 和 socks5h 协议");
  }
  return parsed.toString();
}

function normalizeLoginCredentials(value = {}) {
  const password = typeof value.password === "string" ? value.password : "";
  const mailApiUrl = validateMailApiUrl(value.mailApiUrl) ? String(value.mailApiUrl).trim() : null;
  const totpSecret = value.totpSecret ? normalizeTotpSecret(value.totpSecret) : "";
  const outlookClientId = typeof value.outlookClientId === "string" ? value.outlookClientId.trim() : "";
  const outlookRefreshToken =
    typeof value.outlookRefreshToken === "string" ? value.outlookRefreshToken.trim() : "";
  const outlookPassword = typeof value.outlookPassword === "string" ? value.outlookPassword.trim() : "";
  const loginMode = password ? "password" : "email_otp";
  return { loginMode, mailApiUrl, password, totpSecret, outlookClientId, outlookRefreshToken, outlookPassword };
}

/**
 * 恢复任务时根据元数据和已存储凭据，解析邮件源类型与相关字段。
 * 返回的 outlook 字段直接来自凭据存储（加密），mailSource 来自元数据标记。
 */
function resolveRestoredMailState(metadata, storedCredentials) {
  const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
  const mailSource = resolveMailSource({
    mailApiUrl,
    outlookClientId: storedCredentials.outlookClientId,
    outlookRefreshToken: storedCredentials.outlookRefreshToken,
  });
  return {
    mailApiUrl,
    mailSource,
    mailBaselineTime: null,
    outlookClientId: storedCredentials.outlookClientId || "",
    outlookRefreshToken: storedCredentials.outlookRefreshToken || "",
    outlookPassword: storedCredentials.outlookPassword || "",
  };
}

function resolveMailSource({ mailApiUrl, outlookClientId, outlookRefreshToken } = {}) {
  if (mailApiUrl) return "api";
  if (outlookClientId && outlookRefreshToken) return "outlook";
  return "none";
}

function restoredCredentialFlags(metadata = {}, credentials = {}) {
  const hasExplicitPasswordFlag = Object.hasOwn(metadata, "has_password");
  const hasExplicitTotpFlag = Object.hasOwn(metadata, "has_totp_key");
  return {
    hasPasswordCredential: Boolean(
      credentials.password
      || (hasExplicitPasswordFlag ? metadata.has_password : metadata.login_mode === "password" && metadata.has_stored_credentials),
    ),
    hasTotpCredential: Boolean(
      credentials.totpSecret
      || (hasExplicitTotpFlag ? metadata.has_totp_key : metadata.has_stored_credentials),
    ),
  };
}

function restoredTotpSetupState(metadata = {}, credentials = {}) {
  return {
    totpSetupSecret: null,
    totpSetupUri: null,
    totpSetupError: null,
    totpKnownEnabled: Boolean(metadata.totp_known_enabled || credentials.totpSecret),
    totpSetupAttempt: 0,
    totpResultLoading: false,
  };
}

function restoredProxyRiskState(metadata = {}) {
  const count = Number(metadata.proxy_risk_retry_count || 0);
  const connectionFailures = Number(metadata.proxy_connection_failure_count || 0);
  return {
    proxyRiskRetryCount: Number.isInteger(count) && count >= 0 ? Math.min(count, MAX_PROXY_RISK_RETRIES) : 0,
    proxyConnectionFailureCount: Number.isInteger(connectionFailures) && connectionFailures >= 0
      ? Math.min(connectionFailures, MAX_PROXY_CONNECTION_FAILURES)
      : 0,
    proxyRiskRestarting: false,
    proxySessionAttemptIds: new Set(),
    proxyAttemptParserTail: "",
  };
}

function restoredAutoRepairState(metadata = {}) {
  const requirements = metadata.last_auth_requirements;
  const pendingIds = Array.isArray(metadata.auto_repair_pending_account_ids)
    ? metadata.auto_repair_pending_account_ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];
  return {
    lastAuthAutomated: metadata.last_auth_automated === true,
    lastAuthAutomationReason: String(metadata.last_auth_automation_reason || "旧任务没有自动化参与记录"),
    lastAuthAutomatedAt: metadata.last_auth_automated_at || null,
    lastAuthRequirements: requirements && typeof requirements === "object"
      ? {
          password: Boolean(requirements.password),
          emailOtp: Boolean(requirements.emailOtp),
          mfa: Boolean(requirements.mfa),
        }
      : null,
    authAutomationAttempt: null,
    autoRepairBlocked: metadata.auto_repair_blocked === true,
    autoRepairBlockedReason: metadata.auto_repair_blocked_reason || null,
    autoRepairBlockedAt: metadata.auto_repair_blocked_at || null,
    autoRepairLastAttemptAt: metadata.auto_repair_last_attempt_at || null,
    autoRepairLastSuccessAt: metadata.auto_repair_last_success_at || null,
    autoRepairLastError: metadata.auto_repair_last_error || null,
    autoRepairPendingAccountIds: [...new Set(pendingIds)],
    autoRepairPendingBackend: metadata.auto_repair_pending_backend || null,
    autoRepairOperation: null,
  };
}

function restoredMissingCredentials(metadata = {}, credentials = {}) {
  const missing = [];
  const passwordRequired = Object.hasOwn(metadata, "has_password")
    ? metadata.has_password
    : metadata.login_mode === "password" && metadata.has_stored_credentials;
  const totpRequired = Object.hasOwn(metadata, "has_totp_key")
    ? metadata.has_totp_key
    : metadata.has_stored_credentials && !passwordRequired;
  if (passwordRequired && !credentials.password) missing.push("密码");
  if (totpRequired && !credentials.totpSecret) missing.push("2FA 密钥");
  if (metadata.proxy_configured && !credentials.proxyUrl) missing.push("代理 IP");
  return missing;
}

function normalizeTotpSecret(value, lineNumber = null) {
  const normalized = String(value || "").toUpperCase().replace(/[\s=]/g, "");
  if (!/^[A-Z2-7]{16,128}$/.test(normalized)) {
    const prefix = lineNumber ? `第 ${lineNumber} 行` : "";
    throw httpError(400, `${prefix}2FA 密钥格式错误，只能包含 Base32（基础三十二进制）的 A-Z 和 2-7`);
  }
  return normalized;
}

function parseBatchEntries(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw httpError(400, "请至少输入一行账号信息");
  if (lines.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多添加 ${MAX_BATCH_JOBS} 条任务`);

  const entries = lines.map((line, index) => {
    const split = splitAccountLine(line);
    if (!split) {
      if (!isEmail(line)) throw httpError(400, `第 ${index + 1} 行邮箱格式错误`);
      return {
        email: line,
        loginMode: "email_otp",
        mailApiUrl: null,
        password: "",
        totpSecret: "",
        preserveExistingCredentials: true,
      };
    }
    const { email, remainder } = split;
    if (!isEmail(email)) throw httpError(400, `第 ${index + 1} 行邮箱格式错误`);

    const passwordMailSeparator = /----(?=https?:\/\/)/i.exec(remainder);
    if (passwordMailSeparator && passwordMailSeparator.index > 0) {
      const password = remainder.slice(0, passwordMailSeparator.index).trim();
      const mailAndTotp = remainder.slice(passwordMailSeparator.index + 4).trim();
      let mailApiUrl = mailAndTotp;
      let totpSecret = "";
      const totpDelimiterAt = mailAndTotp.lastIndexOf("----");
      if (totpDelimiterAt >= 0) {
        const candidateUrl = mailAndTotp.slice(0, totpDelimiterAt).trim();
        if (validateMailApiUrl(candidateUrl)) {
          mailApiUrl = candidateUrl;
          totpSecret = normalizeTotpSecret(mailAndTotp.slice(totpDelimiterAt + 4), index + 1);
        }
      }
      if (!password) throw httpError(400, `第 ${index + 1} 行密码不能为空`);
      if (!validateMailApiUrl(mailApiUrl)) throw httpError(400, `第 ${index + 1} 行邮件接收 API 格式错误`);
      return { email, loginMode: "password", mailApiUrl, password, totpSecret };
    }

    const lastDelimiterAt = remainder.lastIndexOf("----");
    if (lastDelimiterAt < 0) {
      const loginValue = remainder.trim();
      if (!loginValue) throw httpError(400, `第 ${index + 1} 行密码或收码接口不能为空`);
      if (validateMailApiUrl(loginValue)) {
        return { email, loginMode: "email_otp", mailApiUrl: loginValue, password: "", totpSecret: "" };
      }
      return { email, loginMode: "password", mailApiUrl: null, password: loginValue, totpSecret: "" };
    }

    if (lastDelimiterAt === 0) {
      const totpSecret = normalizeTotpSecret(remainder.slice(4), index + 1);
      return { email, loginMode: "email_otp", mailApiUrl: null, password: "", totpSecret };
    }

    const loginValue = remainder.slice(0, lastDelimiterAt).trim();
    const totpSecret = normalizeTotpSecret(remainder.slice(lastDelimiterAt + 4), index + 1);
    if (!loginValue) throw httpError(400, `第 ${index + 1} 行密码或收码接口不能为空`);
    if (validateMailApiUrl(loginValue)) {
      return { email, loginMode: "email_otp", mailApiUrl: loginValue, password: "", totpSecret };
    }
    return { email, loginMode: "password", mailApiUrl: null, password: loginValue, totpSecret };
  });

  const unique = new Map();
  entries.forEach((entry) => unique.set(entry.email.toLowerCase(), entry));
  return [...unique.values()];
}

function splitAccountLine(line) {
  const separators = line.matchAll(/-{3,4}/g);
  for (const separator of separators) {
    const email = line.slice(0, separator.index).trim();
    if (!isEmail(email)) continue;
    return {
      email,
      remainder: line.slice(separator.index + separator[0].length),
    };
  }
  return null;
}

async function updateJobCredentials(job, credentials, options = {}) {
  if (credentials.preserveExistingCredentials) await reloadMissingJobCredentials(job);
  const normalized = credentials.preserveExistingCredentials
    ? normalizeLoginCredentials({
        password: job.password,
        mailApiUrl: job.mailApiUrl,
        totpSecret: job.totpSecret,
        outlookClientId: job.outlookClientId,
        outlookRefreshToken: job.outlookRefreshToken,
        outlookPassword: job.outlookPassword,
      })
    : normalizeLoginCredentials(credentials);
  const nextProxyUrl = options.hasProxyUpdate ? normalizeProxyUrl(options.proxyUrl) : job.proxyUrl;
  const nextMailSource = resolveMailSource(normalized);
  const changed = job.loginMode !== normalized.loginMode
    || job.mailApiUrl !== normalized.mailApiUrl
    || job.password !== normalized.password
    || job.totpSecret !== normalized.totpSecret
    || job.proxyUrl !== nextProxyUrl
    || job.outlookClientId !== normalized.outlookClientId
    || job.outlookRefreshToken !== normalized.outlookRefreshToken
    || job.outlookPassword !== normalized.outlookPassword
    || job.mailSource !== nextMailSource;
  await saveStoredLoginCredentials(job.email, { ...normalized, proxyUrl: nextProxyUrl });
  if (!changed) return;
  stopMailPolling(job);
  job.loginMode = normalized.loginMode;
  job.mailApiUrl = normalized.mailApiUrl;
  job.password = normalized.password;
  job.totpSecret = normalized.totpSecret;
  job.outlookClientId = normalized.outlookClientId;
  job.outlookRefreshToken = normalized.outlookRefreshToken;
  job.outlookPassword = normalized.outlookPassword;
  job.mailSource = nextMailSource;
  job.mailBaselineTime = null;
  job.hasPasswordCredential = Boolean(normalized.password);
  job.hasTotpCredential = Boolean(normalized.totpSecret);
  job.proxyUrl = nextProxyUrl;
  job.mailSeenCandidateKeys.clear();
  job.mailCandidateCounts.clear();
  job.mailStatus = nextMailSource !== "none" ? "baseline" : "manual";
  job.mailApiError = null;
  appendJobLog(job, "[account] 登录方式与验证资料已按邮箱唯一键更新，敏感字段未写入日志。\n");
  if (isActive(job.status) && job.status !== "queued") {
    restartJobAfterConfigurationUpdate(job);
  } else {
    touch(job);
    await saveJobMetadata(job);
  }
}

async function updateJobProxy(job, proxyUrl) {
  if (job.proxyUrl === proxyUrl) return;
  job.proxyUrl = proxyUrl;
  await saveStoredLoginCredentials(job.email, job);
  appendJobLog(job, "[proxy] 账号代理配置已更新。\n");
  if (isActive(job.status) && job.status !== "queued") {
    restartJobAfterConfigurationUpdate(job);
  } else {
    touch(job);
    await saveJobMetadata(job);
  }
}

function restartJobAfterConfigurationUpdate(job) {
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.attempt += 1;
  beginAuthorizationAutomationAttempt(job, "configuration_update");
  appendJobLog(job, "[account] 已停止使用旧配置的登录进程，并使用新配置重新排队。\n");
  enqueueJob(job, "full", "账号资料已更新，正在重新建立登录会话");
}

async function saveJobMetadata(job) {
  if (job.deleted) return;
  job.metadataWritePromise = (job.metadataWritePromise || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (job.deleted) return;
      const metadataPath = path.join(path.dirname(job.outputPath), JOB_META_FILENAME);
      const data = {
        version: 1,
        email: job.email,
        status: job.status,
        prompt: job.prompt || null,
        last_error: job.lastError || null,
        result_saved: Boolean(job.resultSaved),
        completed_at: job.completedAt || null,
        attempt: Number(job.attempt || 1),
        security_check_required: Boolean(job.securityCheckRequired),
        queued_mode: job.queuedMode || null,
        queued_at: job.queuedAt || null,
        created_at: job.createdAt,
        login_mode: job.loginMode || null,
        has_stored_credentials: Boolean(job.password || job.totpSecret),
        has_password: Boolean(job.password || job.hasPasswordCredential),
        has_totp_key: Boolean(job.totpSecret || job.hasTotpCredential),
        totp_known_enabled: Boolean(job.totpKnownEnabled || job.totpSecret || job.hasTotpCredential),
        proxy_risk_retry_count: Number(job.proxyRiskRetryCount || 0),
        proxy_connection_failure_count: Number(job.proxyConnectionFailureCount || 0),
        proxy_configured: Boolean(job.proxyUrl),
        mail_api_url: job.mailApiUrl || null,
        mail_source: job.mailSource || "none",
        sms_provider_id: job.smsProviderId || null,
        sms_provider_name: job.smsProviderName || null,
        sms_service_label: job.smsServiceLabel || null,
        sms_order_id: job.smsOrderId || null,
        sms_number: job.smsNumber || null,
        sms_status: job.smsStatus || null,
        last_auth_automated: Boolean(job.lastAuthAutomated),
        last_auth_automation_reason: job.lastAuthAutomationReason || null,
        last_auth_automated_at: job.lastAuthAutomatedAt || null,
        last_auth_requirements: job.lastAuthRequirements || null,
        auto_repair_blocked: Boolean(job.autoRepairBlocked),
        auto_repair_blocked_reason: job.autoRepairBlockedReason || null,
        auto_repair_blocked_at: job.autoRepairBlockedAt || null,
        auto_repair_last_attempt_at: job.autoRepairLastAttemptAt || null,
        auto_repair_last_success_at: job.autoRepairLastSuccessAt || null,
        auto_repair_last_error: job.autoRepairLastError || null,
        auto_repair_pending_account_ids: job.autoRepairPendingAccountIds || [],
        auto_repair_pending_backend: job.autoRepairPendingBackend || null,
        updated_at: new Date().toISOString(),
      };
      const tempPath = `${metadataPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tempPath, metadataPath);
    });
  return job.metadataWritePromise;
}

async function saveStoredLoginCredentials(email, credentials = {}) {
  const password = typeof credentials.password === "string" ? credentials.password : "";
  const totpSecret = credentials.totpSecret ? normalizeTotpSecret(credentials.totpSecret) : "";
  const proxyUrl = credentials.proxyUrl ? normalizeProxyUrl(credentials.proxyUrl) : "";
  const outlookClientId = typeof credentials.outlookClientId === "string" ? credentials.outlookClientId : "";
  const outlookRefreshToken =
    typeof credentials.outlookRefreshToken === "string" ? credentials.outlookRefreshToken : "";
  const outlookPassword = typeof credentials.outlookPassword === "string" ? credentials.outlookPassword : "";
  if (!password && !totpSecret && !proxyUrl && !outlookRefreshToken) {
    await deleteStoredLoginCredentials(email);
    return true;
  }
  try {
    await credentialStore.save(email, {
      password,
      totpSecret,
      proxyUrl,
      outlookClientId,
      outlookRefreshToken,
      outlookPassword,
    });
  } catch (error) {
    if (error?.status === 501) return false;
    throw error;
  }
  return true;
}

async function loadStoredLoginCredentials(email) {
  try {
    const data = await credentialStore.load(email);
    return {
      password: typeof data.password === "string" ? data.password : "",
      totpSecret: data.totpSecret ? normalizeTotpSecret(data.totpSecret) : "",
      proxyUrl: data.proxyUrl ? normalizeProxyUrl(data.proxyUrl) : null,
      outlookClientId: typeof data.outlookClientId === "string" ? data.outlookClientId : "",
      outlookRefreshToken: typeof data.outlookRefreshToken === "string" ? data.outlookRefreshToken : "",
      outlookPassword: typeof data.outlookPassword === "string" ? data.outlookPassword : "",
    };
  } catch {
    return {
      password: "",
      totpSecret: "",
      proxyUrl: null,
      outlookClientId: "",
      outlookRefreshToken: "",
      outlookPassword: "",
    };
  }
}

async function deleteStoredLoginCredentials(email) {
  await credentialStore.delete(email);
}

async function loadOutlookFetchConfig() {
  try {
    const raw = await fs.readFile(OUTLOOK_FETCH_CONFIG_PATH, "utf8");
    const data = JSON.parse(raw);
    return { endpoint: normalizeOutlookEndpoint(data.endpoint) };
  } catch {
    return { endpoint: DEFAULT_OUTLOOK_ENDPOINT };
  }
}

async function saveOutlookFetchConfig(endpoint) {
  const normalized = normalizeOutlookEndpoint(endpoint);
  await fs.mkdir(path.dirname(OUTLOOK_FETCH_CONFIG_PATH), { recursive: true });
  const tempPath = `${OUTLOOK_FETCH_CONFIG_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify({ endpoint: normalized }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, OUTLOOK_FETCH_CONFIG_PATH);
  return { endpoint: normalized };
}

// ===========================================================================
// 备用号池（reserve pool）数据层
// ===========================================================================

/** 备用号池中单个账号的非敏感视图（不含 outlookRefreshToken / outlookPassword）。 */
function publicReserveAccount(acc) {
  return {
    email: acc.email,
    balance: acc.hasBalance ? acc.balance : null,
    hasBalance: Boolean(acc.hasBalance),
    banned: Boolean(acc.banned),
    bannedReason: acc.bannedReason || null,
    status: acc.status || "idle",
    jobId: acc.jobId || null,
    importedAt: acc.importedAt || null,
    lastCheckedAt: acc.lastCheckedAt || null,
    fetchError: acc.fetchError || null,
  };
}

async function loadReservePool() {
  try {
    const raw = await fs.readFile(RESERVE_POOL_PATH, "utf8");
    const data = JSON.parse(raw);
    reservePoolAccounts = Array.isArray(data.accounts)
      ? data.accounts.filter((a) => a && typeof a.email === "string").map(normalizeReserveAccount)
      : [];
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[warn] 备用号池配置无法读取：${String(error?.message || error).slice(0, 180)}`);
    }
    reservePoolAccounts = [];
  }
}

function normalizeReserveAccount(acc) {
  return {
    email: acc.email,
    balance: typeof acc.balance === "number" ? acc.balance : null,
    hasBalance: acc.hasBalance === true,
    banned: acc.banned === true,
    bannedReason: acc.bannedReason || null,
    status: ["idle", "checking", "joining", "joined", "skipped_banned", "fetch_failed"].includes(acc.status)
      ? acc.status
      : "idle",
    jobId: acc.jobId || null,
    importedAt: acc.importedAt || null,
    lastCheckedAt: acc.lastCheckedAt || null,
    fetchError: acc.fetchError || null,
  };
}

function persistReservePool() {
  reservePoolWritePromise = reservePoolWritePromise.then(async () => {
    const payload = {
      version: 1,
      accounts: reservePoolAccounts.map((acc) => ({
        email: acc.email,
        balance: acc.balance,
        hasBalance: acc.hasBalance,
        banned: acc.banned,
        bannedReason: acc.bannedReason,
        status: acc.status,
        jobId: acc.jobId,
        importedAt: acc.importedAt,
        lastCheckedAt: acc.lastCheckedAt,
        fetchError: acc.fetchError,
      })),
      updatedAt: new Date().toISOString(),
    };
    await fs.mkdir(path.dirname(RESERVE_POOL_PATH), { recursive: true });
    const tempPath = `${RESERVE_POOL_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, RESERVE_POOL_PATH);
  }).catch((error) => {
    console.warn(`[warn] 备用号池配置写入失败：${String(error?.message || error).slice(0, 180)}`);
  });
  return reservePoolWritePromise;
}

function findReserveAccount(email) {
  const normalized = String(email || "").trim().toLowerCase();
  return reservePoolAccounts.find((acc) => acc.email === normalized) || null;
}

function updateReserveAccount(email, updater) {
  const acc = findReserveAccount(email);
  if (!acc) return null;
  updater(acc);
  void persistReservePool();
  return acc;
}

/** 备用号池凭证在 credential store 中的 key（reserve- 前缀避免和 job 冲突）。 */
function reserveCredentialKey(email) {
  return `reserve-${String(email || "").trim().toLowerCase()}`;
}

async function saveReserveCredentials(entry) {
  try {
    await credentialStore.save(reserveCredentialKey(entry.email), {
      password: "",
      totpSecret: "",
      proxyUrl: "",
      outlookClientId: entry.outlookClientId || "",
      outlookRefreshToken: entry.outlookRefreshToken || "",
      outlookPassword: entry.outlookPassword || "",
    });
    return true;
  } catch (error) {
    if (error?.status === 501) return false;
    throw error;
  }
}

async function loadReserveCredentials(email) {
  try {
    const data = await credentialStore.load(reserveCredentialKey(email));
    return {
      outlookClientId: typeof data.outlookClientId === "string" ? data.outlookClientId : "",
      outlookRefreshToken: typeof data.outlookRefreshToken === "string" ? data.outlookRefreshToken : "",
      outlookPassword: typeof data.outlookPassword === "string" ? data.outlookPassword : "",
    };
  } catch {
    return { outlookClientId: "", outlookRefreshToken: "", outlookPassword: "" };
  }
}

async function deleteReserveCredentials(email) {
  await credentialStore.delete(reserveCredentialKey(email));
}

/**
 * 拉取某个备用号的邮件列表并更新其余额 / 封禁状态。
 * @param {object} acc 备用号池中的账号对象（会被原地更新）
 * @param {string} endpoint Outlook relay 地址
 */
async function refreshReserveAccountStatus(acc, endpoint) {
  const credentials = await loadReserveCredentials(acc.email);
  if (!credentials.outlookClientId || !credentials.outlookRefreshToken) {
    acc.fetchError = "缺少 Outlook 凭证（clientId / refreshToken）";
    acc.status = "fetch_failed";
    void persistReservePool();
    return;
  }
  acc.status = "checking";
  acc.fetchError = null;
  void persistReservePool();
  try {
    const messages = await fetchReserveAccountMessages({
      endpoint,
      email: acc.email,
      clientId: credentials.outlookClientId,
      refreshToken: credentials.outlookRefreshToken,
      password: credentials.outlookPassword,
    });
    const balanceInfo = extractBalanceFromMessages(messages);
    const banInfo = isAccountBannedFromMessages(messages);
    acc.hasBalance = balanceInfo.hasBalance;
    acc.balance = balanceInfo.hasBalance ? balanceInfo.balance : null;
    acc.banned = banInfo.banned;
    acc.bannedReason = banInfo.banned || acc.bannedReason;
    acc.lastCheckedAt = new Date().toISOString();
    acc.fetchError = null;
    if (acc.status === "checking") {
      acc.status = acc.banned ? "skipped_banned" : "idle";
    }
  } catch (error) {
    acc.fetchError = String(error?.message || error).slice(0, 300);
    if (acc.status === "checking") acc.status = "fetch_failed";
  }
  void persistReservePool();
}

/** 挑选下一个可用的备用号（未封禁、idle 状态、有余额优先）。 */
function pickNextReserveAccount() {
  const idle = reservePoolAccounts.filter((acc) => acc.status === "idle" && !acc.banned);
  if (!idle.length) return null;
  // 有余额的优先，其次按导入顺序
  idle.sort((a, b) => {
    if (a.hasBalance && !b.hasBalance) return -1;
    if (!a.hasBalance && b.hasBalance) return 1;
    return 0;
  });
  return idle[0];
}

/** 备用号池是否有可用账号（未封禁且未加入号池）。 */
function reservePoolHasAvailable() {
  return reservePoolAccounts.some((acc) => (acc.status === "idle") && !acc.banned);
}

/**
 * 将备用号池中的一个号加入号池（登录授权 → 上传到 Sub2API）。
 * 流程：① 先拉邮件验证是否封禁 → ② 创建 job 登录授权 → ③ 完成后自动上传
 * @param {string} email
 * @param {object} config Sub2API 配置（含 baseUrl/adminApiKey/groupIds 等）
 * @param {string} trigger "manual" | "monitor"
 */
async function joinReserveToPool(email, config, trigger = "manual") {
  const acc = findReserveAccount(email);
  if (!acc) return;
  if (acc.status === "joined" || acc.status === "joining") return;

  // ① 先拉邮件验证是否封禁
  acc.status = "joining";
  acc.fetchError = null;
  void persistReservePool();
  try {
    const outlookConfig = await loadOutlookFetchConfig();
    const credentials = await loadReserveCredentials(email);
    if (!credentials.outlookClientId || !credentials.outlookRefreshToken) {
      throw new Error("缺少 Outlook 凭证");
    }
    const messages = await fetchReserveAccountMessages({
      endpoint: outlookConfig.endpoint,
      email,
      clientId: credentials.outlookClientId,
      refreshToken: credentials.outlookRefreshToken,
      password: credentials.outlookPassword,
    });
    const banInfo = isAccountBannedFromMessages(messages);
    if (banInfo.banned) {
      acc.banned = true;
      acc.bannedReason = banInfo.reason || "邮件命中封禁关键词";
      acc.status = "skipped_banned";
      void persistReservePool();
      appendJobLogSafe(`[reserve] ${email} 邮件验证发现账号已封禁，已跳过。`);
      return;
    }
    // 更新余额信息
    const balanceInfo = extractBalanceFromMessages(messages);
    acc.hasBalance = balanceInfo.hasBalance;
    acc.balance = balanceInfo.hasBalance ? balanceInfo.balance : null;
    acc.lastCheckedAt = new Date().toISOString();
    void persistReservePool();

    // ② 创建 job 登录授权（使用 outlook 邮箱 OTP 模式）
    const existing = findJobByEmail(email);
    if (existing && (isActive(existing.status) || existing.status === "queued")) {
      acc.status = "idle";
      acc.fetchError = "该邮箱已有正在进行的登录任务";
      void persistReservePool();
      return;
    }

    const jobCredentials = {
      email,
      loginMode: "email_otp",
      mailApiUrl: null,
      password: "",
      totpSecret: "",
      outlookClientId: credentials.outlookClientId,
      outlookRefreshToken: credentials.outlookRefreshToken,
      outlookPassword: credentials.outlookPassword,
    };

    // 如果已有 job（terminal 状态），强制重新登录；否则创建新 job
    let job;
    if (existing) {
      await updateJobCredentials(existing, jobCredentials, { hasProxyUpdate: false });
      job = existing;
    } else {
      job = await startJob(email, jobCredentials, null);
    }

    // 标记此 job 为备用号池补号任务，完成后自动上传
    job.reserveJoinConfig = { ...config, groupIds: [...config.groupIds] };
    job.reserveJoinEmail = email;
    acc.jobId = job.id;
    void persistReservePool();

    // 如果是已有 job 且处于 terminal 状态，触发重新登录
    if (existing && canForceRelogin(job)) {
      await forceReloginJob(job, {}, {});
    }

    appendJobLogSafe(`[reserve] ${email} 已从备用号池开始加入号池（触发：${trigger}）。`);
  } catch (error) {
    acc.status = "idle";
    acc.fetchError = String(error?.message || error).slice(0, 300);
    void persistReservePool();
    appendJobLogSafe(`[reserve] ${email} 加入号池失败：${acc.fetchError}`);
  }
}

/** 安全地输出日志（避免在没有 console 的场景下报错）。 */
function appendJobLogSafe(message) {
  console.log(message);
}

/**
 * 备用号池补号任务完成后的上传处理（在 handleChildClose 中调用）。
 * 如果 job 有 reserveJoinConfig，则自动上传到 Sub2API。
 */
async function finishReserveJoinUpload(job) {
  if (!job.reserveJoinConfig) return false;
  const config = job.reserveJoinConfig;
  const email = job.reserveJoinEmail;
  try {
    if (!job.resultSaved) throw new Error("授权文件未生成");
    await uploadJobsToSub2Api(config, [job]);
    appendJobLogSafe(`[reserve] ${email} 授权完成并已上传到 Sub2API 号池。`);
    // 上传成功后从备用号池移除（与导入时去重逻辑保持一致）
    if (email) {
      const idx = reservePoolAccounts.findIndex((acc) => acc.email === email);
      if (idx >= 0) {
        reservePoolAccounts.splice(idx, 1);
        void deleteReserveCredentials(email);
        void persistReservePool();
      }
    }
    return true;
  } catch (error) {
    const msg = String(error?.message || error).slice(0, 500);
    appendJobLogSafe(`[reserve] ${email} 上传到 Sub2API 失败：${msg}`);
    if (email) {
      updateReserveAccount(email, (acc) => {
        acc.status = "idle";
        acc.fetchError = `上传失败：${msg}`;
      });
    }
    return false;
  } finally {
    job.reserveJoinConfig = null;
    job.reserveJoinEmail = null;
  }
}

/**
 * 统一收码分发：根据 job 的邮件源类型，调用 GET 收码接口或 Outlook fetch-mails 接口。
 * 两者都返回结构一致的 candidate 列表，后续 baseline/轮询逻辑完全复用。
 */
async function fetchJobOtpCandidates(job, { baselineTime = null } = {}) {
  if (job.mailSource === "outlook") {
    const { endpoint } = await loadOutlookFetchConfig();
    return fetchOutlookOtpCandidates(
      {
        endpoint,
        email: job.email,
        clientId: job.outlookClientId,
        refreshToken: job.outlookRefreshToken,
        password: job.outlookPassword,
      },
      { baselineTime },
    );
  }
  return fetchMailboxOtpCandidates(job.mailApiUrl);
}

async function loadMailboxBaseline(job) {
  if (job.mailSource !== "api" && job.mailSource !== "outlook") return;
  // 记录基准时间：登录触发后到达的邮件才视为新验证码。
  // 设置在抓取之前，确保不会把"设置基准时间"瞬间正在投递的旧邮件误判为新码。
  job.mailBaselineTime = Date.now();
  try {
    const candidates = await fetchJobOtpCandidates(job, { baselineTime: null });
    candidates.forEach((candidate) => job.mailSeenCandidateKeys.add(candidate.key));
    job.mailStatus = "ready";
    job.mailApiError = null;
    appendJobLog(job, `[mail] 已记录收码接口中的 ${candidates.length} 个旧邮件验证码标识，等待新邮件。\n`);
  } catch (error) {
    job.mailStatus = "error";
    job.mailApiError = safeMailError(error);
    appendJobLog(job, `[mail] 首次读取收码接口失败：${job.mailApiError}\n`);
  }
  touch(job);
}

async function beginMailPolling(job) {
  if (job.mailSource === "none" || job.mailPollRunning || job.status !== "email_otp") return;
  job.mailPollRunning = true;
  job.mailStatus = "polling";
  job.mailApiError = null;
  const pollToken = crypto.randomUUID();
  const startedAt = Date.now();
  job.mailPollToken = pollToken;
  touch(job);

  try {
    while (
      job.mailPollToken === pollToken &&
      job.status === "email_otp" &&
      job.child &&
      Date.now() - startedAt < MAIL_POLL_TIMEOUT_MS
    ) {
      try {
        const candidates = await fetchJobOtpCandidates(job, { baselineTime: job.mailBaselineTime });
        if (job.mailPollToken !== pollToken || job.status !== "email_otp" || !job.child) return;
        const unseen = candidates.filter((candidate) => !job.mailSeenCandidateKeys.has(candidate.key));
        let fresh = unseen.find((candidate) => candidate.score >= 12);
        if (!fresh) {
          unseen.forEach((candidate) => {
            job.mailCandidateCounts.set(candidate.key, (job.mailCandidateCounts.get(candidate.key) || 0) + 1);
          });
          fresh = unseen.find((candidate) => (job.mailCandidateCounts.get(candidate.key) || 0) >= 2);
        }
        job.mailApiError = null;
        if (fresh) {
          job.mailSeenCandidateKeys.add(fresh.key);
          job.mailCandidateCounts.delete(fresh.key);
          job.mailStatus = "found";
          markAuthorizationRequirement(job, "emailOtp");
          markAuthorizationAutomatic(job, "emailOtp");
          job.parserTail = "";
          appendJobLog(job, "[mail] 已从收码接口自动取得新验证码并提交。\n");
          setStage(job, "working", "已自动获取邮箱验证码，正在验证");
          job.child.stdin.write(`${fresh.code}\n`);
          return;
        }
      } catch (error) {
        if (job.mailPollToken !== pollToken) return;
        job.mailStatus = "error";
        job.mailApiError = safeMailError(error);
        touch(job);
      }
      await delay(MAIL_POLL_INTERVAL_MS);
    }

    if (job.mailPollToken === pollToken && job.status === "email_otp") {
      job.mailStatus = "timeout";
      job.mailApiError = "自动收码等待超时，请手动输入或重新发送";
      job.prompt = "自动收码等待超时，请手动输入邮箱验证码";
      touch(job);
    }
  } finally {
    if (job.mailPollToken === pollToken) {
      job.mailPollRunning = false;
      job.mailPollToken = null;
      touch(job);
    }
  }
}

function stopMailPolling(job) {
  if (job.mailSource === "none") return;
  job.mailPollToken = null;
  job.mailPollRunning = false;
  if (job.mailStatus === "polling") job.mailStatus = "stopped";
}

function appendJobLog(job, text) {
  job.logs = `${job.logs}${sanitizeLog(text)}`.slice(-MAX_LOG_CHARS);
}

function safeMailError(error) {
  const message = String(error?.message || "读取收码接口失败");
  return message.replace(/https?:\/\/\S+/gi, "<已隐藏接口地址>").slice(0, 180);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortNewestFirst(a, b) {
  return b.createdAt.localeCompare(a.createdAt);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw httpError(413, "Request body is too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

function sendJson(res, status, data) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

process.on("SIGINT", () => void shutdown().catch(reportShutdownFailure));
process.on("SIGTERM", () => void shutdown().catch(reportShutdownFailure));

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    shuttingDown = true;
    queueSchedulingPaused = true;
    if (sub2ApiMonitorTimer) {
      clearInterval(sub2ApiMonitorTimer);
      sub2ApiMonitorTimer = null;
    }
    for (const controller of sub2ApiRequestControllers) controller.abort();
    await Promise.allSettled([
      sub2ApiMonitorPromise,
      ...sub2ApiRequestPromises,
      ...sub2ApiAutoRepairPromises,
    ].filter(Boolean));
    const activeJobs = [...jobs.values()].filter((job) => isActive(job.status));
    const childWaits = activeJobs
      .map((job) => job.child)
      .filter(Boolean)
      .map((child) => waitForChildExit(child, 3_000));
    await Promise.allSettled(activeJobs.map((job) => cancelJob(job)));
    await Promise.allSettled([
      ...childWaits,
      ...[...jobs.values()].map((job) => job.metadataWritePromise).filter(Boolean),
    ]);
    await vite.close();
    await closeHttpServer(server);
  })();
  return shutdownPromise;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", finish);
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);
  });
}

function closeHttpServer(httpServer) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      httpServer.closeAllConnections?.();
      resolve();
    }, 3_000);
    httpServer.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function reportShutdownFailure(error) {
  console.error(`[shutdown] ${error.message}`);
  process.exitCode = 1;
}
