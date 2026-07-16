import { randomBytes as cryptoRandomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  DEFAULT_THEME_ID,
  NATIVE_THEME_ID,
  STATE_SCHEMA_VERSION,
} from "./constants.mjs";
import { sameProcessIdentity } from "./codex-app.mjs";

const STATE_KEYS = [
  "schemaVersion",
  "persistenceEnabled",
  "selectedThemeId",
  "lastNonNativeThemeId",
  "controlToken",
  "lastTransitionNonce",
  "revision",
];
const SESSION_KEYS = [
  "schemaVersion",
  "mode",
  "process",
  "activeThemeId",
  "keepUntilProcessExit",
];
const TRANSITION_KEYS = [
  "schemaVersion",
  "operation",
  "expectedRevision",
  "process",
  "desiredPersistenceEnabled",
  "nonce",
  "stage",
];
const SESSION_MODES = new Set(["active", "native", "paused", "restoring", "error"]);
const TRANSITION_OPERATIONS = new Map([
  ["disable-persistence", false],
  ["enable-persistence", true],
]);
const TRANSITION_STAGES = new Set(["prepared", "state-committed", "session-committed"]);
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TRANSITION_NONCE = /^[A-Za-z0-9_-]{1,256}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  if (!isRecord(value)) throw new Error(`${label}必须是对象`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label}字段不完整或包含未知字段`);
  }
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function requireLeaseForPaths(lease, paths) {
  if (
    lease === null ||
    typeof lease !== "object" ||
    typeof lease.lockPath !== "string" ||
    typeof lease.assertOwned !== "function"
  ) {
    throw new Error("an operation lease with assertOwned() is required");
  }
  const parent = dirname(paths[0]);
  if (
    dirname(lease.lockPath) !== parent ||
    paths.some((path) => dirname(path) !== parent)
  ) {
    throw new Error("operation lease and protected files must share the same state directory");
  }
  return lease;
}

async function assertLeaseOwned(lease) {
  await lease.assertOwned();
}

function leaseWriteOptions(lease) {
  return { beforeCommit: () => assertLeaseOwned(lease) };
}

function validateThemeId(value, { allowNative = false, field = "主题 ID" } = {}) {
  if (allowNative && value === NATIVE_THEME_ID) return value;
  if (typeof value !== "string" || !THEME_ID.test(value)) {
    throw new Error(`${field}格式无效`);
  }
  return value;
}

function validateControlToken(value) {
  if (
    typeof value !== "string" ||
    !CONTROL_TOKEN.test(value) ||
    Buffer.from(value, "base64url").length !== 32 ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  ) {
    throw new Error("controlToken 必须是 32 字节无填充 base64url");
  }
  return value;
}

function validateNonce(value, { allowNull = false } = {}) {
  if (allowNull && value === null) return null;
  if (typeof value !== "string" || !TRANSITION_NONCE.test(value)) {
    throw new Error("transition nonce 必须是安全的非空标识符");
  }
  return value;
}

function validateProcessIdentity(value, { allowNull = false } = {}) {
  if (allowNull && value === null) return null;
  assertExactKeys(value, ["pid", "executablePath", "startedAt"], "进程身份");
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error("进程 pid 必须是正整数");
  }
  if (typeof value.executablePath !== "string" || !value.executablePath) {
    throw new Error("进程 executablePath 必须是非空字符串");
  }
  if (typeof value.startedAt !== "string" || !value.startedAt) {
    throw new Error("进程 startedAt 必须是非空字符串");
  }
  return {
    pid: value.pid,
    executablePath: value.executablePath,
    startedAt: value.startedAt,
  };
}

function statePathError(code, message, cause = undefined) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function enforcePosixFileSecurity(stats, kind) {
  // Windows mode bits are not ACL evidence. Its platform adapter must protect and
  // verify the state directory ACL before Node starts; this reader still checks
  // link, file type, and opened-inode identity on every platform.
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  if (stats.uid !== process.getuid()) {
    throw statePathError(
      kind === "file" ? "STATE_FILE_OWNER_INVALID" : "STATE_PARENT_OWNER_INVALID",
      `${kind === "file" ? "状态文件" : "状态目录"}不属于当前用户`,
    );
  }
  const expectedMode = kind === "file" ? 0o600 : 0o700;
  if ((stats.mode & 0o7777) !== expectedMode) {
    throw statePathError(
      kind === "file" ? "STATE_FILE_MODE_INVALID" : "STATE_PARENT_MODE_INVALID",
      `${kind === "file" ? "状态文件" : "状态目录"}权限必须是 ${expectedMode.toString(8)}`,
    );
  }
}

async function inspectPrivateJsonPath(path) {
  let fileStats;
  try {
    fileStats = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (fileStats.isSymbolicLink()) {
    throw statePathError("STATE_PATH_SYMLINK", "状态文件不得是符号链接");
  }
  if (!fileStats.isFile()) {
    throw statePathError("STATE_FILE_TYPE_INVALID", "状态路径必须是普通文件");
  }

  const parentStats = await lstat(dirname(path));
  if (parentStats.isSymbolicLink()) {
    throw statePathError("STATE_PARENT_SYMLINK", "状态目录不得是符号链接");
  }
  if (!parentStats.isDirectory()) {
    throw statePathError("STATE_PARENT_TYPE_INVALID", "状态文件父路径必须是目录");
  }
  enforcePosixFileSecurity(parentStats, "parent");
  enforcePosixFileSecurity(fileStats, "file");
  return fileStats;
}

async function ensurePrivateParent(path) {
  const parent = dirname(path);
  const missing = [];
  let existing = parent;

  while (true) {
    try {
      const stats = await lstat(existing);
      if (stats.isSymbolicLink()) {
        throw statePathError("STATE_PARENT_SYMLINK", "状态目录不得是符号链接");
      }
      if (!stats.isDirectory()) {
        throw statePathError("STATE_PARENT_TYPE_INVALID", "状态文件父路径必须是目录");
      }
      if (
        process.platform !== "win32" &&
        typeof process.getuid === "function" &&
        stats.uid !== process.getuid()
      ) {
        throw statePathError("STATE_PARENT_OWNER_INVALID", "状态目录不属于当前用户");
      }
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(existing);
      const next = dirname(existing);
      if (next === existing) throw error;
      existing = next;
    }
  }

  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stats = await lstat(directory);
    if (stats.isSymbolicLink()) {
      throw statePathError("STATE_PARENT_SYMLINK", "状态目录不得是符号链接");
    }
    if (!stats.isDirectory()) {
      throw statePathError("STATE_PARENT_TYPE_INVALID", "状态文件父路径必须是目录");
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      stats.uid !== process.getuid()
    ) {
      throw statePathError("STATE_PARENT_OWNER_INVALID", "状态目录不属于当前用户");
    }
    await chmod(directory, 0o700);
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
  }

  await chmod(parent, 0o700);
  await syncDirectory(parent);
  return parent;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWriteJson(path, value, { faultAt, beforeCommit } = {}) {
  if (faultAt !== undefined && faultAt !== "after-temp-sync") {
    throw new Error("unknown state write fault injection point");
  }
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    throw new Error("beforeCommit 必须是函数");
  }
  const parent = await ensurePrivateParent(path);
  const temporary = join(
    parent,
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let handle = null;
  let renamed = false;

  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    if (faultAt === "after-temp-sync") {
      throw statePathError(
        "FAULT_AFTER_TEMP_SYNC",
        "injected crash after temporary state file sync",
      );
    }
    // The lock cannot be reclaimed while its exact process identity is live.
    // Keep this check immediately before rename so staging never widens that boundary.
    if (beforeCommit !== undefined) await beforeCommit();

    await rename(temporary, path);
    renamed = true;
    await syncDirectory(parent);
    return value;
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => {});
    if (!renamed) await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(path, { damagedMessage, validate }) {
  const inspected = await inspectPrivateJsonPath(path);
  if (inspected === null) return null;

  let handle;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ELOOP") {
      throw statePathError("STATE_FILE_CHANGED", "状态文件在安全检查后发生变化", error);
    }
    throw error;
  }

  let raw;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== inspected.dev ||
      opened.ino !== inspected.ino
    ) {
      throw statePathError("STATE_FILE_CHANGED", "状态文件在安全检查后发生变化");
    }
    enforcePosixFileSecurity(opened, "file");
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(damagedMessage, { cause });
  }
  return validate(parsed);
}

export function validateStudioState(value) {
  if (!isRecord(value)) throw new Error("状态文件必须是对象");
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`不支持的状态 schemaVersion：${value.schemaVersion}`);
  }
  assertExactKeys(value, STATE_KEYS, "状态文件");
  if (typeof value.persistenceEnabled !== "boolean") {
    throw new Error("persistenceEnabled 必须是布尔值");
  }
  const selectedThemeId = validateThemeId(value.selectedThemeId, {
    allowNative: true,
    field: "selectedThemeId",
  });
  const lastNonNativeThemeId = validateThemeId(value.lastNonNativeThemeId, {
    field: "lastNonNativeThemeId",
  });
  const controlToken = validateControlToken(value.controlToken);
  const lastTransitionNonce = validateNonce(value.lastTransitionNonce, { allowNull: true });
  if (!isNonNegativeInteger(value.revision)) {
    throw new Error("revision 必须是非负安全整数");
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    persistenceEnabled: value.persistenceEnabled,
    selectedThemeId,
    lastNonNativeThemeId,
    controlToken,
    lastTransitionNonce,
    revision: value.revision,
  };
}

export function createDefaultStudioState({ themeId, token }) {
  return validateStudioState({
    schemaVersion: STATE_SCHEMA_VERSION,
    persistenceEnabled: false,
    selectedThemeId: themeId,
    lastNonNativeThemeId: themeId,
    controlToken: token,
    lastTransitionNonce: null,
    revision: 0,
  });
}

export async function readStudioState(path) {
  return readJson(path, {
    damagedMessage: "状态文件损坏：不是有效 JSON",
    validate: validateStudioState,
  });
}

export async function writeStudioState(path, value, options = undefined) {
  const state = validateStudioState(value);
  return atomicWriteJson(path, state, options);
}

async function readRequiredStudioState(path) {
  const state = await readStudioState(path);
  if (state === null) throw new Error("状态文件不存在");
  return state;
}

export class StateConflictError extends Error {
  constructor(state) {
    super(`状态 revision 冲突，当前为 ${state.revision}`);
    Object.defineProperty(this, "name", {
      configurable: true,
      value: "StateConflictError",
    });
    this.code = "REVISION_CONFLICT";
    this.revision = state.revision;
    this.persistenceEnabled = state.persistenceEnabled;
  }
}

export async function compareAndUpdateStudioState(
  path,
  { lease, expectedRevision, mutate } = {},
) {
  requireLeaseForPaths(lease, [path]);
  if (!isNonNegativeInteger(expectedRevision)) {
    throw new Error("expectedRevision 必须是非负安全整数");
  }
  if (typeof mutate !== "function") throw new Error("mutate 必须是函数");

  await assertLeaseOwned(lease);
  const current = await readRequiredStudioState(path);
  await assertLeaseOwned(lease);
  if (current.revision !== expectedRevision) throw new StateConflictError(current);
  const mutated = mutate(structuredClone(current));
  const next = validateStudioState({
    ...mutated,
    revision: current.revision + 1,
  });
  await assertLeaseOwned(lease);
  return writeStudioState(path, next, leaseWriteOptions(lease));
}

function generateControlToken(randomBytes) {
  const entropy = randomBytes(32);
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 32) {
    throw new Error("controlToken 随机源必须返回 32 字节");
  }
  return Buffer.from(entropy).toString("base64url");
}

export async function migrateLegacyState({
  statePath,
  lease,
  legacyThemePath,
  legacyAgentLoaded,
  themeExists,
  defaultThemeId = DEFAULT_THEME_ID,
  randomBytes = cryptoRandomBytes,
}) {
  requireLeaseForPaths(lease, [statePath]);
  await assertLeaseOwned(lease);
  const existing = await readStudioState(statePath);
  await assertLeaseOwned(lease);
  if (existing !== null) {
    return { state: existing, migratedFrom: null };
  }
  if (typeof legacyAgentLoaded !== "boolean") {
    throw new Error("legacyAgentLoaded 必须是布尔值");
  }
  if (typeof themeExists !== "function") throw new Error("themeExists 必须是函数");

  let themeId = defaultThemeId;
  let persistenceEnabled = false;
  let revision = 0;
  let migratedFrom = null;

  if (legacyAgentLoaded) {
    let legacyTheme;
    try {
      legacyTheme = await readFile(legacyThemePath, "utf8");
    } catch (cause) {
      throw new Error("旧版主题状态无效：无法读取主题文件", { cause });
    }
    themeId = legacyTheme.trim();
    try {
      validateThemeId(themeId, { field: "旧版主题 ID" });
    } catch (cause) {
      throw new Error("旧版主题状态无效：主题 ID 格式错误", { cause });
    }
    if (await themeExists(themeId) !== true) {
      throw new Error("旧版主题状态无效：主题不存在");
    }
    persistenceEnabled = true;
    revision = 1;
    migratedFrom = "watchdog";
  } else {
    validateThemeId(themeId, { field: "默认主题 ID" });
    if (await themeExists(themeId) !== true) {
      throw new Error("默认主题不存在，拒绝创建状态");
    }
  }

  await assertLeaseOwned(lease);
  const token = generateControlToken(randomBytes);
  const state = validateStudioState({
    ...createDefaultStudioState({ themeId, token }),
    persistenceEnabled,
    revision,
  });
  await writeStudioState(statePath, state, leaseWriteOptions(lease));
  return { state, migratedFrom };
}

export function validateSessionState(value) {
  if (!isRecord(value)) throw new Error("session 状态必须是对象");
  if (value.schemaVersion !== 1) {
    throw new Error(`不支持的 session schemaVersion：${value.schemaVersion}`);
  }
  assertExactKeys(value, SESSION_KEYS, "session 状态");
  if (!SESSION_MODES.has(value.mode)) throw new Error("session mode 无效");
  const processIdentity = validateProcessIdentity(value.process, { allowNull: true });
  const activeThemeId = value.activeThemeId === null
    ? null
    : validateThemeId(value.activeThemeId, { field: "activeThemeId" });
  if (typeof value.keepUntilProcessExit !== "boolean") {
    throw new Error("keepUntilProcessExit 必须是布尔值");
  }
  if (value.mode === "active" && (processIdentity === null || activeThemeId === null)) {
    throw new Error("session mode invariant: active 必须绑定进程与活动主题");
  }
  if (value.mode === "paused" && (processIdentity === null || activeThemeId !== null)) {
    throw new Error("session mode invariant: paused 必须绑定进程且不得包含活动主题");
  }
  if (value.mode === "native" && activeThemeId !== null) {
    throw new Error("session mode invariant: native 不得包含活动主题");
  }
  if (
    value.mode === "restoring" &&
    (processIdentity === null || activeThemeId !== null || value.keepUntilProcessExit)
  ) {
    throw new Error("session mode invariant: restoring 必须绑定进程并停止活动主题与会话保留");
  }
  if (value.mode === "error" && (activeThemeId !== null || value.keepUntilProcessExit)) {
    throw new Error("session mode invariant: error 不得保留活动主题或会话注入");
  }
  if (value.keepUntilProcessExit && processIdentity === null) {
    throw new Error("keepUntilProcessExit 需要精确进程身份");
  }
  return {
    schemaVersion: 1,
    mode: value.mode,
    process: processIdentity,
    activeThemeId,
    keepUntilProcessExit: value.keepUntilProcessExit,
  };
}

export async function readSessionState(path) {
  return readJson(path, {
    damagedMessage: "session 状态文件损坏：不是有效 JSON",
    validate: validateSessionState,
  });
}

export async function writeSessionState(path, value, options = undefined) {
  const session = validateSessionState(value);
  return atomicWriteJson(path, session, options);
}

export function validateTransitionJournal(value) {
  if (!isRecord(value)) throw new Error("迁移日志必须是对象");
  if (value.schemaVersion !== 1) {
    throw new Error(`不支持的迁移日志 schemaVersion：${value.schemaVersion}`);
  }
  assertExactKeys(value, TRANSITION_KEYS, "迁移日志");
  if (!TRANSITION_OPERATIONS.has(value.operation)) {
    throw new Error("迁移日志 operation 无效");
  }
  if (!isNonNegativeInteger(value.expectedRevision)) {
    throw new Error("迁移日志 expectedRevision 必须是非负安全整数");
  }
  const processIdentity = validateProcessIdentity(value.process);
  if (typeof value.desiredPersistenceEnabled !== "boolean") {
    throw new Error("迁移日志 desiredPersistenceEnabled 必须是布尔值");
  }
  if (TRANSITION_OPERATIONS.get(value.operation) !== value.desiredPersistenceEnabled) {
    throw new Error("迁移日志 operation 与目标状态不一致");
  }
  const nonce = validateNonce(value.nonce);
  if (!TRANSITION_STAGES.has(value.stage)) throw new Error("迁移日志 stage 无效");
  return {
    schemaVersion: 1,
    operation: value.operation,
    expectedRevision: value.expectedRevision,
    process: processIdentity,
    desiredPersistenceEnabled: value.desiredPersistenceEnabled,
    nonce,
    stage: value.stage,
  };
}

export async function readTransitionJournal(path) {
  return readJson(path, {
    damagedMessage: "迁移日志损坏：不是有效 JSON",
    validate: validateTransitionJournal,
  });
}

export async function writeTransitionJournal(path, value, options = undefined) {
  const journal = validateTransitionJournal(value);
  return atomicWriteJson(path, journal, options);
}

export async function clearTransitionJournal(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await syncDirectory(dirname(path));
}

export class TransitionConflictError extends Error {
  constructor(state, _journal) {
    super("状态迁移冲突：revision、目标状态或 nonce 不匹配");
    Object.defineProperty(this, "name", {
      configurable: true,
      value: "TransitionConflictError",
    });
    this.code = "TRANSITION_CONFLICT";
    this.revision = state.revision;
    this.persistenceEnabled = state.persistenceEnabled;
  }
}

function isCommittedTransition(state, journal) {
  return state.revision === journal.expectedRevision + 1 &&
    state.persistenceEnabled === journal.desiredPersistenceEnabled &&
    state.lastTransitionNonce === journal.nonce;
}

function sessionForTransition(state, journal, currentProcess) {
  const processStillRunning = currentProcess !== null &&
    sameProcessIdentity(journal.process, currentProcess);
  const selectedNative = state.selectedThemeId === NATIVE_THEME_ID;

  if (journal.operation === "disable-persistence" && processStillRunning) {
    return {
      schemaVersion: 1,
      mode: selectedNative ? "native" : "active",
      process: journal.process,
      activeThemeId: selectedNative ? null : state.selectedThemeId,
      keepUntilProcessExit: true,
    };
  }

  if (journal.operation === "enable-persistence" && processStillRunning) {
    return {
      schemaVersion: 1,
      mode: selectedNative ? "native" : "active",
      process: journal.process,
      activeThemeId: selectedNative ? null : state.selectedThemeId,
      keepUntilProcessExit: false,
    };
  }

  return {
    schemaVersion: 1,
    mode: "native",
    process: null,
    activeThemeId: null,
    keepUntilProcessExit: false,
  };
}

export async function recoverStateTransition({
  statePath,
  sessionPath,
  transitionPath,
  lease,
  currentProcess,
}) {
  requireLeaseForPaths(lease, [statePath, sessionPath, transitionPath]);
  await assertLeaseOwned(lease);
  let journal = await readTransitionJournal(transitionPath);
  await assertLeaseOwned(lease);
  if (journal === null) {
    const state = await readStudioState(statePath);
    const session = await readSessionState(sessionPath);
    await assertLeaseOwned(lease);
    return {
      state,
      session,
      recovered: false,
    };
  }
  if (currentProcess !== null && currentProcess !== undefined) {
    currentProcess = validateProcessIdentity(currentProcess);
  } else {
    currentProcess = null;
  }

  let state = await readRequiredStudioState(statePath);
  await assertLeaseOwned(lease);
  if (journal.stage === "prepared" && state.revision === journal.expectedRevision) {
    state = await compareAndUpdateStudioState(statePath, {
      lease,
      expectedRevision: journal.expectedRevision,
      mutate: (current) => ({
        ...current,
        persistenceEnabled: journal.desiredPersistenceEnabled,
        lastTransitionNonce: journal.nonce,
      }),
    });
    await assertLeaseOwned(lease);
    journal = await writeTransitionJournal(transitionPath, {
      ...journal,
      stage: "state-committed",
    }, leaseWriteOptions(lease));
  } else if (journal.stage === "prepared" && isCommittedTransition(state, journal)) {
    await assertLeaseOwned(lease);
    journal = await writeTransitionJournal(transitionPath, {
      ...journal,
      stage: "state-committed",
    }, leaseWriteOptions(lease));
  } else if (journal.stage === "prepared") {
    throw new TransitionConflictError(state, journal);
  }

  if (!isCommittedTransition(state, journal)) {
    throw new TransitionConflictError(state, journal);
  }

  const session = sessionForTransition(state, journal, currentProcess);
  await assertLeaseOwned(lease);
  await writeSessionState(sessionPath, session, leaseWriteOptions(lease));
  if (journal.stage !== "session-committed") {
    await assertLeaseOwned(lease);
    journal = await writeTransitionJournal(transitionPath, {
      ...journal,
      stage: "session-committed",
    }, leaseWriteOptions(lease));
  }
  await assertLeaseOwned(lease);
  await clearTransitionJournal(transitionPath);
  return { state, session, recovered: true };
}
