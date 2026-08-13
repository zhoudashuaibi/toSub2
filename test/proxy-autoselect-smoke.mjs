import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-proxy-autoselect-"));
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const sub2apiPort = await findAvailablePort();
const sub2apiUrl = `http://127.0.0.1:${sub2apiPort}`;

// 模拟代理池：代理 A(id=1) 已绑定 3 个账号，代理 B(id=2) 已绑定 1 个账号，代理 C(停用)
const PROXIES = [
  { id: 1, name: "代理A", protocol: "http://", host: "a.example", port: 8080, ip_address: "1.1.1.1", status: "active" },
  { id: 2, name: "代理B", protocol: "http://", host: "b.example", port: 8080, ip_address: "2.2.2.2", status: "active" },
  { id: 3, name: "代理C-停用", protocol: "http://", host: "c.example", port: 8080, ip_address: "3.3.3.3", status: "inactive" },
];
// 账号池：代理 A 绑 3 个，代理 B 绑 1 个，代理 C 绑 0 个（但停用，不应被选）
const EXISTING_ACCOUNTS = [
  { id: 101, platform: "openai", status: "active", proxy_id: 1, name: "a1@x.com" },
  { id: 102, platform: "openai", status: "active", proxy_id: 1, name: "a2@x.com" },
  { id: 103, platform: "openai", status: "active", proxy_id: 1, name: "a3@x.com" },
  { id: 104, platform: "openai", status: "active", proxy_id: 2, name: "b1@x.com" },
  { id: 105, platform: "openai", status: "active", proxy_id: 3, name: "c1@x.com" },
  { id: 106, platform: "openai", status: "error", proxy_id: 1, name: "a4-err@x.com" },
];

let lastUploadedAccounts = [];

const sub2api = http.createServer((req, res) => {
  if (req.headers["x-api-key"] !== "test-admin-key") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "invalid admin key" }));
    return;
  }
  if (req.method === "GET" && req.url === "/api/v1/admin/proxies/all") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(PROXIES));
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/api/v1/admin/accounts?")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { items: EXISTING_ACCOUNTS, total: EXISTING_ACCOUNTS.length, page: 1, page_size: 100, pages: 1 } }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/v1/admin/accounts/batch") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      lastUploadedAccounts = body.accounts || [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: lastUploadedAccounts.length, failed: 0 }));
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "not found" }));
});
await new Promise((resolve) => sub2api.listen(sub2apiPort, "127.0.0.1", resolve));

const child = spawn(process.execPath, [
  path.join(projectRoot, "src", "console-server.mjs"),
  "--host", "127.0.0.1", "--port", String(port),
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ONBOARDING_OUTPUT_ROOT: outputRoot,
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-protocol-login.mjs"),
    TOSUB2_TLS_PROFILE: "chrome142",
    PROXY_CONNECTION_RETRY_BASE_MS: "1",
    TOSUB2_MAC_CREDENTIAL_ROOT: path.join(outputRoot, "test-mac-credentials"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let logs = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });
child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });
const childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

// 辅助：等条件成立
async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(100);
  }
  throw new Error("condition not met");
}

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };

  // 创建 3 个已完成的任务用于上传
  const emails = ["pauto1@example.com", "pauto2@example.com", "pauto3@example.com"];
  for (const email of emails) {
    const created = await (await fetch(`${baseUrl}/api/jobs`, {
      method: "POST", headers, body: JSON.stringify({ email }),
    })).json();
    await waitForJobComplete(headers, created.job.id);
  }

  const config = {
    baseUrl: sub2apiUrl,
    adminApiKey: "test-admin-key",
    groupIds: [],
    proxyId: "",           // 未手动指定代理
    autoSelectProxy: true,  // 开启自动选择
  };

  // 场景 1：批量上传 3 个号。代理 B(id=2) 当前绑 1 个最少，应被选中；
  // 但每个账号独立选 + 内存累加：第 1 个选 B(1)→变 2，第 2 个 A(3)与B(2)比较选 B(2)→变 3，
  // 第 3 个 A(3)与B(3)并列→随机。总之不应选停用的 C(3)。
  lastUploadedAccounts = [];
  const uploadResponse = await fetch(`${baseUrl}/api/sub2api/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: await getAllJobIds(headers, emails), config }),
  });
  assert.equal(uploadResponse.status, 200, `upload 应返回 200: ${await uploadResponse.text()}`);
  assert.equal(lastUploadedAccounts.length, 3, `应上传 3 个账号，实际: ${lastUploadedAccounts.length}`);

  const assignedProxyIds = lastUploadedAccounts.map((a) => a.proxy_id);
  for (const pid of assignedProxyIds) {
    assert.ok(pid === 1 || pid === 2, `代理应只在 active 代理 {1,2} 中选，实际选了 ${pid}`);
  }
  // 第一个上传的账号必须选当前最少的 B(id=2)
  assert.equal(assignedProxyIds[0], 2, `第一个账号应选绑定最少的代理 2，实际: ${assignedProxyIds[0]}`);
  // 不应选中停用的代理 3
  assert.equal(assignedProxyIds.includes(3), false, "不应选中停用的代理");

  // 场景 2：手动指定代理（proxyId=1）时，autoSelectProxy 应失效，全部用 1
  lastUploadedAccounts = [];
  await fetch(`${baseUrl}/api/sub2api/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: await getAllJobIds(headers, emails), config: { ...config, proxyId: "1" } }),
  });
  assert.equal(lastUploadedAccounts.length, 3);
  assert.deepEqual(lastUploadedAccounts.map((a) => a.proxy_id), [1, 1, 1], "手动指定代理时应全部使用该代理");

  // 场景 3：关闭 autoSelectProxy 且不指定代理时，不设置 proxy_id
  lastUploadedAccounts = [];
  await fetch(`${baseUrl}/api/sub2api/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ids: await getAllJobIds(headers, emails), config: { ...config, autoSelectProxy: false } }),
  });
  for (const account of lastUploadedAccounts) {
    assert.equal(account.proxy_id, undefined, "关闭自动选且未指定代理时不应设置 proxy_id");
  }

  // 场景 4：开启禁用自动暂停，上传账号的 extra 应带两个 disabled 字段
  lastUploadedAccounts = [];
  await fetch(`${baseUrl}/api/sub2api/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ids: await getAllJobIds(headers, emails),
      config: { ...config, autoSelectProxy: false, disableAutoPause5h: true, disableAutoPause7d: true },
    }),
  });
  for (const account of lastUploadedAccounts) {
    assert.equal(account.extra?.auto_pause_5h_disabled, true, "应设置 auto_pause_5h_disabled=true");
    assert.equal(account.extra?.auto_pause_7d_disabled, true, "应设置 auto_pause_7d_disabled=true");
  }

  // 场景 5：关闭禁用自动暂停，extra 不应包含这两个字段
  lastUploadedAccounts = [];
  await fetch(`${baseUrl}/api/sub2api/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ids: await getAllJobIds(headers, emails),
      config: { ...config, autoSelectProxy: false, disableAutoPause5h: false, disableAutoPause7d: false },
    }),
  });
  for (const account of lastUploadedAccounts) {
    assert.equal(account.extra?.auto_pause_5h_disabled, undefined, "关闭时不应设置 auto_pause_5h_disabled");
    assert.equal(account.extra?.auto_pause_7d_disabled, undefined, "关闭时不应设置 auto_pause_7d_disabled");
  }

  // 场景 6：只开 5h 不开 7d
  lastUploadedAccounts = [];
  await fetch(`${baseUrl}/api/sub2api/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ids: await getAllJobIds(headers, emails),
      config: { ...config, autoSelectProxy: false, disableAutoPause5h: true, disableAutoPause7d: false },
    }),
  });
  for (const account of lastUploadedAccounts) {
    assert.equal(account.extra?.auto_pause_5h_disabled, true, "应单独设置 5h");
    assert.equal(account.extra?.auto_pause_7d_disabled, undefined, "不应设置 7d");
  }

  console.log("proxy autoselect smoke tests passed");
} finally {
  child.kill("SIGTERM");
  await Promise.race([childExit, delay(5_000)]);
  sub2api.closeAllConnections?.();
  await new Promise((resolve) => sub2api.close(resolve));
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function waitForJson(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`console exited: ${logs}`);
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch {}
    await delay(100);
  }
  throw new Error(`no bootstrap: ${logs}`);
}

async function waitForJobComplete(headers, jobId) {
  await waitFor(() => false, 1).catch(() => {});
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const page = await (await fetch(`${baseUrl}/api/jobs`, { headers })).json();
    const job = page.jobs.find((j) => j.id === jobId);
    if (job?.status === "completed" && job.canDownload) return job;
    await delay(150);
  }
  throw new Error(`job ${jobId} 未完成`);
}

async function getAllJobIds(headers, emails) {
  const page = await (await fetch(`${baseUrl}/api/jobs`, { headers })).json();
  return emails.map((email) => page.jobs.find((j) => j.email === email)?.id).filter(Boolean);
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
