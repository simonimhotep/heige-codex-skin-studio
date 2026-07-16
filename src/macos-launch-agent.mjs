import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

export const CONTROLLER_LAUNCH_AGENT_LABEL = "com.heige.codex-skin-controller";
export const LEGACY_WATCHDOG_LABEL = "com.heige.codex-skin-watchdog";

const TEST_LABEL_PREFIX = `${CONTROLLER_LAUNCH_AGENT_LABEL}.test.`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NOT_FOUND_CODES = new Set([3, 113, "3", "113"]);

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function assertLabel(label) {
  if (typeof label !== "string" || !LABEL_PATTERN.test(label)) {
    throw new TypeError("LaunchAgent label is invalid");
  }
}

function assertMutationLabel(label, testMode) {
  assertLabel(label);
  if (testMode) {
    if (label === CONTROLLER_LAUNCH_AGENT_LABEL || label === LEGACY_WATCHDOG_LABEL) {
      throw new Error("test mode refuses a production label");
    }
    const suffix = label.startsWith(TEST_LABEL_PREFIX)
      ? label.slice(TEST_LABEL_PREFIX.length)
      : "";
    if (!UUID_PATTERN.test(suffix)) {
      throw new Error("test mode requires a random UUID controller label");
    }
    return;
  }
  if (label !== CONTROLLER_LAUNCH_AGENT_LABEL) {
    throw new Error(`production controller label must be ${CONTROLLER_LAUNCH_AGENT_LABEL}`);
  }
}

function assertProductionLocations(options) {
  if (options.testMode === true) return;
  const canonicalLaunchAgentsDir = join(options.home, "Library", "LaunchAgents");
  const canonicalStateDir = join(
    options.home,
    "Library",
    "Application Support",
    "HeiGeCodexSkinStudio",
  );
  const canonicalInstallRoot = join(
    options.home,
    ".codex",
    "heige-codex-skin-studio",
  );
  if (
    resolve(options.launchAgentsDir) !== resolve(canonicalLaunchAgentsDir) ||
    resolve(options.stateDir) !== resolve(canonicalStateDir) ||
    resolve(options.stableInstallRoot) !== resolve(canonicalInstallRoot)
  ) {
    throw new Error("production LaunchAgent must use canonical production locations");
  }
}

function assertAbsolutePath(path, name) {
  if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
}

function isWithin(root, candidate) {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function isTemporaryPath(path) {
  const roots = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp"];
  return roots.some((root) => isWithin(root, path));
}

function normalizeProgramArguments(options) {
  const explicit = options.programArguments;
  const programArguments = explicit ?? [options.nodePath, options.controllerPath, "controller"];
  if (!Array.isArray(programArguments) || programArguments.length === 0) {
    throw new TypeError("programArguments must be a non-empty array");
  }
  for (const argument of programArguments) {
    if (typeof argument !== "string" || argument.length === 0 || argument.includes("\0")) {
      throw new TypeError("programArguments must contain non-empty strings");
    }
  }
  assertAbsolutePath(programArguments[0], "ProgramArguments[0]");
  if (programArguments[1]?.includes(sep)) {
    assertAbsolutePath(programArguments[1], "ProgramArguments[1]");
  }
  if (!options.testMode) {
    assertAbsolutePath(options.stableInstallRoot, "stableInstallRoot");
    const expected = [options.nodePath, options.controllerPath, "controller"];
    if (
      programArguments.length !== expected.length ||
      programArguments.some((value, index) => value !== expected[index]) ||
      resolve(options.controllerPath) !== resolve(join(options.stableInstallRoot, "src", "cli.mjs"))
    ) {
      throw new Error("production LaunchAgent must use the stable controller entrypoint");
    }
  }
  return [...programArguments];
}

function normalizedOptions(options = {}) {
  const home = options.home ?? homedir();
  const label = options.label ?? CONTROLLER_LAUNCH_AGENT_LABEL;
  const launchAgentsDir = options.launchAgentsDir ?? join(home, "Library", "LaunchAgents");
  const stateDir = options.stateDir ?? join(
    home,
    "Library",
    "Application Support",
    "HeiGeCodexSkinStudio",
  );
  const stableInstallRoot = options.stableInstallRoot ?? join(
    home,
    ".codex",
    "heige-codex-skin-studio",
  );
  const controllerPath = options.controllerPath ?? join(stableInstallRoot, "src", "cli.mjs");
  const nodePath = options.nodePath ?? process.execPath;
  assertAbsolutePath(home, "home");
  assertAbsolutePath(launchAgentsDir, "launchAgentsDir");
  assertAbsolutePath(stateDir, "stateDir");
  return {
    ...options,
    home,
    label,
    launchAgentsDir,
    stateDir,
    stableInstallRoot,
    controllerPath,
    nodePath,
    plistPath: join(launchAgentsDir, `${label}.plist`),
    processUid: options.processUid ?? process.getuid?.(),
    execFile: options.execFile ?? execFileAsync,
    fs: options.fs ?? nodeFs,
  };
}

function launchDomain(options) {
  if (!Number.isInteger(options.processUid) || options.processUid < 0) {
    throw new Error("a numeric macOS uid is required");
  }
  return `gui/${options.processUid}`;
}

function launchTarget(options, label = options.label) {
  return `${launchDomain(options)}/${label}`;
}

async function command(options, file, args) {
  return options.execFile(file, args);
}

function isLaunchctlNotFound(error) {
  return NOT_FOUND_CODES.has(error?.code) ||
    /could not find service|service.*not found|no such process/i.test(
      `${error?.message ?? ""}\n${error?.stderr ?? ""}`,
    );
}

async function isLoaded(options, label = options.label) {
  try {
    await command(options, "/bin/launchctl", ["print", launchTarget(options, label)]);
    return true;
  } catch (error) {
    if (isLaunchctlNotFound(error)) return false;
    throw error;
  }
}

async function bootstrap(options, label, plistPath) {
  await command(options, "/bin/launchctl", ["bootstrap", launchDomain(options), plistPath]);
  if (!(await isLoaded(options, label))) {
    const error = new Error(`LaunchAgent ${label} was not loaded after bootstrap`);
    error.code = "LAUNCH_AGENT_NOT_LOADED";
    throw error;
  }
}

async function bootout(options, label, { knownLoaded = false } = {}) {
  if (!knownLoaded && !(await isLoaded(options, label))) return false;
  await command(options, "/bin/launchctl", ["bootout", launchTarget(options, label)]);
  if (await isLoaded(options, label)) {
    const error = new Error(`LaunchAgent ${label} remained loaded after bootout`);
    error.code = "LAUNCH_AGENT_STILL_LOADED";
    throw error;
  }
  return true;
}

async function syncDirectory(fs, path) {
  const handle = await fs.open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(fs, path) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`private state path is not a real directory: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`private state directory has a different owner: ${path}`);
  }
  await fs.chmod(path, 0o700);
  const secured = await fs.lstat(path);
  if ((secured.mode & 0o777) !== 0o700) {
    throw new Error(`private state directory mode is not 0700: ${path}`);
  }
}

async function ensureDirectory(fs, path) {
  await fs.mkdir(path, { recursive: true });
  const info = await fs.lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`directory path is not a real directory: ${path}`);
  }
}

async function assertCanonicalDirectory(fs, path) {
  const actual = await fs.realpath(path);
  if (actual !== resolve(path)) {
    throw new Error(`directory resolves outside its canonical path: ${path}`);
  }
}

async function atomicWrite(fs, path, bytes, mode = 0o600) {
  const parent = dirname(path);
  await ensureDirectory(fs, parent);
  const temporaryPath = `${path}.tmp.${randomUUID()}`;
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.chmod(temporaryPath, mode);
    await fs.rename(temporaryPath, path);
    await fs.chmod(path, mode);
    await syncDirectory(fs, parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function removeAndSync(fs, path) {
  try {
    await fs.rm(path);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  await syncDirectory(fs, dirname(path));
  return true;
}

async function snapshotFile(fs, path, { required = false } = {}) {
  let info;
  try {
    info = await fs.lstat(path);
  } catch (error) {
    if (error.code === "ENOENT" && !required) return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`refusing a non-regular file: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`refusing a file with a different owner: ${path}`);
  }
  return {
    bytes: await fs.readFile(path),
    mode: info.mode & 0o777,
  };
}

async function readPlist(options, path) {
  if (options.readPlist) return options.readPlist(path);
  const { stdout } = await command(options, "/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    path,
  ]);
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`plutil returned invalid JSON for ${path}`, { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`plist root is not a dictionary: ${path}`);
  }
  return value;
}

async function lintPlist(options, path) {
  await command(options, "/usr/bin/plutil", ["-lint", path]);
}

function safeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "ERROR",
    message: String(error?.message ?? error),
  };
}

function assertControllerPlistAttribution(options, plist, programArguments) {
  const expectedStdout = join(options.stateDir, "controller.log");
  const expectedStderr = join(options.stateDir, "controller.error.log");
  const matchesArguments = Array.isArray(plist.ProgramArguments) &&
    plist.ProgramArguments.length === programArguments.length &&
    plist.ProgramArguments.every((value, index) => value === programArguments[index]);
  if (
    plist.Label !== options.label ||
    !matchesArguments ||
    plist.RunAtLoad !== true ||
    plist.KeepAlive?.SuccessfulExit !== false ||
    plist.ProcessType !== "Background" ||
    plist.StandardOutPath !== expectedStdout ||
    plist.StandardErrorPath !== expectedStderr
  ) {
    const error = new Error("existing controller plist attribution failed");
    error.code = "CONTROLLER_PRESTATE_INVALID";
    throw error;
  }
}

function injectedFailure(phase) {
  const error = new Error(`INJECTED_MIGRATION_FAILURE at ${phase}`);
  error.code = "INJECTED_MIGRATION_FAILURE";
  error.phase = phase;
  return error;
}

function inject(options, phase, { rollback = false } = {}) {
  const selected = rollback ? options.rollbackFaultAt : options.faultAt;
  if (selected === phase) throw injectedFailure(phase);
}

async function writeJournal(options, journalPath, journal) {
  await atomicWrite(
    options.fs,
    journalPath,
    `${JSON.stringify(journal, null, 2)}\n`,
    0o600,
  );
}

export function renderControllerPlist({
  label = CONTROLLER_LAUNCH_AGENT_LABEL,
  programArguments,
  nodePath,
  controllerPath,
  stateDir,
} = {}) {
  assertLabel(label);
  assertAbsolutePath(stateDir, "stateDir");
  const args = programArguments ?? [nodePath, controllerPath, "controller"];
  if (!Array.isArray(args) || args.length === 0) {
    throw new TypeError("programArguments must be a non-empty array");
  }
  for (const argument of args) {
    if (typeof argument !== "string" || argument.length === 0 || argument.includes("\0")) {
      throw new TypeError("programArguments must contain non-empty strings");
    }
  }
  assertAbsolutePath(args[0], "ProgramArguments[0]");
  if (args[1]?.includes(sep)) assertAbsolutePath(args[1], "ProgramArguments[1]");

  const stdoutPath = join(stateDir, "controller.log");
  const stderrPath = join(stateDir, "controller.error.log");
  const argumentXml = args.map((argument) => `        <string>${xmlEscape(argument)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

export async function inspectLaunchAgent(input = {}) {
  const options = normalizedOptions(input);
  assertLabel(options.label);
  launchDomain(options);
  const snapshot = await snapshotFile(options.fs, options.plistPath);
  const plist = snapshot ? await readPlist(options, options.plistPath) : null;
  return {
    label: options.label,
    plistPath: options.plistPath,
    plistExists: snapshot !== null,
    plistLabel: plist?.Label ?? null,
    loaded: await isLoaded(options),
  };
}

async function restoreRegistration(options, snapshot, loadedBefore, rollbackErrors) {
  try {
    if (await isLoaded(options)) await bootout(options, options.label);
  } catch (error) {
    rollbackErrors.push(error);
  }
  try {
    if (snapshot) {
      await atomicWrite(options.fs, options.plistPath, snapshot.bytes, snapshot.mode);
    } else {
      await removeAndSync(options.fs, options.plistPath);
    }
  } catch (error) {
    rollbackErrors.push(error);
  }
  if (loadedBefore && snapshot) {
    try {
      await bootstrap(options, options.label, options.plistPath);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
}

export async function registerControllerAgent(input = {}) {
  const options = normalizedOptions(input);
  assertMutationLabel(options.label, options.testMode === true);
  assertProductionLocations(options);
  launchDomain(options);
  const programArguments = normalizeProgramArguments(options);
  await ensurePrivateDirectory(options.fs, options.stateDir);
  await ensureDirectory(options.fs, options.launchAgentsDir);
  await assertCanonicalDirectory(options.fs, options.launchAgentsDir);

  const previous = await snapshotFile(options.fs, options.plistPath);
  const loadedBefore = await isLoaded(options);
  if (loadedBefore && !previous) {
    const error = new Error("loaded controller has no restorable canonical plist");
    error.code = "CONTROLLER_PRESTATE_INVALID";
    throw error;
  }
  if (previous) {
    assertControllerPlistAttribution(
      options,
      await readPlist(options, options.plistPath),
      programArguments,
    );
  }
  const plist = renderControllerPlist({
    label: options.label,
    programArguments,
    stateDir: options.stateDir,
  });
  const stagedPath = `${options.plistPath}.staged.${randomUUID()}`;

  try {
    await atomicWrite(options.fs, stagedPath, plist, 0o600);
    await lintPlist(options, stagedPath);
  } catch (error) {
    await options.fs.rm(stagedPath, { force: true }).catch(() => {});
    throw error;
  }

  try {
    if (loadedBefore) await bootout(options, options.label);
    await publishStagedPlist(options, stagedPath, options.plistPath);
    await bootstrap(options, options.label, options.plistPath);
  } catch (primaryError) {
    const rollbackErrors = [];
    await restoreRegistration(options, previous, loadedBefore, rollbackErrors);
    if (rollbackErrors.length > 0) {
      const error = new AggregateError(
        [primaryError, ...rollbackErrors],
        `LaunchAgent registration failed and rollback also failed: ${primaryError.message}`,
      );
      error.code = "REGISTRATION_ROLLBACK_FAILED";
      error.primaryError = primaryError;
      error.rollbackErrors = rollbackErrors;
      throw error;
    }
    throw primaryError;
  } finally {
    await options.fs.rm(stagedPath, { force: true }).catch(() => {});
  }

  return {
    label: options.label,
    plistPath: options.plistPath,
    loaded: true,
  };
}

export async function unregisterControllerAgent(input = {}) {
  const options = normalizedOptions(input);
  assertMutationLabel(options.label, options.testMode === true);
  assertProductionLocations(options);
  launchDomain(options);
  const inspection = await inspectLaunchAgent(options);
  if (inspection.plistExists && inspection.plistLabel !== options.label) {
    const error = new Error(`adapter does not own plist ${options.plistPath}`);
    error.code = "PLIST_ATTRIBUTION_FAILED";
    throw error;
  }
  if (inspection.loaded) {
    await bootout(options, options.label, { knownLoaded: true });
  }
  const removed = inspection.plistExists
    ? await removeAndSync(options.fs, options.plistPath)
    : false;
  return {
    label: options.label,
    plistPath: options.plistPath,
    loaded: false,
    removed,
  };
}

async function assertCanonicalLegacyPlist(options, oldPlistPath) {
  const canonical = join(
    options.home,
    "Library",
    "LaunchAgents",
    `${LEGACY_WATCHDOG_LABEL}.plist`,
  );
  if (resolve(oldPlistPath) !== resolve(canonical)) {
    throw new Error("legacy attribution failed: plist is not at the canonical path");
  }
  const actual = await options.fs.realpath(oldPlistPath);
  if (actual !== resolve(canonical)) {
    throw new Error("legacy attribution failed: canonical plist resolves elsewhere");
  }
}

async function assertLegacyAttribution(options, oldPlistPath, plist) {
  if (
    plist.Label !== LEGACY_WATCHDOG_LABEL ||
    plist.RunAtLoad !== true ||
    plist.StartInterval !== 15 ||
    plist.AbandonProcessGroup !== true ||
    !Array.isArray(plist.ProgramArguments) ||
    plist.ProgramArguments.length !== 2 ||
    plist.ProgramArguments[0] !== "/bin/zsh" ||
    !(
      plist.EnvironmentVariables?.HEIGE_CODEX_SKIN_PORT === "9341" ||
      plist.EnvironmentVariables?.HEIGE_CODEX_SKIN_PORT === 9341
    )
  ) {
    throw new Error("legacy attribution failed: fixed feature tuple mismatch");
  }
  await assertCanonicalLegacyPlist(options, oldPlistPath);

  const scriptPath = plist.ProgramArguments[1];
  assertAbsolutePath(scriptPath, "legacy watchdog executable");
  if (isTemporaryPath(scriptPath)) {
    throw new Error("legacy attribution failed: executable is under a temporary path");
  }
  const scriptRoot = dirname(dirname(dirname(scriptPath)));
  if (resolve(scriptPath) !== resolve(join(scriptRoot, "scripts", "lib", "skin-watchdog.zsh"))) {
    throw new Error("legacy attribution failed: executable suffix mismatch");
  }
  const allowedRoots = [
    options.stableInstallRoot,
    ...(options.legacyRoots ?? []),
    ...(options.identifiedLegacyRoots ?? []),
  ].filter((value, index, values) => typeof value === "string" && values.indexOf(value) === index);
  if (!allowedRoots.some((root) => resolve(root) === resolve(scriptRoot)) || isTemporaryPath(scriptRoot)) {
    throw new Error("legacy attribution failed: executable root is not positively identified");
  }
  const scriptInfo = await options.fs.lstat(scriptPath);
  if (scriptInfo.isSymbolicLink() || !scriptInfo.isFile()) {
    throw new Error("legacy attribution failed: executable is not a regular file");
  }
  const actualScript = await options.fs.realpath(scriptPath);
  const approvedRealRoots = [];
  for (const root of allowedRoots) {
    try {
      approvedRealRoots.push(await options.fs.realpath(root));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (
    isTemporaryPath(actualScript) ||
    !approvedRealRoots.some((root) =>
      isWithin(root, actualScript) &&
      actualScript === join(root, "scripts", "lib", "skin-watchdog.zsh")
    )
  ) {
    throw new Error("legacy attribution failed: executable resolves outside its approved real root");
  }
}

async function advanceMigration(options, journalPath, journal, phase) {
  journal.phase = phase;
  await writeJournal(options, journalPath, journal);
  inject(options, phase);
}

async function publishStagedPlist(options, stagedPath, targetPath) {
  await options.fs.rename(stagedPath, targetPath);
  await options.fs.chmod(targetPath, 0o600);
  await syncDirectory(options.fs, dirname(targetPath));
}

async function rollbackMigration({
  options,
  primaryError,
  journal,
  journalPath,
  stagedPath,
  oldPlistPath,
  oldSnapshot,
  oldLoaded,
  newSnapshot,
  newLoadedBefore,
}) {
  const rollbackErrors = [];
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      rollbackErrors.push(error);
    }
  };

  await attempt(async () => {
    inject(options, "before-new-bootout", { rollback: true });
    if (await isLoaded(options, CONTROLLER_LAUNCH_AGENT_LABEL)) {
      await bootout(options, CONTROLLER_LAUNCH_AGENT_LABEL);
    }
  });
  await attempt(async () => {
    inject(options, "before-new-plist-restore", { rollback: true });
    if (newSnapshot) {
      await atomicWrite(options.fs, options.plistPath, newSnapshot.bytes, newSnapshot.mode);
    } else {
      await removeAndSync(options.fs, options.plistPath);
    }
  });
  await attempt(async () => {
    const currentlyLoaded = await isLoaded(options, CONTROLLER_LAUNCH_AGENT_LABEL);
    if (newLoadedBefore && !currentlyLoaded) {
      if (!newSnapshot) throw new Error("loaded controller had no restorable plist snapshot");
      inject(options, "before-new-rebootstrap", { rollback: true });
      await bootstrap(options, CONTROLLER_LAUNCH_AGENT_LABEL, options.plistPath);
    } else if (!newLoadedBefore && currentlyLoaded) {
      await bootout(options, CONTROLLER_LAUNCH_AGENT_LABEL);
    }
    if ((await isLoaded(options, CONTROLLER_LAUNCH_AGENT_LABEL)) !== newLoadedBefore) {
      throw new Error("controller loaded state was not restored");
    }
  });
  await attempt(async () => {
    inject(options, "before-old-plist-restore", { rollback: true });
    await atomicWrite(options.fs, oldPlistPath, oldSnapshot.bytes, oldSnapshot.mode);
  });
  await attempt(async () => {
    const currentlyLoaded = await isLoaded(options, LEGACY_WATCHDOG_LABEL);
    if (oldLoaded && !currentlyLoaded) {
      inject(options, "before-old-rebootstrap", { rollback: true });
      await bootstrap(options, LEGACY_WATCHDOG_LABEL, oldPlistPath);
    } else if (!oldLoaded && currentlyLoaded) {
      await bootout(options, LEGACY_WATCHDOG_LABEL);
    }
    if ((await isLoaded(options, LEGACY_WATCHDOG_LABEL)) !== oldLoaded) {
      throw new Error("legacy loaded state was not restored");
    }
  });
  await attempt(async () => {
    inject(options, "before-stage-cleanup", { rollback: true });
    await options.fs.rm(stagedPath, { force: true });
  });

  if (rollbackErrors.length === 0) {
    await attempt(async () => {
      inject(options, "before-journal-cleanup", { rollback: true });
      await removeAndSync(options.fs, journalPath);
    });
    if (rollbackErrors.length === 0) return null;
  }

  journal.phase = "rollback-failed";
  journal.primaryError = safeError(primaryError);
  journal.rollbackErrors = rollbackErrors.map(safeError);
  try {
    await writeJournal(options, journalPath, journal);
  } catch (journalError) {
    rollbackErrors.push(journalError);
  }
  const error = new AggregateError(
    [primaryError, ...rollbackErrors],
    `migration failed and rollback also failed: ${primaryError.message}`,
  );
  error.code = "MIGRATION_ROLLBACK_FAILED";
  error.primaryError = primaryError;
  error.rollbackErrors = rollbackErrors;
  return error;
}

export async function migrateLegacyWatchdog(input = {}) {
  const options = normalizedOptions({
    ...input,
    label: CONTROLLER_LAUNCH_AGENT_LABEL,
  });
  assertMutationLabel(options.label, options.testMode === true);
  assertProductionLocations(options);
  if ((input.oldLabel ?? LEGACY_WATCHDOG_LABEL) !== LEGACY_WATCHDOG_LABEL) {
    throw new Error("legacy attribution failed: unexpected old label");
  }
  launchDomain(options);
  await ensurePrivateDirectory(options.fs, options.stateDir);
  await ensureDirectory(options.fs, options.launchAgentsDir);
  await assertCanonicalDirectory(options.fs, options.launchAgentsDir);

  const oldPlistPath = input.oldPlistPath ?? join(
    options.home,
    "Library",
    "LaunchAgents",
    `${LEGACY_WATCHDOG_LABEL}.plist`,
  );
  const oldSnapshot = await snapshotFile(options.fs, oldPlistPath);
  if (!oldSnapshot) {
    return {
      legacyFound: false,
      legacyRemoved: false,
      controllerRegistered: false,
    };
  }
  const oldPlist = await readPlist(options, oldPlistPath);
  await assertLegacyAttribution(options, oldPlistPath, oldPlist);
  const oldLoaded = await isLoaded(options, LEGACY_WATCHDOG_LABEL);
  const programArguments = normalizeProgramArguments(options);
  const newSnapshot = await snapshotFile(options.fs, options.plistPath);
  const newLoadedBefore = await isLoaded(options, CONTROLLER_LAUNCH_AGENT_LABEL);
  if (newLoadedBefore && !newSnapshot) {
    const error = new Error("loaded controller has no canonical plist snapshot");
    error.code = "CONTROLLER_PRESTATE_INVALID";
    throw error;
  }
  if (newSnapshot) {
    const newPlist = await readPlist(options, options.plistPath);
    assertControllerPlistAttribution(options, newPlist, programArguments);
  }
  const journalPath = input.journalPath ?? join(options.stateDir, "launch-agent-migration.json");
  const stagedPath = `${options.plistPath}.staged.${randomUUID()}`;
  const journal = {
    schemaVersion: 1,
    operation: "migrate-legacy-watchdog",
    phase: "prepared",
    oldLabel: LEGACY_WATCHDOG_LABEL,
    newLabel: CONTROLLER_LAUNCH_AGENT_LABEL,
    oldLoaded,
    oldMode: oldSnapshot.mode,
    newPlistExisted: newSnapshot !== null,
    newLoaded: newLoadedBefore,
  };
  const plist = renderControllerPlist({
    label: CONTROLLER_LAUNCH_AGENT_LABEL,
    programArguments,
    stateDir: options.stateDir,
  });

  try {
    await advanceMigration(options, journalPath, journal, "after-journal");
    await atomicWrite(options.fs, stagedPath, plist, 0o600);
    await advanceMigration(options, journalPath, journal, "after-new-stage");
    await lintPlist(options, stagedPath);
    await advanceMigration(options, journalPath, journal, "after-new-lint");
    if (newLoadedBefore) {
      await bootout(options, CONTROLLER_LAUNCH_AGENT_LABEL);
      await advanceMigration(options, journalPath, journal, "after-existing-new-bootout");
    }
    await publishStagedPlist(options, stagedPath, options.plistPath);
    await advanceMigration(options, journalPath, journal, "after-new-publish");
    await command(options, "/bin/launchctl", [
      "bootstrap",
      launchDomain(options),
      options.plistPath,
    ]);
    await advanceMigration(options, journalPath, journal, "after-new-bootstrap");
    if (!(await isLoaded(options, CONTROLLER_LAUNCH_AGENT_LABEL))) {
      throw new Error("new controller failed launchctl verification");
    }
    await advanceMigration(options, journalPath, journal, "after-new-verify");

    if (oldLoaded) {
      await command(options, "/bin/launchctl", [
        "bootout",
        launchTarget(options, LEGACY_WATCHDOG_LABEL),
      ]);
    }
    await advanceMigration(options, journalPath, journal, "after-old-bootout");
    if (await isLoaded(options, LEGACY_WATCHDOG_LABEL)) {
      throw new Error("legacy watchdog remained loaded after bootout");
    }
    await advanceMigration(options, journalPath, journal, "after-old-verify");
    await removeAndSync(options.fs, oldPlistPath);
    await advanceMigration(options, journalPath, journal, "after-old-remove");
    await options.fs.rm(journalPath, { force: true });
    await syncDirectory(options.fs, dirname(journalPath));
    return {
      legacyFound: true,
      legacyRemoved: true,
      controllerRegistered: true,
    };
  } catch (primaryError) {
    const rollbackError = await rollbackMigration({
      options,
      primaryError,
      journal,
      journalPath,
      stagedPath,
      oldPlistPath,
      oldSnapshot,
      oldLoaded,
      newSnapshot,
      newLoadedBefore,
    });
    if (rollbackError) throw rollbackError;
    throw primaryError;
  }
}
