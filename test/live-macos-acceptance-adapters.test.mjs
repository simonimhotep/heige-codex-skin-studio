import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  atomicWriteAcceptanceEvidence,
  createProductionInstallAdapter,
  createProductionRepairAdapter,
  inspectPersistenceMenu,
  parseLiveConfiguration,
  selectOfficialStage,
  setPersistenceViaMenu,
  validateLiveOutputPaths,
} from "./live-macos-acceptance.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const APPROVED_HELPER = "关闭后本次继续使用；下次启动恢复原生界面。打开「HeiGe 皮肤启动器」仅恢复本次会话；如需下次启动继续使用，请重新打开常驻开关。";

function identity(overrides = {}) {
  return {
    rootDev: "1",
    rootIno: "2",
    bundleIdentifier: "com.openai.codex",
    version: "26.707.91948",
    build: "5440",
    executableSha256: HASH_A,
    executableSize: 12,
    signatureValid: true,
    teamIdentifier: "2DC432GLL2",
    asarSha256: HASH_B,
    asarSize: 34,
    ...overrides,
  };
}

test("live mutation needs both the opt-in and exact sequence", () => {
  assert.equal(parseLiveConfiguration({}).enabled, false);
  assert.equal(parseLiveConfiguration({ HEIGE_RUN_LIVE_MACOS: "1", HEIGE_LIVE_PREFLIGHT_ONLY: "1" }).mode, "preflight");
  assert.throws(
    () => parseLiveConfiguration({ HEIGE_RUN_LIVE_MACOS: "1" }),
    /HEIGE_LIVE_SEQUENCE=rollback-then-clean/,
  );
  const config = parseLiveConfiguration({
    HEIGE_RUN_LIVE_MACOS: "1",
    HEIGE_LIVE_SEQUENCE: "rollback-then-clean",
  });
  assert.equal(config.mode, "mutation");
});

test("live evidence outputs stay inside fixed result and report allowlists", () => {
  const home = "/Users/example";
  assert.doesNotThrow(() => validateLiveOutputPaths({
    mode: "preflight",
    resultPath: "/Users/example/Library/Application Support/HeiGeCodexSkinStudio/live-acceptance/20260717T010203Z/result.json",
    reportPath: null,
  }, home));
  assert.throws(() => validateLiveOutputPaths({
    mode: "preflight",
    resultPath: "/tmp/result.json",
    reportPath: null,
  }, home), /fixed acceptance run allowlist/);
  assert.throws(() => validateLiveOutputPaths({
    mode: "mutation",
    resultPath: null,
    reportPath: null,
  }, home), /requires both result and report paths/);
});

test("stage selection accepts a polluted current app and one signed official stage", async () => {
  const current = identity({ signatureValid: false, teamIdentifier: null, asarSha256: HASH_A });
  const stage = identity();
  const result = await selectOfficialStage({
    currentAppPath: "/Applications/ChatGPT.app",
    candidatePaths: ["/Applications/.ChatGPT.app.heige-official-stage-20260716-91948"],
    inspectApp: async (path) => path.endsWith("ChatGPT.app") ? current : stage,
  });
  assert.equal(result.current.classification, "polluted");
  assert.equal(result.stage.identity.signatureValid, true);
  assert.equal(result.stage.identity.teamIdentifier, "2DC432GLL2");
  assert.equal(result.stage.identity.executableSha256, HASH_A);
  assert.equal(result.stage.identity.asarSha256, HASH_B);
});

test("stage selection rejects ambiguity and explicit digest drift", async () => {
  const current = identity({ signatureValid: false, teamIdentifier: null, asarSha256: HASH_A });
  const stage = identity();
  const inspectApp = async (path) => path.endsWith("ChatGPT.app") ? current : stage;
  await assert.rejects(selectOfficialStage({
    currentAppPath: "/Applications/ChatGPT.app",
    candidatePaths: [
      "/Applications/.ChatGPT.app.heige-official-stage-a",
      "/Applications/.ChatGPT.app.heige-official-stage-b",
    ],
    inspectApp,
  }), /exactly one trusted official stage/);
  await assert.rejects(selectOfficialStage({
    currentAppPath: "/Applications/ChatGPT.app",
    candidatePaths: ["/Applications/.ChatGPT.app.heige-official-stage-a"],
    explicitStagePath: "/Applications/.ChatGPT.app.heige-official-stage-a",
    expectedStageAsarSha256: HASH_A,
    inspectApp,
  }), /stage app.asar digest drift/);
});

test("atomic evidence uses private modes and redacts secrets", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-live-evidence-")));
  const path = join(root, "nested", "result.json");
  await atomicWriteAcceptanceEvidence(path, {
    status: "FAIL",
    token: "secret-token",
    detail: `home=${process.env.HOME}/private`,
    failure: "controlToken=secret-in-an-error",
    rawLog: "must not survive",
  }, { home: process.env.HOME });
  const directory = await lstat(join(root, "nested"));
  const file = await lstat(path);
  assert.equal(directory.mode & 0o777, 0o700);
  assert.equal(file.mode & 0o777, 0o600);
  const body = await readFile(path, "utf8");
  assert.doesNotMatch(body, /secret-token|secret-in-an-error|rawLog|must not survive/);
  assert.match(body, /\$HOME/);
});

test("atomic evidence rejects symlink ancestry and keeps Markdown line structure", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-live-evidence-links-")));
  const real = join(root, "real");
  const linked = join(root, "linked");
  await mkdir(real, { mode: 0o700 });
  await symlink(real, linked);
  await assert.rejects(
    atomicWriteAcceptanceEvidence(join(linked, "result.json"), { status: "PASS" }),
    /real directory|symlink ancestor|canonical drift/,
  );
  const markdownPath = join(root, "report", "result.md");
  await atomicWriteAcceptanceEvidence(markdownPath, "# Report\n\nStatus: PASS\n");
  assert.equal(await readFile(markdownPath, "utf8"), "# Report\n\nStatus: PASS\n");
});

test("repair adapter delegates repair and rollback recovery to production functions", async () => {
  const calls = [];
  const adapter = createProductionRepairAdapter({
    repair: async (input) => { calls.push(["repair", input]); return { status: "repaired" }; },
    recover: async (input) => { calls.push(["recover", input]); return { recovered: true, action: "rollback" }; },
  });
  const input = {
    currentAppPath: "/Applications/ChatGPT.app",
    stagedAppPath: "/Applications/.ChatGPT.app.heige-official-stage-a",
    journalPath: "/tmp/app-repair.json",
    expectedBeforeAsarSha256: HASH_A,
    expectedOfficialAsarSha256: HASH_B,
  };
  assert.equal((await adapter.repair(input)).status, "repaired");
  assert.equal((await adapter.recover({ journalPath: input.journalPath })).action, "rollback");
  assert.deepEqual(calls.map(([kind]) => kind), ["repair", "recover"]);
});

test("install adapter delegates to the production macOS coordinator", async () => {
  const calls = [];
  const adapter = createProductionInstallAdapter({
    install: async (input) => { calls.push(input); return { status: "installed" }; },
  });
  const input = { sourceRoot: "/source", targetRoot: "/target", port: 9341 };
  assert.equal((await adapter.install(input)).status, "installed");
  assert.deepEqual(calls, [input]);
});

test("menu helpers inspect and operate the real switch and confirmation elements", async () => {
  const expressions = [];
  const states = [
    { origin: "app://-", switchPresent: true, role: "switch", checked: true, pending: false, revision: 4, helper: APPROVED_HELPER, confirmationHidden: true },
    { origin: "app://-", switchPresent: true, role: "switch", checked: true, pending: false, revision: 4, helper: APPROVED_HELPER, confirmationHidden: true },
    { origin: "app://-", switchPresent: true, role: "switch", checked: true, pending: false, revision: 4, helper: APPROVED_HELPER, confirmationHidden: false },
    { origin: "app://-", switchPresent: true, role: "switch", checked: true, pending: true, revision: 4, helper: APPROVED_HELPER, confirmationHidden: true },
    { origin: "app://-", switchPresent: true, role: "switch", checked: false, pending: false, revision: 5, helper: APPROVED_HELPER, confirmationHidden: true },
  ];
  const session = {
    async evaluate(expression) {
      expressions.push(expression);
      if (expression.includes("const snapshot")) return states.shift();
      return true;
    },
  };
  const before = await inspectPersistenceMenu(session);
  assert.equal(before.checked, true);
  const after = await setPersistenceViaMenu(session, false, { pollIntervalMs: 0, timeoutMs: 100 });
  assert.equal(after.checked, false);
  assert.equal(after.revision, 5);
  assert.ok(expressions.some((value) => value.includes("persistence-switch")));
  assert.ok(expressions.some((value) => value.includes("persistence-confirm")));
});
