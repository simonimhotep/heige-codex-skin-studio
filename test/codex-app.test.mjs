import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import {
  bundledNodeCandidates,
  classifyInjection,
  codexAppCandidates,
  codexInstallation,
  discoverCodex,
  listCodexProcesses,
  parseCodexProcessTable,
  parseMacPsTable,
  resolveCodexApp,
  runtimeDiagnostics,
  sameProcessIdentity,
} from "../src/codex-app.mjs";
import { resolveStudioPaths } from "../src/constants.mjs";

const execFileAsync = promisify(execFile);
const winEnv = { LOCALAPPDATA: "C:\\Users\\heige\\AppData\\Local", ProgramFiles: "C:\\Program Files", APPDATA: "C:\\Users\\heige\\AppData\\Roaming" };

test("an invalid explicit app fails instead of silently falling back", async () => {
  await assert.rejects(
    resolveCodexApp({
      platform: "darwin",
      env: { HEIGE_CODEX_APP: "/bad/ChatGPT.app" },
      exists: async () => false,
    }),
    /HEIGE_CODEX_APP/,
  );
});

test("a valid explicit app wins without probing fallback locations", async () => {
  const probes = [];
  const result = await resolveCodexApp({
    platform: "darwin",
    env: { HEIGE_CODEX_APP: "/Custom/ChatGPT.app" },
    exists: async (path) => {
      probes.push(path);
      return path === "/Custom/ChatGPT.app";
    },
  });

  assert.equal(result.appPath, "/Custom/ChatGPT.app");
  assert.equal(result.source, "env");
  assert.deepEqual(probes, ["/Custom/ChatGPT.app"]);
});

test("mac app resolution returns the exact system installation shape", async () => {
  const result = await resolveCodexApp({
    platform: "darwin",
    env: {},
    home: "/Users/alice",
    exists: async (path) => path === "/Applications/ChatGPT.app",
  });

  assert.deepEqual(result, {
    platform: "darwin",
    appPath: "/Applications/ChatGPT.app",
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    bundledNodePath: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
    bundledNodeCandidates: [
      "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
      "/Applications/ChatGPT.app/Contents/Resources/cua_node/node",
    ],
    source: "system",
  });
});

test("mac app resolution falls back to the current user installation", async () => {
  const result = await resolveCodexApp({
    platform: "darwin",
    env: {},
    home: "/Users/alice",
    exists: async (path) => path === "/Users/alice/Applications/ChatGPT.app",
  });

  assert.equal(result.appPath, "/Users/alice/Applications/ChatGPT.app");
  assert.equal(result.source, "user");
});

test("codex installation preserves windows bundled-node candidate semantics", () => {
  const appPath = "C:\\Users\\heige\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe";
  const candidates = [
    "C:\\Users\\heige\\AppData\\Local\\Programs\\ChatGPT\\resources\\cua_node\\node.exe",
    "C:\\Users\\heige\\AppData\\Local\\Programs\\ChatGPT\\resources\\cua_node\\bin\\node.exe",
  ];

  assert.deepEqual(codexInstallation(appPath, { platform: "win32" }), {
    appPath,
    executablePath: appPath,
    bundledNodePath: candidates[0],
    bundledNodeCandidates: candidates,
  });
});

test("process identity matches only when all fields are exactly equal", () => {
  const identity = {
    pid: 42,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    startedAt: "Thu Jul 16 16:49:24 2026",
  };

  assert.equal(sameProcessIdentity(identity, { ...identity }), true);
  assert.equal(sameProcessIdentity(identity, { ...identity, pid: 43 }), false);
  assert.equal(sameProcessIdentity(identity, { ...identity, executablePath: "/other" }), false);
  assert.equal(sameProcessIdentity(identity, { ...identity, executablePath: `${identity.executablePath} ` }), false);
  assert.equal(sameProcessIdentity(identity, { ...identity, startedAt: "Thu Jul 16 16:49:25 2026" }), false);
  assert.equal(sameProcessIdentity(identity, { ...identity, startedAt: `${identity.startedAt} ` }), false);
});

test("process identity rejects missing or invalid required fields", async (t) => {
  const identity = {
    pid: 42,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    startedAt: "Thu Jul 16 16:49:24 2026",
  };
  const cases = [
    ["both identities are null", null, null],
    ["left identity is null", null, identity],
    ["right identity is null", identity, null],
    ["identities are not objects", "identity", "identity"],
    ["both identities are empty objects", {}, {}],
    ["pid is zero", { ...identity, pid: 0 }, { ...identity, pid: 0 }],
    ["pid is negative", { ...identity, pid: -1 }, { ...identity, pid: -1 }],
    ["pid is fractional", { ...identity, pid: 1.5 }, { ...identity, pid: 1.5 }],
    ["pid is not a number", { ...identity, pid: "42" }, { ...identity, pid: "42" }],
    ["executable path is missing", { pid: identity.pid, startedAt: identity.startedAt }, { pid: identity.pid, startedAt: identity.startedAt }],
    ["executable path is empty", { ...identity, executablePath: "" }, { ...identity, executablePath: "" }],
    ["executable path is not a string", { ...identity, executablePath: 1 }, { ...identity, executablePath: 1 }],
    ["start time is missing", { pid: identity.pid, executablePath: identity.executablePath }, { pid: identity.pid, executablePath: identity.executablePath }],
    ["start time is empty", { ...identity, startedAt: "" }, { ...identity, startedAt: "" }],
    ["start time is not a string", { ...identity, startedAt: 1 }, { ...identity, startedAt: 1 }],
  ];

  for (const [name, left, right] of cases) {
    await t.test(name, () => {
      assert.equal(sameProcessIdentity(left, right), false);
    });
  }
});

test("the real ps command shape yields a stable process identity", () => {
  const app = codexInstallation("/Applications/ChatGPT.app", { platform: "darwin" });
  const commandLine = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9341";
  const rows = parseCodexProcessTable(
    `   42 Thu Jul 16 16:49:24 2026 ${commandLine}`,
    app,
  );

  assert.deepEqual(rows[0], {
    pid: 42,
    executablePath: app.executablePath,
    startedAt: "Thu Jul 16 16:49:24 2026",
    commandLine,
    hasCdp: true,
    cdpPort: 9341,
  });
});

test("parser accepts an actual ps row for the current process", { skip: process.platform !== "darwin" }, async () => {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,lstart=,command="], {
    encoding: "utf8",
  });
  const rows = parseMacPsTable(stdout);

  assert.ok(rows.some((row) => row.pid === process.pid && row.commandLine.includes("node")));
});

test("process listing uses the real ps columns and returns only the selected app", async () => {
  const app = codexInstallation("/Applications/ChatGPT.app", { platform: "darwin" });
  const calls = [];
  const exec = async (bin, args) => {
    calls.push([bin, args]);
    return {
      stdout: [
        "  42 Thu Jul 16 16:49:24 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port 9341",
        "  43 Thu Jul 16 16:50:24 2026 /usr/bin/other --remote-debugging-port=9341",
      ].join("\n"),
    };
  };

  const rows = await listCodexProcesses({ app, exec });

  assert.deepEqual(calls, [["/bin/ps", ["-axo", "pid=,lstart=,command="]]]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, 42);
  assert.equal(rows[0].cdpPort, 9341);
});

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
  const env = {
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
  };
  const exec = async (bin, args, options) => {
    assert.equal(bin, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.ok(args.join(" ").includes("Win32_Process"));
    assert.deepEqual(options.env, {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
    });
    return { stdout: "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT\\ChatGPT.exe --remote-debugging-port=9341\r\n" };
  };
  const fetchImpl = async () => { throw new Error("refused"); };

  const diag = await runtimeDiagnostics({ platform: "win32", exec, env, fetchImpl });
  assert.equal(diag.processRunning, true);
  assert.equal(diag.processHasDebugFlag, true);
  assert.equal(diag.portOpen, false);
  assert.match(classifyInjection(diag), /^flag-present-port-closed/);
});

test("mac discovery includes the per-user Applications folder", () => {
  const list = codexAppCandidates({ platform: "darwin", home: "/Users/alice" });
  assert.ok(list.includes("/Users/alice/Applications/ChatGPT.app"), "must probe ~/Applications too");
});
