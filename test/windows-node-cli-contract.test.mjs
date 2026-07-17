import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { createWindowsSecurityAdapter } from "../src/windows-secure-fs.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repositoryRoot, "src", "cli.mjs");
const controllerPath = join(repositoryRoot, "scripts", "windows", "controller.ps1");
const operationLockUrl = pathToFileURL(join(repositoryRoot, "src", "operation-lock.mjs")).href;
const cliUrl = pathToFileURL(cliPath).href;
const PORT = 49341;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function runtimeSnapshot(processes = []) {
  const executablePath = "C:\\Program Files\\Codex\\Codex.exe";
  return {
    schemaVersion: 1,
    app: {
      kind: "Win32",
      executablePath,
      installPath: "C:\\Program Files\\Codex",
      productName: "Codex",
      packageFullName: null,
      aumid: null,
      launchTarget: executablePath,
    },
    nodePath: process.execPath,
    processes,
    listeners: [],
  };
}

function runtimeAppIdentityToken() {
  const app = runtimeSnapshot().app;
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    product: "heige-codex-skin-studio",
    kind: app.kind,
    executablePath: app.executablePath,
    installPath: app.installPath,
    productName: app.productName,
    packageFullName: app.packageFullName,
    aumid: app.aumid,
  }), "utf8").toString("base64url");
}

function studioState(overrides = {}) {
  return {
    schemaVersion: 2,
    persistenceEnabled: true,
    selectedThemeId: "miku-488137",
    lastNonNativeThemeId: "miku-488137",
    controlToken: randomBytes(32).toString("base64url"),
    lastTransitionNonce: null,
    revision: 0,
    ...overrides,
  };
}

async function writePrivateJson(path, value, security) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await security.protectFile(path);
  await security.verifyFile(path);
}

async function runCli(args, env) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) child.kill();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) child.kill();
  });
  let timer;
  const result = await new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, 30_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  return { ...result, stdout, stderr };
}

function parseSuccessfulCli(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  return JSON.parse(result.stdout);
}

async function startLockHolder(stateRoot) {
  const source = `
    import { join } from "node:path";
    import { acquireOperationLock } from ${JSON.stringify(operationLockUrl)};
    import { readProcessIdentity } from ${JSON.stringify(cliUrl)};
    const stateRoot = process.argv[1];
    const identity = await readProcessIdentity(process.pid, "win32");
    await acquireOperationLock({
      platform: "win32",
      stateRoot,
      lockPath: join(stateRoot, "operation.lock"),
      operation: "test:windows-real-holder",
      identity,
      readProcessIdentity: (pid) => readProcessIdentity(pid, "win32"),
    });
    process.stdout.write(JSON.stringify(identity) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, stateRoot], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("lock holder readiness timed out")), 20_000);
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onData = (chunk) => {
        stdout += chunk;
        if (!stdout.includes("\n")) return;
        cleanup();
        JSON.parse(stdout.slice(0, stdout.indexOf("\n")));
        resolve();
      };
      const onError = (error) => { cleanup(); reject(error); };
      const onExit = (code) => {
        cleanup();
        reject(new Error(`lock holder exited before readiness (${code}): ${stderr}`));
      };
      child.stdout.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  } catch (error) {
    child.kill();
    throw error;
  }
  return child;
}

async function terminate(child) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}

test("real Windows Node CLI stays isolated, portable, and crash-safe", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async (t) => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "heige-windows-node-cli-")));
  const statePath = join(stateRoot, "state.json");
  const fixturePath = join(stateRoot, "runtime-fixture.json");
  const taskName = `HeiGe Codex Skin Studio Test ${randomUUID()}`;
  const powershellPath = join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const security = createWindowsSecurityAdapter({ powershellPath });
  let holder = null;
  t.after(async () => {
    await terminate(holder).catch(() => {});
    try {
      await execFile(powershellPath, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        controllerPath,
        "-Action",
        "unregister",
        "-TaskName",
        taskName,
        "-Port",
        String(PORT),
        "-StateDirectory",
        stateRoot,
      ], { timeout: 20_000, windowsHide: true });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  await security.protectDirectory(stateRoot);
  await security.verifyDirectory(stateRoot);
  await writePrivateJson(statePath, studioState(), security);
  await writePrivateJson(fixturePath, runtimeSnapshot(), security);
  const env = {
    ...process.env,
    NODE_ENV: "test",
    HEIGE_TEST_WINDOWS_RUNTIME_FIXTURE: fixturePath,
    HEIGE_TEST_WINDOWS_STATE_ROOT: stateRoot,
    HEIGE_TEST_WINDOWS_TASK_NAME: taskName,
    HEIGE_WINDOWS_APP_IDENTITY: runtimeAppIdentityToken(),
  };

  const doctor = parseSuccessfulCli(await runCli(["doctor", "--port", String(PORT)], env));
  assert.equal(doctor.platform, "win32");
  assert.equal(doctor.processRunning, false);
  assert.equal(doctor.portOpen, false);

  const status = await runCli(["status", "--port", String(PORT)], env);
  assert.notEqual(status.code, 0);
  assert.doesNotMatch(`${status.stdout}\n${status.stderr}`, /\/bin\/ps|lsof|osascript/i);

  const disabled = parseSuccessfulCli(await runCli([
    "set-persistence",
    "false",
    "--port",
    String(PORT),
  ], env));
  assert.equal(disabled.persistenceEnabled, false);
  assert.equal(disabled.revision, 1);
  const closed = parseSuccessfulCli(await runCli(["restore", "--port", String(PORT)], env));
  assert.deepEqual(closed, { mode: "closed", persistenceEnabled: false });

  await writePrivateJson(fixturePath, runtimeSnapshot([{
    pid: 4242,
    parentProcessId: 100,
    executablePath: "C:\\Program Files\\Codex\\Codex.exe",
    startedAt: "2026-07-17T08:00:00.0000000Z",
  }]), security);
  const native = parseSuccessfulCli(await runCli(["restore", "--port", String(PORT)], env));
  assert.deepEqual(native, { mode: "native", persistenceEnabled: false });

  const beforeContention = await readFile(statePath, "utf8");
  holder = await startLockHolder(stateRoot);
  const contended = await runCli(["restore", "--port", String(PORT)], env);
  assert.notEqual(contended.code, 0);
  assert.match(contended.stderr, /LOCK_HELD/);
  assert.equal(await readFile(statePath, "utf8"), beforeContention);
  await terminate(holder);
  holder = null;
  const recovered = parseSuccessfulCli(await runCli(["restore", "--port", String(PORT)], env));
  assert.deepEqual(recovered, { mode: "native", persistenceEnabled: false });

  const icaclsPath = join(process.env.SystemRoot, "System32", "icacls.exe");
  const trustedState = await readFile(statePath, "utf8");
  await execFile(icaclsPath, [statePath, "/grant", "*S-1-1-0:(M)"], {
    timeout: 15_000,
    windowsHide: true,
  });
  await assert.rejects(security.migrateFile(statePath), /untrusted identity|write access/i);
  const rejected = await runCli(["restore", "--port", String(PORT)], env);
  assert.notEqual(rejected.code, 0);
  assert.equal(await readFile(statePath, "utf8"), trustedState);
  await assert.rejects(security.verifyFile(statePath), /ACL|private/i);
  await security.protectFile(statePath);
});
