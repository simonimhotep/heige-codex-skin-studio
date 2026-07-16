import assert from "node:assert/strict";
import test from "node:test";

import { bundledNodeCandidates, classifyInjection, codexAppCandidates, discoverCodex, runtimeDiagnostics } from "../src/codex-app.mjs";
import { resolveStudioPaths } from "../src/constants.mjs";

const winEnv = { LOCALAPPDATA: "C:\\Users\\heige\\AppData\\Local", ProgramFiles: "C:\\Program Files", APPDATA: "C:\\Users\\heige\\AppData\\Roaming" };

test("lists windows install candidates from environment paths", () => {
  const candidates = codexAppCandidates({ platform: "win32", env: winEnv, home: "C:\\Users\\heige" });
  assert.ok(candidates.some((path) => path.includes("Programs")));
  assert.ok(candidates.every((path) => path.endsWith(".exe")));
});

test("resolves the bundled node next to the windows executable", () => {
  const candidates = bundledNodeCandidates("C:\\Users\\heige\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe", { platform: "win32" });
  assert.ok(candidates[0].endsWith("node.exe"));
  assert.ok(candidates[0].includes("cua_node"));
});

test("discovery reports the first existing app and node per platform", async () => {
  const disk = new Set([
    "C:\\Users\\heige\\AppData\\Local\\Programs\\Codex\\Codex.exe",
    "C:\\Users\\heige\\AppData\\Local\\Programs\\Codex\\resources\\cua_node\\node.exe",
  ]);
  const result = await discoverCodex({
    platform: "win32",
    env: winEnv,
    home: "C:\\Users\\heige",
    exists: async (path) => disk.has(path),
  });
  assert.equal(result.appFound, true);
  assert.ok(result.app.endsWith("Codex.exe"));
  assert.equal(result.bundledNodeFound, true);
});

test("discovery degrades honestly when nothing is installed", async () => {
  const result = await discoverCodex({ platform: "win32", env: winEnv, home: "C:\\Users\\heige", exists: async () => false });
  assert.equal(result.appFound, false);
  assert.equal(result.bundledNodeFound, false);
});

test("mac discovery keeps the classic bundle path", async () => {
  const result = await discoverCodex({ platform: "darwin", exists: async (path) => path === "/Applications/ChatGPT.app" });
  assert.equal(result.appFound, true);
  assert.match(result.bundledNode, /cua_node\/bin\/node$/);
});

test("state paths follow the platform convention", () => {
  const win = resolveStudioPaths({ home: "C:\\Users\\heige", platform: "win32", env: winEnv });
  assert.ok(win.stateRoot.includes("Roaming"));
  const mac = resolveStudioPaths({ home: "/Users/heige", platform: "darwin", env: {} });
  assert.ok(mac.stateRoot.includes("Application Support"));
});

test("runtime diagnostics reads version, process flag, and port state", async () => {
  const exec = async (bin, args) => {
    if (bin === "/usr/bin/defaults") return { stdout: "151.0.8000.1\n" };
    if (bin === "/bin/ps") {
      return {
        stdout: [
          "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=127.0.0.1 --remote-debugging-port=9341",
          "/Applications/ChatGPT.app/Contents/Frameworks/helper --type=renderer",
        ].join("\n"),
      };
    }
    throw new Error(`unexpected exec: ${bin} ${args}`);
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ Browser: "Chrome/150.0" }) });

  const diag = await runtimeDiagnostics({ platform: "darwin", exec, fetchImpl });
  assert.equal(diag.appVersion, "151.0.8000.1");
  assert.equal(diag.processRunning, true);
  assert.equal(diag.processHasDebugFlag, true);
  assert.equal(diag.portOpen, true);
  assert.equal(diag.portBrowser, "Chrome/150.0");
  assert.match(classifyInjection(diag), /^ok/);
});

test("runtime diagnostics classifies the three failure shapes", async () => {
  const base = { appVersion: null, portOpen: false, portBrowser: null };
  assert.match(
    classifyInjection({ ...base, processRunning: true, processHasDebugFlag: true }),
    /^flag-present-port-closed/,
  );
  assert.match(
    classifyInjection({ ...base, processRunning: true, processHasDebugFlag: false }),
    /^running-no-flag/,
  );
  assert.match(
    classifyInjection({ ...base, processRunning: false, processHasDebugFlag: false }),
    /^not-running/,
  );
});

test("runtime diagnostics degrades honestly when probes fail", async () => {
  const exec = async () => { throw new Error("denied"); };
  const fetchImpl = async () => { throw new Error("refused"); };

  const diag = await runtimeDiagnostics({ platform: "darwin", exec, fetchImpl });
  assert.deepEqual(diag, {
    appVersion: null,
    processRunning: false,
    processHasDebugFlag: false,
    portOpen: false,
    portBrowser: null,
  });
});

test("runtime diagnostics reads windows process command lines via powershell", async () => {
  const exec = async (bin, args) => {
    assert.equal(bin, "powershell");
    assert.ok(args.join(" ").includes("Win32_Process"));
    return { stdout: "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT\\ChatGPT.exe --remote-debugging-port=9341\r\n" };
  };
  const fetchImpl = async () => { throw new Error("refused"); };

  const diag = await runtimeDiagnostics({ platform: "win32", exec, fetchImpl });
  assert.equal(diag.processRunning, true);
  assert.equal(diag.processHasDebugFlag, true);
  assert.equal(diag.portOpen, false);
  assert.match(classifyInjection(diag), /^flag-present-port-closed/);
});
