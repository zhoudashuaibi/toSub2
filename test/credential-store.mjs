import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCredentialStore } from "../src/credential-store.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-credentials-"));

try {
  const powerShellRunner = async (script, input) => {
    if (script.includes("ProtectedData]::Protect")) {
      return { code: 0, stdout: Buffer.from(input, "utf8").toString("base64"), stderr: "" };
    }
    if (script.includes("ProtectedData]::Unprotect")) {
      return { code: 0, stdout: Buffer.from(input.trim(), "base64").toString("utf8"), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected script" };
  };
  const store = createCredentialStore({ platform: "win32", windowsRoot: tempRoot, powerShellRunner });
  const email = "Windows.User@example.com";
  const emptyCreds = { password: "", totpSecret: "", proxyUrl: "", outlookClientId: "", outlookRefreshToken: "", outlookPassword: "" };
  const credentials = {
    password: "test-password",
    totpSecret: "JBSWY3DPEHPK3PXP",
    proxyUrl: "socks5h://user:secret@proxy.example:5000",
    outlookClientId: "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
    outlookRefreshToken: "M.C509_BL2.0.U.-".repeat(30),
    outlookPassword: "outlook-pw-12345",
  };

  assert.deepEqual(await store.load(email), emptyCreds);
  await store.save(email, credentials);
  assert.deepEqual(await store.load(email.toLowerCase()), credentials);

  const updatedCredentials = {
    password: "更新后的密码",
    totpSecret: "NB2W45DFOIZAQWER",
    proxyUrl: "http://updated:secret@proxy.example:8080",
    outlookClientId: "",
    outlookRefreshToken: "",
    outlookPassword: "",
  };
  await store.save(email, updatedCredentials);
  assert.deepEqual(await store.load(email), { ...emptyCreds, ...updatedCredentials });

  // Outlook 凭据单独往返 + 密文落盘校验
  await store.save(email, credentials);
  const storedFiles = await fs.readdir(tempRoot);
  assert.equal(storedFiles.length, 1);
  const encryptedAtRest = await fs.readFile(path.join(tempRoot, storedFiles[0]), "utf8");
  assert.equal(encryptedAtRest.includes(credentials.password), false);
  assert.equal(encryptedAtRest.includes(credentials.proxyUrl), false);
  assert.equal(encryptedAtRest.includes(credentials.outlookRefreshToken), false);
  assert.equal(encryptedAtRest.includes(credentials.outlookPassword), false);

  await store.delete(email);
  assert.deepEqual(await store.load(email), emptyCreds);

  if (process.platform === "win32") {
    const realStore = createCredentialStore({ windowsRoot: path.join(tempRoot, "real-dpapi") });
    await realStore.save(email, credentials);
    assert.deepEqual(await realStore.load(email), credentials);
    await realStore.delete(email);
    assert.deepEqual(await realStore.load(email), emptyCreds);
  }

  let macKey = "";
  const macStore = createCredentialStore({
    platform: "darwin",
    macRoot: path.join(tempRoot, "mac"),
    securityRunner: async (args, input = "") => {
      if (args[0] === "add-generic-password") {
        assert.equal(args.at(-1), "-w");
        assert.equal(args.some((value) => value.includes(credentials.password)), false);
        const enteredKeys = input.trim().split(/\r?\n/);
        assert.equal(enteredKeys.length, 2);
        assert.equal(enteredKeys[0], enteredKeys[1]);
        macKey = enteredKeys[0];
        assert.equal(Buffer.from(macKey, "base64").length, 32);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "find-generic-password") return { code: 0, stdout: macKey, stderr: "" };
      if (args[0] === "delete-generic-password") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  });
  await macStore.save(email, credentials);
  assert.deepEqual(await macStore.load(email), credentials);
  await macStore.delete(email);

  const truncatedPayload = JSON.stringify({
    version: 2,
    password: credentials.password,
    totpSecret: credentials.totpSecret,
    proxyUrl: credentials.proxyUrl.repeat(5),
  }).slice(0, 128);
  const legacyMacStore = createCredentialStore({
    platform: "darwin",
    macRoot: path.join(tempRoot, "legacy-mac"),
    securityRunner: async (args) => (
      args[0] === "find-generic-password"
        ? { code: 0, stdout: truncatedPayload, stderr: "" }
        : { code: 0, stdout: "", stderr: "" }
    ),
  });
  // version-2 旧 payload 不含 outlook 字段，应回退为空串而不是 undefined
  assert.deepEqual(await legacyMacStore.load(email), {
    password: credentials.password,
    totpSecret: credentials.totpSecret,
    proxyUrl: "",
    outlookClientId: "",
    outlookRefreshToken: "",
    outlookPassword: "",
  });

  const unsupportedStore = createCredentialStore({ platform: "linux" });
  await assert.rejects(
    unsupportedStore.save(email, credentials),
    (error) => error.status === 501 && error.message.includes("Windows DPAPI"),
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("credential store tests passed");
