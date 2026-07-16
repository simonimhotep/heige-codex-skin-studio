import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  inspectLaunchAgent,
  migrateLegacyWatchdog,
  registerControllerAgent,
  renderControllerPlist,
  unregisterControllerAgent,
} from "../src/macos-launch-agent.mjs";

const CONTROLLER_LABEL = "com.heige.codex-skin-controller";
const LEGACY_LABEL = "com.heige.codex-skin-watchdog";
const UID = 501;

function renderedLabel(xml) {
  const match = String(xml).match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
  return match?.[1]
    ?.replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'") ?? null;
}

async function pathExists(path) {
  return stat(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

function legacyPlistObject({
  root,
  label = LEGACY_LABEL,
  script = join(root, "scripts", "lib", "skin-watchdog.zsh"),
  environment = {},
  runAtLoad = true,
  startInterval = 15,
  abandonProcessGroup = true,
  port = "9341",
} = {}) {
  return {
    Label: label,
    ProgramArguments: ["/bin/zsh", script],
    EnvironmentVariables: {
      HEIGE_CODEX_SKIN_PORT: port,
      ...environment,
    },
    RunAtLoad: runAtLoad,
    StartInterval: startInterval,
    AbandonProcessGroup: abandonProcessGroup,
    StandardOutPath: environment.HEIGE_CODEX_SKIN_STATE
      ? join(environment.HEIGE_CODEX_SKIN_STATE, "watchdog.log")
      : join(root, "watchdog.log"),
  };
}

function legacyPlistBytes(plist) {
  return Buffer.from(`legacy plist fixture for ${plist.Label}\n`);
}

async function fixture(t, overrides = {}) {
  const base = await fsPromises.realpath(
    await mkdtemp(join(tmpdir(), "heige-launch-agent-")),
  );
  t.after(() => rm(base, { recursive: true, force: true }));

  const home = join(base, "home");
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  const stateDir = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio");
  const stableInstallRoot = join(home, ".codex", "heige-codex-skin-studio");
  const controllerPath = join(stableInstallRoot, "src", "cli.mjs");
  const nodePath = join(stableInstallRoot, "runtime", "node");
  const oldPlistPath = join(launchAgentsDir, `${LEGACY_LABEL}.plist`);
  const controllerPlistPath = join(launchAgentsDir, `${CONTROLLER_LABEL}.plist`);
  const journalPath = join(stateDir, "launch-agent-migration.json");

  await fsPromises.mkdir(join(stableInstallRoot, "scripts", "lib"), { recursive: true });
  await fsPromises.mkdir(dirname(controllerPath), { recursive: true });
  await fsPromises.mkdir(dirname(nodePath), { recursive: true });
  await fsPromises.mkdir(launchAgentsDir, { recursive: true });
  await writeFile(join(stableInstallRoot, "scripts", "lib", "skin-watchdog.zsh"), "#!/bin/zsh\n");
  await writeFile(controllerPath, "// controller\n");
  await writeFile(nodePath, "node\n");

  const oldPlist = overrides.oldPlist ?? legacyPlistObject({
    root: stableInstallRoot,
    environment: overrides.oldEnvironment,
  });
  const originalPlistBytes = overrides.originalPlistBytes ?? legacyPlistBytes(oldPlist);
  await writeFile(oldPlistPath, originalPlistBytes, { mode: 0o640 });
  await fsPromises.chmod(oldPlistPath, 0o640);

  const loaded = new Set(overrides.oldLoaded === false ? [] : [LEGACY_LABEL]);
  const commands = [];
  const touchedPaths = [];
  const deletedPaths = [];
  const parsedByPath = new Map([[oldPlistPath, oldPlist]]);
  let controllerBootstrapFailures = overrides.controllerBootstrapFailures ?? 0;

  const trackingFs = {
    ...fsPromises,
    async chmod(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.chmod(path, ...args);
    },
    async lstat(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.lstat(path, ...args);
    },
    async mkdir(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.mkdir(path, ...args);
    },
    async open(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.open(path, ...args);
    },
    async readFile(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.readFile(path, ...args);
    },
    async realpath(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.realpath(path, ...args);
    },
    async rename(from, to, ...args) {
      touchedPaths.push(String(from), String(to));
      return fsPromises.rename(from, to, ...args);
    },
    async rm(path, ...args) {
      touchedPaths.push(String(path));
      deletedPaths.push(String(path));
      return fsPromises.rm(path, ...args);
    },
    async stat(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.stat(path, ...args);
    },
    async writeFile(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.writeFile(path, ...args);
    },
  };

  async function readPlist(path) {
    if (parsedByPath.has(path)) return structuredClone(parsedByPath.get(path));
    const xml = await readFile(path, "utf8");
    const label = renderedLabel(xml);
    if (!label) throw new Error(`unparseable plist: ${path}`);
    return {
      Label: label,
      ProgramArguments: [nodePath, controllerPath, "controller"],
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      ProcessType: "Background",
      StandardOutPath: join(stateDir, "controller.log"),
      StandardErrorPath: join(stateDir, "controller.error.log"),
    };
  }

  async function execFile(file, args) {
    commands.push([file, ...args]);
    if (file === "/usr/bin/plutil" && args[0] === "-lint") {
      if (overrides.lintFailure) throw new Error("lint failed");
      return { stdout: `${args.at(-1)}: OK\n`, stderr: "" };
    }
    if (file !== "/bin/launchctl") throw new Error(`unexpected command: ${file}`);
    if (args[0] === "print") {
      const label = args[1].split("/").at(-1);
      if (loaded.has(label)) return { stdout: `service = ${label}\n`, stderr: "" };
      const error = new Error(`Could not find service ${label}`);
      error.code = 113;
      throw error;
    }
    if (args[0] === "bootstrap") {
      const path = args[2];
      const label = path === oldPlistPath
        ? LEGACY_LABEL
        : renderedLabel(await readFile(path, "utf8"));
      if (overrides.failOldBootstrap && label === LEGACY_LABEL) {
        throw new Error("old bootstrap failed");
      }
      if (label === CONTROLLER_LABEL && controllerBootstrapFailures > 0) {
        controllerBootstrapFailures -= 1;
        throw new Error("controller bootstrap failed");
      }
      loaded.add(label);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "bootout") {
      const label = args[1].split("/").at(-1);
      loaded.delete(label);
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected launchctl action: ${args[0]}`);
  }

  return {
    home,
    launchAgentsDir,
    stateDir,
    stableInstallRoot,
    legacyRoots: [stableInstallRoot],
    controllerPath,
    nodePath,
    label: CONTROLLER_LABEL,
    oldLabel: LEGACY_LABEL,
    oldPlistPath,
    controllerPlistPath,
    journalPath,
    processUid: UID,
    fs: trackingFs,
    execFile,
    readPlist,
    originalPlistBytes,
    commands,
    loaded,
    touchedPaths,
    deletedPaths,
    faultAt: overrides.faultAt,
    rollbackFaultAt: overrides.rollbackFaultAt,
  };
}

test("test mode refuses both production labels", async (t) => {
  const deps = await fixture(t);
  for (const label of [LEGACY_LABEL, CONTROLLER_LABEL]) {
    await assert.rejects(
      registerControllerAgent({ ...deps, label, testMode: true }),
      /production label/i,
    );
  }
});

test("test mode accepts only a random isolated controller label", async (t) => {
  const deps = await fixture(t);
  await assert.rejects(
    registerControllerAgent({ ...deps, label: `${CONTROLLER_LABEL}.test.fixed`, testMode: true }),
    /random UUID/i,
  );
});

test("controller plist is escaped and encodes a failure-only background job", () => {
  const xml = renderControllerPlist({
    label: `${CONTROLLER_LABEL}.test.123e4567-e89b-42d3-a456-426614174000`,
    programArguments: ["/Users/a&b<c>/node", "/Users/a&b<c>/cli.mjs", "controller"],
    stateDir: "/Users/a&b<c>/state",
  });

  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(xml, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  assert.match(xml, /\/Users\/a&amp;b&lt;c&gt;\/node/);
  assert.doesNotMatch(xml, /\/Users\/a&b<c>/);
  assert.match(xml, /controller\.log/);
  assert.match(xml, /controller\.error\.log/);
});

test("controller plist rejects relative executable and log paths", () => {
  assert.throws(
    () => renderControllerPlist({
      label: CONTROLLER_LABEL,
      programArguments: ["node", "/stable/cli.mjs", "controller"],
      stateDir: "/stable/state",
    }),
    /absolute/,
  );
  assert.throws(
    () => renderControllerPlist({
      label: CONTROLLER_LABEL,
      programArguments: ["/stable/node", "/stable/cli.mjs", "controller"],
      stateDir: "relative/state",
    }),
    /absolute/,
  );
});

test("production registration cannot replace the stable controller entrypoint", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await assert.rejects(
    registerControllerAgent({
      ...deps,
      programArguments: ["/bin/sh", "/tmp/hostile-script"],
    }),
    /stable controller entrypoint/i,
  );
  assert.equal(await pathExists(deps.controllerPlistPath), false);
});

test("production registration cannot redirect canonical plist or state locations", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await assert.rejects(
    registerControllerAgent({
      ...deps,
      launchAgentsDir: join(deps.home, "redirected-agents"),
    }),
    /canonical production locations/i,
  );
  await assert.rejects(
    registerControllerAgent({
      ...deps,
      stateDir: join(deps.home, "redirected-state"),
    }),
    /canonical production locations/i,
  );
});

test("register writes private files, lints, bootstraps and verifies gui uid state", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();

  const result = await registerControllerAgent(deps);

  assert.deepEqual(result, {
    label: CONTROLLER_LABEL,
    plistPath: deps.controllerPlistPath,
    loaded: true,
  });
  assert.equal((await stat(deps.stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(deps.controllerPlistPath)).mode & 0o777, 0o600);
  assert.deepEqual(deps.commands.filter(([file]) => file === "/bin/launchctl"), [
    ["/bin/launchctl", "print", `gui/${UID}/${CONTROLLER_LABEL}`],
    ["/bin/launchctl", "bootstrap", `gui/${UID}`, deps.controllerPlistPath],
    ["/bin/launchctl", "print", `gui/${UID}/${CONTROLLER_LABEL}`],
  ]);
  const lintIndex = deps.commands.findIndex((command) =>
    command[0] === "/usr/bin/plutil" && command[1] === "-lint"
  );
  const bootstrapIndex = deps.commands.findIndex((command) =>
    command[0] === "/bin/launchctl" && command[1] === "bootstrap"
  );
  assert.match(deps.commands[lintIndex][2], new RegExp(
    `^${deps.controllerPlistPath.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.staged\\.`,
  ));
  assert.equal(lintIndex < bootstrapIndex, true, "lint must finish before publish/bootstrap");
  assert.equal(await pathExists(deps.commands[lintIndex][2]), false);
});

test("register leaves an existing loaded controller byte-for-byte intact when staged lint fails", async (t) => {
  const deps = await fixture(t, { lintFailure: true });
  const previous = Buffer.from(renderControllerPlist({
    label: CONTROLLER_LABEL,
    programArguments: [deps.nodePath, deps.controllerPath, "controller"],
    stateDir: deps.stateDir,
  }));
  await writeFile(deps.controllerPlistPath, previous, { mode: 0o640 });
  await fsPromises.chmod(deps.controllerPlistPath, 0o640);
  deps.loaded.add(CONTROLLER_LABEL);

  await assert.rejects(registerControllerAgent(deps), /lint failed/);
  assert.deepEqual(await readFile(deps.controllerPlistPath), previous);
  assert.equal((await stat(deps.controllerPlistPath)).mode & 0o777, 0o640);
  assert.equal(deps.loaded.has(CONTROLLER_LABEL), true);
});

test("register restores an existing loaded controller when replacement bootstrap fails", async (t) => {
  const deps = await fixture(t, { controllerBootstrapFailures: 1 });
  const previous = Buffer.from(renderControllerPlist({
    label: CONTROLLER_LABEL,
    programArguments: [deps.nodePath, deps.controllerPath, "controller"],
    stateDir: deps.stateDir,
  }));
  await writeFile(deps.controllerPlistPath, previous, { mode: 0o640 });
  await fsPromises.chmod(deps.controllerPlistPath, 0o640);
  deps.loaded.add(CONTROLLER_LABEL);

  await assert.rejects(registerControllerAgent(deps), /controller bootstrap failed/);
  assert.deepEqual(await readFile(deps.controllerPlistPath), previous);
  assert.equal((await stat(deps.controllerPlistPath)).mode & 0o777, 0o640);
  assert.equal(deps.loaded.has(CONTROLLER_LABEL), true);
});

test("register fails closed when a loaded controller has no restorable canonical plist", async (t) => {
  const deps = await fixture(t);
  deps.loaded.add(CONTROLLER_LABEL);
  await assert.rejects(
    registerControllerAgent(deps),
    (error) => error.code === "CONTROLLER_PRESTATE_INVALID",
  );
  assert.equal(deps.loaded.has(CONTROLLER_LABEL), true);
  assert.equal(await pathExists(deps.controllerPlistPath), false);
});

test("register refuses to overwrite a foreign plist at the canonical controller path", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  const foreign = Buffer.from("foreign controller plist\n");
  await writeFile(deps.controllerPlistPath, foreign, { mode: 0o600 });
  const readPlist = async (path) => path === deps.controllerPlistPath
    ? { Label: "example.foreign.agent" }
    : deps.readPlist(path);
  await assert.rejects(
    registerControllerAgent({ ...deps, readPlist }),
    /controller plist attribution failed/i,
  );
  assert.deepEqual(await readFile(deps.controllerPlistPath), foreign);
});

test("inspect reports plist identity and verified launchctl state", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await registerControllerAgent(deps);

  const inspection = await inspectLaunchAgent(deps);
  assert.equal(inspection.label, CONTROLLER_LABEL);
  assert.equal(inspection.plistPath, deps.controllerPlistPath);
  assert.equal(inspection.plistExists, true);
  assert.equal(inspection.plistLabel, CONTROLLER_LABEL);
  assert.equal(inspection.loaded, true);
});

test("the production plist reader delegates parsing to plutil JSON conversion", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await registerControllerAgent(deps);
  deps.commands.length = 0;
  const execFile = async (file, args) => {
    if (file === "/usr/bin/plutil" && args[0] === "-convert") {
      deps.commands.push([file, ...args]);
      return { stdout: JSON.stringify({ Label: CONTROLLER_LABEL }), stderr: "" };
    }
    return deps.execFile(file, args);
  };

  const inspection = await inspectLaunchAgent({
    ...deps,
    execFile,
    readPlist: undefined,
  });
  assert.equal(inspection.plistLabel, CONTROLLER_LABEL);
  assert.deepEqual(deps.commands[0], [
    "/usr/bin/plutil",
    "-convert",
    "json",
    "-o",
    "-",
    deps.controllerPlistPath,
  ]);
});

test("unregister verifies absence and deletes only its matching generated plist", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await registerControllerAgent(deps);
  deps.commands.length = 0;

  const result = await unregisterControllerAgent(deps);
  assert.deepEqual(result, {
    label: CONTROLLER_LABEL,
    plistPath: deps.controllerPlistPath,
    loaded: false,
    removed: true,
  });
  assert.equal(await pathExists(deps.controllerPlistPath), false);
  assert.deepEqual(deps.commands.filter(([file]) => file === "/bin/launchctl"), [
    ["/bin/launchctl", "print", `gui/${UID}/${CONTROLLER_LABEL}`],
    ["/bin/launchctl", "bootout", `gui/${UID}/${CONTROLLER_LABEL}`],
    ["/bin/launchctl", "print", `gui/${UID}/${CONTROLLER_LABEL}`],
  ]);
});

test("unregister refuses to delete a plist owned by another label", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await fsPromises.mkdir(dirname(deps.controllerPlistPath), { recursive: true });
  await writeFile(deps.controllerPlistPath, "foreign\n");
  const readPlist = async (path) => path === deps.controllerPlistPath
    ? { Label: "example.foreign.agent" }
    : deps.readPlist(path);

  await assert.rejects(
    unregisterControllerAgent({ ...deps, readPlist }),
    /does not own/i,
  );
  assert.equal(await pathExists(deps.controllerPlistPath), true);
});

test("legacy migration removes only a fully attributed old plist", async (t) => {
  const deps = await fixture(t);
  const result = await migrateLegacyWatchdog(deps);

  assert.deepEqual(result, {
    legacyFound: true,
    legacyRemoved: true,
    controllerRegistered: true,
  });
  assert.equal(deps.loaded.has(LEGACY_LABEL), false);
  assert.equal(deps.loaded.has(CONTROLLER_LABEL), true);
  assert.equal(await pathExists(deps.oldPlistPath), false);
  assert.equal(await pathExists(deps.controllerPlistPath), true);
  assert.equal(await pathExists(deps.journalPath), false);
  assert.deepEqual(
    deps.deletedPaths.filter((path) => path === deps.oldPlistPath),
    [deps.oldPlistPath],
  );
});

test("polluted legacy state and log paths are never followed or deleted", async (t) => {
  const polluted = "/tmp/a&b<c>d";
  const deps = await fixture(t, {
    oldEnvironment: { HEIGE_CODEX_SKIN_STATE: polluted },
  });

  await migrateLegacyWatchdog(deps);

  assert.equal(deps.touchedPaths.some((path) => path === polluted || path.startsWith(`${polluted}/`)), false);
  assert.equal(deps.deletedPaths.some((path) => path === polluted || path.startsWith(`${polluted}/`)), false);
});

test("temporary or unapproved watchdog executable paths fail attribution closed", async (t) => {
  const temporary = await fixture(t, {
    oldPlist: legacyPlistObject({ root: "/tmp/hostile-root" }),
  });
  await assert.rejects(migrateLegacyWatchdog(temporary), /legacy attribution/i);
  assert.equal(await pathExists(temporary.oldPlistPath), true);

  const unknown = await fixture(t, {
    oldPlist: legacyPlistObject({ root: "/Users/unknown/repository" }),
  });
  await assert.rejects(migrateLegacyWatchdog(unknown), /legacy attribution/i);
  assert.equal(await pathExists(unknown.oldPlistPath), true);
});

test("legacy attribution rejects canonical plist and executable symlink escapes", async (t) => {
  await t.test("canonical legacy plist symlink", async (t) => {
    const deps = await fixture(t);
    const backing = join(deps.home, "legacy-backing.plist");
    await writeFile(backing, deps.originalPlistBytes);
    await rm(deps.oldPlistPath);
    await symlink(backing, deps.oldPlistPath);
    await assert.rejects(migrateLegacyWatchdog(deps), /non-regular file|attribution/i);
    assert.equal(deps.loaded.has(CONTROLLER_LABEL), false);
  });

  await t.test("watchdog file symlink", async (t) => {
    const deps = await fixture(t);
    const script = join(deps.stableInstallRoot, "scripts", "lib", "skin-watchdog.zsh");
    const outside = join(deps.home, "outside-watchdog.zsh");
    await writeFile(outside, "#!/bin/zsh\n");
    await rm(script);
    await symlink(outside, script);
    await assert.rejects(migrateLegacyWatchdog(deps), /legacy attribution/i);
    assert.equal(deps.loaded.has(CONTROLLER_LABEL), false);
  });

  await t.test("watchdog ancestor symlink", async (t) => {
    const deps = await fixture(t);
    const scripts = join(deps.stableInstallRoot, "scripts");
    const outside = join(deps.home, "outside-scripts");
    await fsPromises.mkdir(join(outside, "lib"), { recursive: true });
    await writeFile(join(outside, "lib", "skin-watchdog.zsh"), "#!/bin/zsh\n");
    await rm(scripts, { recursive: true });
    await symlink(outside, scripts);
    await assert.rejects(migrateLegacyWatchdog(deps), /legacy attribution/i);
    assert.equal(deps.loaded.has(CONTROLLER_LABEL), false);
  });
});

test("register refuses a symlink at the canonical controller plist", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  const backing = join(deps.home, "controller-backing.plist");
  await writeFile(backing, "foreign\n");
  await symlink(backing, deps.controllerPlistPath);
  await assert.rejects(registerControllerAgent(deps), /non-regular file/);
  assert.equal(await readFile(backing, "utf8"), "foreign\n");
});

for (const [field, value] of [
  ["Label", "example.foreign"],
  ["ProgramArguments", ["/bin/zsh", "/tmp/skin-watchdog.zsh"]],
  ["RunAtLoad", false],
  ["StartInterval", 30],
  ["AbandonProcessGroup", false],
  ["EnvironmentVariables", { HEIGE_CODEX_SKIN_PORT: "9342" }],
]) {
  test(`legacy attribution rejects mismatched ${field}`, async (t) => {
    const deps = await fixture(t);
    const source = await deps.readPlist(deps.oldPlistPath);
    const readPlist = async (path) => path === deps.oldPlistPath
      ? { ...source, [field]: value }
      : deps.readPlist(path);
    await assert.rejects(
      migrateLegacyWatchdog({ ...deps, readPlist }),
      /legacy attribution/i,
    );
    assert.equal(deps.loaded.has(LEGACY_LABEL), true);
    assert.equal(deps.loaded.has(CONTROLLER_LABEL), false);
    assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  });
}

const MIGRATION_BOUNDARIES = [
  "after-journal",
  "after-new-stage",
  "after-new-lint",
  "after-new-publish",
  "after-new-bootstrap",
  "after-new-verify",
  "after-old-bootout",
  "after-old-verify",
  "after-old-remove",
];

for (const faultAt of MIGRATION_BOUNDARIES) {
  test(`migration rolls back byte-for-byte after ${faultAt}`, async (t) => {
    const deps = await fixture(t, { faultAt, oldLoaded: true });
    await assert.rejects(
      migrateLegacyWatchdog(deps),
      (error) => error.code === "INJECTED_MIGRATION_FAILURE" && error.phase === faultAt,
    );

    assert.equal(deps.loaded.has(LEGACY_LABEL), true);
    assert.equal(deps.loaded.has(CONTROLLER_LABEL), false);
    assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
    assert.equal((await stat(deps.oldPlistPath)).mode & 0o777, 0o640);
    assert.equal(await pathExists(deps.controllerPlistPath), false);
    assert.equal(await pathExists(deps.journalPath), false);
  });
}

test("rollback restores an unloaded legacy job without loading it", async (t) => {
  const deps = await fixture(t, { faultAt: "after-old-remove", oldLoaded: false });
  await assert.rejects(migrateLegacyWatchdog(deps), /INJECTED_MIGRATION_FAILURE/);
  assert.equal(deps.loaded.has(LEGACY_LABEL), false);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
});

test("migration rollback restores an existing controller plist, mode, and loaded state", async (t) => {
  const deps = await fixture(t, { faultAt: "after-old-bootout" });
  const previous = Buffer.from(renderControllerPlist({
    label: CONTROLLER_LABEL,
    programArguments: [deps.nodePath, deps.controllerPath, "controller"],
    stateDir: deps.stateDir,
  }));
  await writeFile(deps.controllerPlistPath, previous, { mode: 0o640 });
  await fsPromises.chmod(deps.controllerPlistPath, 0o640);
  deps.loaded.add(CONTROLLER_LABEL);

  await assert.rejects(migrateLegacyWatchdog(deps), /INJECTED_MIGRATION_FAILURE/);
  assert.deepEqual(await readFile(deps.controllerPlistPath), previous);
  assert.equal((await stat(deps.controllerPlistPath)).mode & 0o777, 0o640);
  assert.equal(deps.loaded.has(CONTROLLER_LABEL), true);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  assert.equal(deps.loaded.has(LEGACY_LABEL), true);
});

test("migration refuses an existing controller plist whose fixed tuple is foreign", async (t) => {
  const deps = await fixture(t);
  const previous = Buffer.from("foreign same-label controller\n");
  await writeFile(deps.controllerPlistPath, previous, { mode: 0o600 });
  const readPlist = async (path) => path === deps.controllerPlistPath
    ? {
      Label: CONTROLLER_LABEL,
      ProgramArguments: ["/bin/sh", "/tmp/foreign"],
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      ProcessType: "Background",
    }
    : deps.readPlist(path);

  await assert.rejects(
    migrateLegacyWatchdog({ ...deps, readPlist }),
    /controller plist attribution failed/i,
  );
  assert.deepEqual(await readFile(deps.controllerPlistPath), previous);
  assert.equal(deps.loaded.has(LEGACY_LABEL), true);
});

test("the existing-controller bootout boundary is injectable and reversible", async (t) => {
  const deps = await fixture(t, { faultAt: "after-existing-new-bootout" });
  const previous = Buffer.from(renderControllerPlist({
    label: CONTROLLER_LABEL,
    programArguments: [deps.nodePath, deps.controllerPath, "controller"],
    stateDir: deps.stateDir,
  }));
  await writeFile(deps.controllerPlistPath, previous, { mode: 0o600 });
  deps.loaded.add(CONTROLLER_LABEL);

  await assert.rejects(
    migrateLegacyWatchdog(deps),
    (error) => error.code === "INJECTED_MIGRATION_FAILURE" &&
      error.phase === "after-existing-new-bootout",
  );
  assert.deepEqual(await readFile(deps.controllerPlistPath), previous);
  assert.equal(deps.loaded.has(CONTROLLER_LABEL), true);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  assert.equal(deps.loaded.has(LEGACY_LABEL), true);
});

test("rollback reports primary and rollback failures and retains the journal", async (t) => {
  const deps = await fixture(t, {
    faultAt: "after-old-bootout",
    rollbackFaultAt: "before-old-rebootstrap",
  });

  await assert.rejects(
    migrateLegacyWatchdog(deps),
    (error) => {
      assert.equal(error.code, "MIGRATION_ROLLBACK_FAILED");
      assert.match(error.primaryError.message, /INJECTED_MIGRATION_FAILURE/);
      assert.equal(error.rollbackErrors.length > 0, true);
      assert.match(error.message, /rollback/i);
      return true;
    },
  );
  assert.equal(await pathExists(deps.journalPath), true);
  const journal = JSON.parse(await readFile(deps.journalPath, "utf8"));
  assert.equal(journal.phase, "rollback-failed");
  assert.equal(journal.primaryError.code, "INJECTED_MIGRATION_FAILURE");
  assert.equal(journal.rollbackErrors.length > 0, true);
});

test("unit and integration sources never reuse production labels accidentally", async () => {
  const integration = await readFile(
    new URL("./macos-launch-agent.integration.test.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(integration, /com\.heige\.codex-skin-watchdog/);
  assert.doesNotMatch(integration, /com\.heige\.codex-skin-controller[\"']/);
});
