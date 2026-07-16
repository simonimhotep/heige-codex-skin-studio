import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CdpSession, fetchRendererTargets } from "../src/cdp-client.mjs";
import { listCodexProcesses, resolveCodexApp } from "../src/codex-app.mjs";
import {
  inspectMacApp,
  recoverMacAppRepair,
  repairMacApp,
} from "../src/macos-app-repair.mjs";
import { runProductionMacosInstall } from "../src/macos-install-coordinator.mjs";
import { readStudioState } from "../src/state-store.mjs";
import { classifyCodexTargets } from "../src/target-classifier.mjs";
import { listThemes } from "../src/theme-store.mjs";

const execFile = promisify(execFileCallback);
const PORT = 9341;
const LEGACY_LABEL = "com.heige.codex-skin-watchdog";
const CONTROLLER_LABEL = "com.heige.codex-skin-controller";
const MAX_PLIST_BYTES = 256 * 1024;
const MAX_THEME_ID_BYTES = 256;
const BUNDLE_IDENTIFIER = "com.openai.codex";
const TEAM_IDENTIFIER = "2DC432GLL2";
const LIVE_SEQUENCE = "rollback-then-clean";
const SHA256 = /^[a-f0-9]{64}$/;
const STAGE_NAME = /^\.ChatGPT\.app\.heige-official-stage-[A-Za-z0-9._-]+$/;
const RUN_STAMP = /^[0-9]{8}T[0-9]{6}Z$/;
const DROPPED_EVIDENCE_KEYS = /^(?:authorization|controlEndpoint|controlToken|env|environment|rawLog|stderr|stdout|token)$/i;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function canonicalAbsolute(path, label) {
  if (
    typeof path !== "string"
    || !isAbsolute(path)
    || path.includes("\0")
    || normalize(path) !== path
  ) throw new Error(`${label} must be a canonical absolute path`);
  return path;
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function parseLiveConfiguration(env = process.env) {
  const enabled = env.HEIGE_RUN_LIVE_MACOS === "1";
  if (!enabled) return Object.freeze({ enabled: false, mode: "disabled" });
  const preflightOnly = env.HEIGE_LIVE_PREFLIGHT_ONLY === "1";
  if (!preflightOnly && env.HEIGE_LIVE_SEQUENCE !== LIVE_SEQUENCE) {
    throw new Error(`live mutation requires HEIGE_LIVE_SEQUENCE=${LIVE_SEQUENCE}`);
  }
  const explicit = [
    env.HEIGE_LIVE_STAGE_APP,
    env.HEIGE_LIVE_EXPECTED_CURRENT_ASAR_SHA256,
    env.HEIGE_LIVE_EXPECTED_STAGE_ASAR_SHA256,
  ];
  const explicitCount = explicit.filter((value) => value !== undefined).length;
  if (explicitCount !== 0 && explicitCount !== explicit.length) {
    throw new Error("explicit stage mode requires stage path and both app.asar digests");
  }
  if (explicitCount === explicit.length) {
    canonicalAbsolute(explicit[0], "HEIGE_LIVE_STAGE_APP");
    digest(explicit[1], "HEIGE_LIVE_EXPECTED_CURRENT_ASAR_SHA256");
    digest(explicit[2], "HEIGE_LIVE_EXPECTED_STAGE_ASAR_SHA256");
  }
  return Object.freeze({
    enabled: true,
    mode: preflightOnly ? "preflight" : "mutation",
    sequence: preflightOnly ? (env.HEIGE_LIVE_SEQUENCE ?? LIVE_SEQUENCE) : LIVE_SEQUENCE,
    explicitStagePath: explicitCount === explicit.length ? explicit[0] : null,
    expectedCurrentAsarSha256: explicitCount === explicit.length ? explicit[1] : null,
    expectedStageAsarSha256: explicitCount === explicit.length ? explicit[2] : null,
    resultPath: env.HEIGE_LIVE_RESULT_JSON ?? null,
    reportPath: env.HEIGE_LIVE_REPORT_MD ?? null,
  });
}

function redactString(value, { home, secrets, preserveNewlines }) {
  let clean = preserveNewlines
    ? value.replace(/\0/g, "")
    : value.replace(/[\r\n\t\0]+/g, " ");
  if (home) clean = clean.split(home).join("$HOME");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) clean = clean.split(secret).join("[REDACTED]");
  }
  return clean
    .replace(/\b(authorization|control[ _-]?token|x-heige-control-token|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/[^\s)\]}>]*/gi, "[REDACTED_LOOPBACK_ENDPOINT]");
}

function sanitizeEvidence(value, context, seen = new WeakSet(), preserveNewlines = false) {
  if (typeof value === "string") {
    return redactString(value, { ...context, preserveNewlines });
  }
  if (value === null || ["boolean", "number"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeEvidence(entry, context, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!DROPPED_EVIDENCE_KEYS.test(key)) result[key] = sanitizeEvidence(entry, context, seen);
  }
  seen.delete(value);
  return result;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicWriteAcceptanceEvidence(path, value, {
  home = userInfo().homedir,
  secrets = [],
  privateDirectory = false,
} = {}) {
  canonicalAbsolute(path, "evidence path");
  const parent = dirname(path);
  let parentBefore = null;
  try { parentBefore = await lstat(parent); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("evidence directory must be a real directory");
  }
  if (await realpath(parent) !== parent) {
    throw new Error("evidence directory has a symlink ancestor or canonical drift");
  }
  if (parentBefore === null || privateDirectory) await chmod(parent, 0o700);
  let destination = null;
  try { destination = await lstat(path); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (destination !== null && (destination.isSymbolicLink() || !destination.isFile())) {
    throw new Error("evidence destination must be absent or a regular file");
  }
  const context = { home, secrets: [...secrets] };
  const sanitized = sanitizeEvidence(value, context, new WeakSet(), typeof value === "string");
  const body = typeof sanitized === "string"
    ? `${sanitized.trimEnd()}\n`
    : `${JSON.stringify(sanitized, null, 2)}\n`;
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await syncDirectory(parent);
    const after = await lstat(parent);
    if (after.dev !== parentInfo.dev || after.ino !== parentInfo.ino || await realpath(parent) !== parent) {
      throw new Error("evidence directory identity changed during atomic write");
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { path, bytes: Buffer.byteLength(body), sha256: sha256(Buffer.from(body)) };
}

export function validateLiveOutputPaths(configuration, home = userInfo().homedir) {
  const resultRoot = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio", "live-acceptance");
  if (configuration.mode === "mutation" && (!configuration.resultPath || !configuration.reportPath)) {
    throw new Error("live mutation requires both result and report paths");
  }
  if (configuration.resultPath !== null) {
    canonicalAbsolute(configuration.resultPath, "live result path");
    const runDirectory = dirname(configuration.resultPath);
    if (
      dirname(runDirectory) !== resultRoot
      || !RUN_STAMP.test(basename(runDirectory))
      || basename(configuration.resultPath) !== "result.json"
    ) throw new Error("live result path is outside the fixed acceptance run allowlist");
  }
  if (configuration.reportPath !== null) {
    canonicalAbsolute(configuration.reportPath, "live report path");
    const expected = join(REPOSITORY_ROOT, "docs", "release", "2026-07-16-macos-verification.md");
    if (configuration.reportPath !== expected) {
      throw new Error("live report path is outside the fixed repository allowlist");
    }
  }
}

function assertAppIdentity(identity, label) {
  if (identity?.bundleIdentifier !== BUNDLE_IDENTIFIER) {
    throw new Error(`${label} bundle identifier mismatch`);
  }
  digest(identity.executableSha256, `${label} executable SHA-256`);
  digest(identity.asarSha256, `${label} app.asar SHA-256`);
  return identity;
}

export async function selectOfficialStage({
  currentAppPath = "/Applications/ChatGPT.app",
  candidatePaths,
  explicitStagePath = null,
  expectedCurrentAsarSha256 = null,
  expectedStageAsarSha256 = null,
  inspectApp = inspectMacApp,
} = {}) {
  canonicalAbsolute(currentAppPath, "current app path");
  const currentIdentity = assertAppIdentity(await inspectApp(currentAppPath), "current app");
  if (expectedCurrentAsarSha256 !== null
    && currentIdentity.asarSha256 !== digest(expectedCurrentAsarSha256, "expected current app.asar")) {
    throw new Error("current app.asar digest drift");
  }
  const candidates = [...new Set(candidatePaths ?? [])];
  if (explicitStagePath !== null) {
    canonicalAbsolute(explicitStagePath, "explicit stage path");
    if (dirname(explicitStagePath) !== "/Applications" || !STAGE_NAME.test(basename(explicitStagePath))) {
      throw new Error("explicit stage path is outside the production allowlist");
    }
    if (expectedStageAsarSha256 === null) {
      throw new Error("explicit stage requires its expected app.asar digest");
    }
    candidates.splice(0, candidates.length, explicitStagePath);
  }
  const trusted = [];
  for (const path of candidates) {
    canonicalAbsolute(path, "stage candidate path");
    if (dirname(path) !== "/Applications" || !STAGE_NAME.test(basename(path))) continue;
    let identity;
    try { identity = assertAppIdentity(await inspectApp(path), "official stage"); } catch { continue; }
    if (identity.signatureValid === true && identity.teamIdentifier === TEAM_IDENTIFIER) {
      trusted.push({ path, identity });
    }
  }
  if (trusted.length !== 1) throw new Error("expected exactly one trusted official stage");
  if (expectedStageAsarSha256 !== null
    && trusted[0].identity.asarSha256 !== digest(expectedStageAsarSha256, "expected stage app.asar")) {
    throw new Error("stage app.asar digest drift");
  }
  const officialCurrent = currentIdentity.signatureValid === true
    && currentIdentity.teamIdentifier === TEAM_IDENTIFIER;
  return {
    current: {
      path: currentAppPath,
      classification: officialCurrent ? "official" : "polluted",
      identity: currentIdentity,
    },
    stage: trusted[0],
  };
}

export function createProductionRepairAdapter({
  repair = repairMacApp,
  recover = recoverMacAppRepair,
} = {}) {
  if (typeof repair !== "function" || typeof recover !== "function") {
    throw new TypeError("repair adapter requires production repair and recovery functions");
  }
  return Object.freeze({
    repair: (input) => repair(input),
    recover: (input) => recover(input),
  });
}

export function createProductionInstallAdapter({ install = runProductionMacosInstall } = {}) {
  if (typeof install !== "function") throw new TypeError("install adapter requires the production coordinator");
  return Object.freeze({ install: (input) => install(input) });
}

const MENU_SNAPSHOT_EXPRESSION = `(() => {
  const snapshot = {};
  const toggle = document.querySelector('[data-heige-role="persistence-switch"]');
  const helper = document.querySelector('[data-heige-role="persistence-helper"]');
  const confirmation = document.querySelector('[data-heige-role="persistence-confirmation"]');
  const state = globalThis.__heigeCodexSkin?.getPersistenceState?.() ?? null;
  snapshot.origin = location.origin;
  snapshot.switchPresent = toggle !== null;
  snapshot.role = toggle?.getAttribute('role') ?? null;
  snapshot.checked = toggle?.getAttribute('aria-checked') === 'true';
  snapshot.pending = state?.pending ?? null;
  snapshot.revision = state?.revision ?? null;
  snapshot.helper = helper?.textContent ?? null;
  snapshot.confirmationHidden = confirmation?.hidden ?? null;
  return snapshot;
})()`;

export async function inspectPersistenceMenu(session, { allowPending = false } = {}) {
  const snapshot = await session.evaluate(MENU_SNAPSHOT_EXPRESSION);
  if (
    snapshot?.origin !== "app://-"
    || snapshot.switchPresent !== true
    || snapshot.role !== "switch"
    || typeof snapshot.checked !== "boolean"
    || !Number.isSafeInteger(snapshot.revision)
    || snapshot.revision < 0
    || (allowPending ? typeof snapshot.pending !== "boolean" : snapshot.pending !== false)
  ) throw new Error("persistence menu identity or authoritative state is invalid");
  const helper = snapshot.helper ?? "";
  if (
    !helper.includes("下次启动恢复原生界面")
    || !helper.includes("HeiGe 皮肤启动器")
    || !helper.includes("仅恢复本次会话")
    || !helper.includes("重新打开常驻开关")
  ) {
    throw new Error("persistence menu reminder is missing the approved recovery guidance");
  }
  return snapshot;
}

export async function setPersistenceViaMenu(session, enabled, {
  timeoutMs = 5_000,
  pollIntervalMs = 50,
} = {}) {
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
  const before = await inspectPersistenceMenu(session);
  if (before.checked === enabled) return before;
  const activated = await session.evaluate(`(() => {
    const element = document.querySelector('[data-heige-role="persistence-switch"]');
    if (!(element instanceof HTMLButtonElement) || element.disabled) return false;
    element.click();
    return true;
  })()`);
  if (activated !== true) throw new Error("persistence switch activation failed");
  if (!enabled) {
    const confirmation = await inspectPersistenceMenu(session);
    if (confirmation.confirmationHidden !== false) {
      throw new Error("persistence off confirmation did not open");
    }
    const confirmed = await session.evaluate(`(() => {
      const element = document.querySelector('[data-heige-role="persistence-confirm"]');
      if (!(element instanceof HTMLButtonElement) || element.disabled) return false;
      element.click();
      return true;
    })()`);
    if (confirmed !== true) throw new Error("persistence off confirmation activation failed");
  }
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await inspectPersistenceMenu(session, { allowPending: true });
    if (last.checked === enabled && last.revision > before.revision && last.pending === false) return last;
    if (pollIntervalMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, pollIntervalMs));
  } while (Date.now() < deadline);
  throw new Error(`persistence menu did not ACK revision ${before.revision + 1} or newer`);
}

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function regularSnapshot(path, label, maxBytes) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > maxBytes) {
    throw new Error(`${label} 必须是非空普通文件且不得是符号链接`);
  }
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) throw new Error(`${label} 必须是 canonical path`);
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    after.dev !== info.dev
    || after.ino !== info.ino
    || after.size !== info.size
    || after.mtimeMs !== info.mtimeMs
    || bytes.byteLength !== info.size
  ) throw new Error(`${label} 在读取期间发生变化`);
  return { bytes, mode: info.mode & 0o777, sha256: sha256(bytes) };
}

async function labelLoaded(uid, label, run = execFile) {
  try {
    await run("/bin/launchctl", ["print", `gui/${uid}/${label}`]);
    return true;
  } catch (error) {
    if ([3, 113, "3", "113"].includes(error?.code)) return false;
    throw error;
  }
}

async function readPlistJson(path, run = execFile) {
  const snapshot = await regularSnapshot(path, "LaunchAgent plist", MAX_PLIST_BYTES);
  const { stdout } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
    encoding: "utf8",
    maxBuffer: MAX_PLIST_BYTES * 2,
  });
  let plist;
  try { plist = JSON.parse(stdout); } catch (cause) {
    throw new Error("LaunchAgent plist 无法转换为 JSON", { cause });
  }
  return { plist, snapshot };
}

async function inspectLegacy({ home, uid, run = execFile }) {
  const stableRoot = join(home, ".codex", "heige-codex-skin-studio");
  const plistPath = join(home, "Library", "LaunchAgents", `${LEGACY_LABEL}.plist`);
  const scriptPath = join(stableRoot, "scripts", "lib", "skin-watchdog.zsh");
  const { plist, snapshot } = await readPlistJson(plistPath, run);
  const expectedKeys = [
    "AbandonProcessGroup",
    "EnvironmentVariables",
    "Label",
    "ProgramArguments",
    "RunAtLoad",
    "StandardErrorPath",
    "StandardOutPath",
    "StartInterval",
  ];
  if (!exactKeys(plist, expectedKeys)) throw new Error("legacy watchdog plist keys 不符合固定 tuple");
  if (
    plist.Label !== LEGACY_LABEL
    || plist.RunAtLoad !== true
    || plist.StartInterval !== 15
    || plist.AbandonProcessGroup !== true
    || !Array.isArray(plist.ProgramArguments)
    || plist.ProgramArguments.length !== 2
    || plist.ProgramArguments[0] !== "/bin/zsh"
    || plist.ProgramArguments[1] !== scriptPath
    || !exactKeys(plist.EnvironmentVariables, ["HEIGE_CODEX_SKIN_PORT", "HEIGE_CODEX_SKIN_STATE"])
    || plist.EnvironmentVariables.HEIGE_CODEX_SKIN_PORT !== String(PORT)
  ) throw new Error("legacy watchdog plist fixed tuple 不匹配");
  const script = await regularSnapshot(scriptPath, "legacy watchdog script", 1024 * 1024);
  if ((script.mode & 0o111) === 0) throw new Error("legacy watchdog script 不可执行");
  return {
    loaded: await labelLoaded(uid, LEGACY_LABEL, run),
    plistMode: snapshot.mode,
    plistSha256: snapshot.sha256,
    scriptMode: script.mode,
    scriptSha256: script.sha256,
    statePathTrusted: false,
    logPathsTrusted: false,
  };
}

async function inspectExistingController({ home, uid, run = execFile }) {
  const path = join(home, "Library", "LaunchAgents", `${CONTROLLER_LABEL}.plist`);
  try {
    const { plist, snapshot } = await readPlistJson(path, run);
    return {
      present: true,
      loaded: await labelLoaded(uid, CONTROLLER_LABEL, run),
      plistMode: snapshot.mode,
      plistSha256: snapshot.sha256,
      labelMatches: plist?.Label === CONTROLLER_LABEL,
      argumentCount: Array.isArray(plist?.ProgramArguments) ? plist.ProgramArguments.length : null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        present: false,
        loaded: await labelLoaded(uid, CONTROLLER_LABEL, run),
      };
    }
    throw error;
  }
}

async function inspectAppAndProcess({ home, run = execFile }) {
  const app = await resolveCodexApp({ home, env: {}, platform: "darwin" });
  if (app.appPath !== "/Applications/ChatGPT.app") {
    throw new Error("live acceptance only accepts /Applications/ChatGPT.app");
  }
  const appInfo = await lstat(app.appPath);
  if (appInfo.isSymbolicLink() || !appInfo.isDirectory()) throw new Error("Codex app 不是可信目录");
  if (await realpath(app.appPath) !== resolve(app.appPath)) throw new Error("Codex app path 非 canonical");
  const identity = assertAppIdentity(await inspectMacApp(app.appPath, { run }), "current app");

  const processes = await listCodexProcesses({ app, exec: run });
  const candidates = processes.filter((entry) => entry.cdpPort === PORT);
  if (candidates.length !== 1) throw new Error(`预期一个 Codex CDP 主进程，实际 ${candidates.length}`);
  const processIdentity = candidates[0];
  const { stdout: ownerOutput } = await run("/usr/sbin/lsof", [
    "-nP", "-a", "-p", String(processIdentity.pid), `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t",
  ]);
  const owners = ownerOutput.split(/\s+/).filter(Boolean);
  if (owners.length !== 1 || Number(owners[0]) !== processIdentity.pid) {
    throw new Error("CDP 端口不属于精确 Codex 主进程");
  }
  return {
    app,
    identity,
    processIdentity: {
      pid: processIdentity.pid,
      executableSha256: identity.executableSha256,
      startedAt: processIdentity.startedAt,
    },
  };
}

async function discoverStageCandidates() {
  const entries = await readdir("/Applications", { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && STAGE_NAME.test(entry.name))
    .map((entry) => join("/Applications", entry.name));
}

async function inspectRenderers() {
  const targets = classifyCodexTargets(await fetchRendererTargets(PORT));
  const mainTargets = targets.filter(({ kind }) => kind === "main");
  if (mainTargets.length === 0) throw new Error("没有严格识别的 Codex 主 renderer");
  const origins = [];
  for (const target of mainTargets) {
    const session = new CdpSession(target.webSocketDebuggerUrl);
    try {
      await session.open();
      origins.push(await session.evaluate("location.origin"));
    } finally {
      session.close();
    }
  }
  if (!origins.every((origin) => origin === "app://-")) throw new Error("renderer origin 不是 app://-");
  return { rendererOrigin: "app://-", mainRendererCount: mainTargets.length };
}

async function inspectLegacyTheme(home) {
  const themePath = join(home, ".codex", "heige-codex-skin-persist", "theme");
  const snapshot = await regularSnapshot(themePath, "legacy theme record", MAX_THEME_ID_BYTES);
  const themeId = snapshot.bytes.toString("utf8").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(themeId)) throw new Error("legacy theme id 无效");
  const themeRoot = join(home, ".codex", "heige-codex-skin-studio", "themes");
  const themes = await listThemes({ roots: [themeRoot] });
  if (!themes.some((theme) => theme.id === themeId)) throw new Error("legacy theme 在 stable install 中不存在");
  return { themeId, recordMode: snapshot.mode, recordSha256: snapshot.sha256 };
}

async function inspectSchema2State(home) {
  const statePath = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio", "state.json");
  const state = await readStudioState(statePath);
  if (state === null) return { present: false };
  return {
    present: true,
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    persistenceEnabled: state.persistenceEnabled,
    selectedThemeId: state.selectedThemeId,
  };
}

export async function discoverLivePreflight({
  run = execFile,
  explicitStagePath = null,
  expectedCurrentAsarSha256 = null,
  expectedStageAsarSha256 = null,
  inspectApp = inspectMacApp,
  stageCandidates = null,
} = {}) {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") {
    throw new Error("live macOS acceptance 只允许在 macOS 当前用户执行");
  }
  const home = userInfo().homedir;
  const uid = process.getuid();
  const [{ app, identity, processIdentity }, renderers, legacy, existingController, legacyTheme, schema2] = await Promise.all([
    inspectAppAndProcess({ home, run }),
    inspectRenderers(),
    inspectLegacy({ home, uid, run }),
    inspectExistingController({ home, uid, run }),
    inspectLegacyTheme(home),
    inspectSchema2State(home),
  ]);
  const appSelection = await selectOfficialStage({
    currentAppPath: app.appPath,
    candidatePaths: stageCandidates ?? await discoverStageCandidates(),
    explicitStagePath,
    expectedCurrentAsarSha256,
    expectedStageAsarSha256,
    inspectApp,
  });
  if (
    appSelection.current.identity.executableSha256 !== identity.executableSha256
    || appSelection.current.identity.asarSha256 !== identity.asarSha256
  ) throw new Error("current app identity drifted during preflight");
  return {
    mutationCount: 0,
    appPath: app.appPath,
    app: appSelection,
    port: PORT,
    portOwnerMatchesCodex: true,
    process: processIdentity,
    ...renderers,
    legacy,
    existingController,
    legacyTheme,
    schema2,
  };
}

export async function runLiveMacAcceptance({
  preflightOnly = false,
  sequence = null,
  resultPath = null,
  reportPath = null,
  env = process.env,
} = {}) {
  const requestedSequence = sequence ?? env.HEIGE_LIVE_SEQUENCE;
  const configuration = parseLiveConfiguration({
    ...env,
    HEIGE_LIVE_PREFLIGHT_ONLY: preflightOnly ? "1" : env.HEIGE_LIVE_PREFLIGHT_ONLY,
    HEIGE_LIVE_SEQUENCE: requestedSequence,
    HEIGE_LIVE_RESULT_JSON: resultPath ?? env.HEIGE_LIVE_RESULT_JSON,
    HEIGE_LIVE_REPORT_MD: reportPath ?? env.HEIGE_LIVE_REPORT_MD,
  });
  if (!configuration.enabled) throw new Error("live acceptance is not explicitly enabled");
  validateLiveOutputPaths(configuration);
  if (configuration.mode === "mutation" && requestedSequence !== LIVE_SEQUENCE) {
    throw new Error("unsupported live acceptance sequence");
  }
  let result;
  try {
    const preflight = await discoverLivePreflight(configuration);
    if (configuration.mode === "preflight") result = { status: "PREFLIGHT_PASS", preflight };
    else {
      const error = new Error("LIVE_MUTATION_NOT_IMPLEMENTED");
      error.code = "LIVE_MUTATION_NOT_IMPLEMENTED";
      throw error;
    }
  } catch (error) {
    result = {
      status: "FAIL",
      failedAt: new Date().toISOString(),
      failure: { code: error?.code ?? "LIVE_ACCEPTANCE_FAILED", message: error?.message ?? String(error) },
    };
    if (configuration.resultPath) {
      await atomicWriteAcceptanceEvidence(configuration.resultPath, result, { privateDirectory: true });
    }
    throw error;
  }
  if (configuration.resultPath) {
    await atomicWriteAcceptanceEvidence(configuration.resultPath, result, { privateDirectory: true });
  }
  if (configuration.reportPath) {
    await atomicWriteAcceptanceEvidence(configuration.reportPath, [
      "# macOS live acceptance",
      "",
      `Status: ${result.status}`,
      "",
      `Recorded: ${new Date().toISOString()}`,
    ].join("\n"));
    result.reportWritten = true;
  }
  return result;
}

test("live macOS migration and option 1 lifecycle", {
  skip: process.env.HEIGE_RUN_LIVE_MACOS !== "1" && "requires explicit live macOS opt-in",
  timeout: 30 * 60 * 1000,
}, async () => {
  const result = await runLiveMacAcceptance({
    preflightOnly: process.env.HEIGE_LIVE_PREFLIGHT_ONLY === "1",
    sequence: process.env.HEIGE_LIVE_SEQUENCE,
    resultPath: process.env.HEIGE_LIVE_RESULT_JSON,
    reportPath: process.env.HEIGE_LIVE_REPORT_MD,
  });
  assert.equal(result.preflight.rendererOrigin, "app://-");
  assert.equal(result.preflight.portOwnerMatchesCodex, true);
  if (process.env.HEIGE_LIVE_PREFLIGHT_ONLY === "1") {
    assert.equal(result.preflight.mutationCount, 0);
    assert.equal(result.status, "PREFLIGHT_PASS");
    return;
  }
  assert.equal(result.rollback.status, "PASS");
  assert.equal(result.clean.status, "PASS");
});
