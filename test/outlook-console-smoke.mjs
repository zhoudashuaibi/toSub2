import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-outlook-console-"));
const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;

const CLIENT_ID = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";
const REFRESH_TOKEN = "M.C509_BL2.0.U.-".repeat(30);
const PASSWORD = "outlook-pw-12345";
const OUTLOOK_EMAIL = "outlook-smoke@example.com";

const child = spawn(process.execPath, [
  path.join(projectRoot, "src", "console-server.mjs"),
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
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

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };

  // 验证 outlook-fetch-config 端点：默认值 + 保存 + 回读
  const defaultConfig = await fetchJson(`${baseUrl}/api/outlook-fetch-config`, { headers });
  assert.ok(defaultConfig.endpoint, "默认应返回 endpoint");
  assert.equal(defaultConfig.endpoint, "https://8t92.cc/api/fetch-mails");

  const saveResponse = await fetch(`${baseUrl}/api/outlook-fetch-config`, {
    method: "POST",
    headers,
    body: JSON.stringify({ endpoint: "https://custom.example/api/fetch-mails" }),
  });
  assert.equal(saveResponse.status, 200);
  const saved = await saveResponse.json();
  assert.equal(saved.endpoint, "https://custom.example/api/fetch-mails");

  const reloaded = await fetchJson(`${baseUrl}/api/outlook-fetch-config`, { headers });
  assert.equal(reloaded.endpoint, "https://custom.example/api/fetch-mails");

  // 非法 endpoint 报 400
  const badResponse = await fetch(`${baseUrl}/api/outlook-fetch-config`, {
    method: "POST",
    headers,
    body: JSON.stringify({ endpoint: "not-a-url" }),
  });
  assert.equal(badResponse.status, 400);
  await badResponse.json();

  // 恢复默认，避免影响后续取件
  await fetch(`${baseUrl}/api/outlook-fetch-config`, {
    method: "POST",
    headers,
    body: JSON.stringify({ endpoint: "https://8t92.cc/api/fetch-mails" }),
  });

  // 验证 outlook-batch 端点：创建任务 + publicJob 字段
  const batchResponse = await fetch(`${baseUrl}/api/jobs/outlook-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: `${OUTLOOK_EMAIL}----${PASSWORD}----${CLIENT_ID}----${REFRESH_TOKEN}`,
    }),
  });
  const batchText2 = await batchResponse.text();
  assert.equal(batchResponse.status, 201, `outlook-batch 应返回 201，实际: ${batchResponse.status} ${batchText2}`);
  const batchResult = JSON.parse(batchText2);
  assert.equal(batchResult.created, 1);
  const job = batchResult.jobs[0];
  assert.equal(job.email, OUTLOOK_EMAIL);
  assert.equal(job.mailSource, "outlook", `publicJob.mailSource 应为 outlook，实际: ${job.mailSource}`);
  assert.equal(job.hasOutlookCredential, true);
  // publicJob 不得泄漏 refresh_token / 密码
  assert.equal(job.outlookRefreshToken, undefined, "publicJob 不得返回 outlookRefreshToken");
  assert.equal(job.outlookPassword, undefined, "publicJob 不得返回 outlookPassword");
  assert.equal(job.password, undefined || job.password, "password 字段不应出现在 publicJob 中");
  assert.equal(JSON.stringify(job).includes(REFRESH_TOKEN), false, "publicJob 不得包含 refresh_token 明文");

  // job-meta.json 不得包含 refresh_token
  const metaPath = path.join(outputRoot, job.id, "job-meta.json");
  const metadata = JSON.parse(await fs.readFile(metaPath, "utf8"));
  assert.equal(metadata.mail_source, "outlook", "job-meta 应记录 mail_source=outlook");
  assert.equal(JSON.stringify(metadata).includes(REFRESH_TOKEN), false, "job-meta 不得包含 refresh_token");
  assert.equal(JSON.stringify(metadata).includes(PASSWORD), false, "job-meta 不得包含 outlook 密码");

  // 重复导入同一邮箱应更新而非新增
  const dupResponse = await fetch(`${baseUrl}/api/jobs/outlook-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: `${OUTLOOK_EMAIL}----${PASSWORD}----${CLIENT_ID}----${REFRESH_TOKEN}`,
    }),
  });
  const dupResult = await dupResponse.json();
  assert.equal(dupResult.updated, 1, "重复邮箱应触发 update");

  // 非法行报错
  const badBatchResponse = await fetch(`${baseUrl}/api/jobs/outlook-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "bad@x.com----only-two-segments" }),
  });
  assert.equal(badBatchResponse.status, 400);

  console.log("outlook console smoke tests passed");
} finally {
  child.kill("SIGTERM");
  await Promise.race([childExit, delay(5_000)]);
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function waitForJson(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`console exited before startup with code ${child.exitCode}: ${logs}`);
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await delay(100);
  }
  throw new Error(`console did not start at ${url}: ${logs}`);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
