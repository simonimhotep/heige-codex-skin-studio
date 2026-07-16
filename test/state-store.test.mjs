import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { DEFAULT_THEME_ID, NATIVE_THEME_ID } from "../src/constants.mjs";
import { acquireOperationLock } from "../src/operation-lock.mjs";
import {
  clearTransitionJournal,
  compareAndUpdateStudioState,
  createDefaultStudioState,
  migrateLegacyState,
  readSessionState,
  readStudioState,
  readTransitionJournal,
  recoverStateTransition,
  validateSessionState,
  validateStudioState,
  writeSessionState,
  writeStudioState,
  writeTransitionJournal,
} from "../src/state-store.mjs";

const CONTROL_TOKEN = Buffer.alloc(32, 3).toString("base64url");
const CURRENT_PROCESS = {
  pid: 4242,
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  startedAt: "Thu Jul 16 16:49:24 2026",
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "heige-state-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    statePath: join(root, "state", "state.json"),
    sessionPath: join(root, "state", "session.json"),
    transitionPath: join(root, "state", "transition.json"),
    legacyThemePath: join(root, "legacy-theme"),
  };
}

function stateAtRevision(revision, overrides = {}) {
  return {
    ...createDefaultStudioState({ themeId: DEFAULT_THEME_ID, token: CONTROL_TOKEN }),
    persistenceEnabled: true,
    revision,
    ...overrides,
  };
}

function disableJournal(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: "disable-persistence",
    expectedRevision: 3,
    process: CURRENT_PROCESS,
    desiredPersistenceEnabled: false,
    nonce: "transition-1",
    stage: "prepared",
    ...overrides,
  };
}

function testLeaseFor(path, { failAtAssertion = Number.POSITIVE_INFINITY } = {}) {
  let owned = true;
  let assertions = 0;
  return {
    lockPath: join(dirname(path), "operation.lock"),
    get assertions() {
      return assertions;
    },
    lose() {
      owned = false;
    },
    async assertOwned() {
      assertions += 1;
      if (!owned || assertions >= failAtAssertion) {
        const error = new Error("operation lease is no longer owned");
        error.code = "LOCK_NOT_OWNED";
        throw error;
      }
    },
  };
}

test("corrupt state fails closed without generating replacement state", async (t) => {
  const { statePath } = await fixture(t);
  await mkdir(join(statePath, ".."), { recursive: true, mode: 0o700 });
  await chmod(join(statePath, ".."), 0o700);
  await writeFile(statePath, "{bad", { mode: 0o600 });

  await assert.rejects(() => readStudioState(statePath), /状态文件损坏/);

  let randomCalls = 0;
  await assert.rejects(
    () => migrateLegacyState({
      statePath,
      lease: testLeaseFor(statePath),
      legacyAgentLoaded: false,
      themeExists: async () => true,
      randomBytes: () => {
        randomCalls += 1;
        return Buffer.alloc(32, 7);
      },
    }),
    /状态文件损坏/,
  );
  assert.equal(randomCalls, 0);
  assert.equal(await readFile(statePath, "utf8"), "{bad");
});

test("state validation rejects unknown schemas and malformed fields", () => {
  const valid = createDefaultStudioState({ themeId: DEFAULT_THEME_ID, token: CONTROL_TOKEN });
  assert.deepEqual(valid, {
    schemaVersion: 2,
    persistenceEnabled: false,
    selectedThemeId: DEFAULT_THEME_ID,
    lastNonNativeThemeId: DEFAULT_THEME_ID,
    controlToken: CONTROL_TOKEN,
    lastTransitionNonce: null,
    revision: 0,
  });

  for (const malformed of [
    { ...valid, schemaVersion: 99 },
    { ...valid, persistenceEnabled: "false" },
    { ...valid, selectedThemeId: "../theme" },
    { ...valid, lastNonNativeThemeId: NATIVE_THEME_ID },
    { ...valid, controlToken: `${CONTROL_TOKEN}=` },
    { ...valid, lastTransitionNonce: "" },
    { ...valid, lastTransitionNonce: "not safe!" },
    { ...valid, lastTransitionNonce: 7 },
    { ...valid, revision: -1 },
    { ...valid, revision: 1.5 },
  ]) {
    assert.throws(() => validateStudioState(malformed));
  }
});

test("a loaded legacy watchdog and valid theme migrate enabled exactly once", async (t) => {
  const { statePath, legacyThemePath } = await fixture(t);
  await writeFile(legacyThemePath, `${DEFAULT_THEME_ID}\n`);
  let randomCalls = 0;

  const result = await migrateLegacyState({
    statePath,
    lease: testLeaseFor(statePath),
    legacyThemePath,
    legacyAgentLoaded: true,
    themeExists: async (id) => id === DEFAULT_THEME_ID,
    randomBytes: (size) => {
      assert.equal(size, 32);
      randomCalls += 1;
      return Buffer.alloc(32, 7);
    },
  });

  assert.equal(result.migratedFrom, "watchdog");
  assert.equal(result.state.schemaVersion, 2);
  assert.equal(result.state.persistenceEnabled, true);
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.controlToken, Buffer.alloc(32, 7).toString("base64url"));
  assert.match(result.state.controlToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.state.controlToken.includes("="), false);
  assert.equal(Buffer.from(result.state.controlToken, "base64url").length, 32);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(statePath, ".."))).mode & 0o777, 0o700);

  await writeFile(legacyThemePath, "genshin-night\n");
  const second = await migrateLegacyState({
    statePath,
    lease: testLeaseFor(statePath),
    legacyThemePath,
    legacyAgentLoaded: true,
    themeExists: async () => true,
    randomBytes: () => {
      throw new Error("existing state must not request a new token");
    },
  });
  assert.equal(second.migratedFrom, null);
  assert.deepEqual(second.state, result.state);
  assert.equal(randomCalls, 1);
});

test("new installs default off while invalid loaded legacy state fails closed", async (t) => {
  const first = await fixture(t);
  const fresh = await migrateLegacyState({
    statePath: first.statePath,
    lease: testLeaseFor(first.statePath),
    legacyAgentLoaded: false,
    themeExists: async (id) => id === DEFAULT_THEME_ID,
    randomBytes: () => Buffer.alloc(32, 5),
  });
  assert.equal(fresh.migratedFrom, null);
  assert.equal(fresh.state.persistenceEnabled, false);
  assert.equal(fresh.state.selectedThemeId, DEFAULT_THEME_ID);
  assert.equal(fresh.state.revision, 0);

  const second = await fixture(t);
  await writeFile(second.legacyThemePath, "not a valid theme id!\n");
  await assert.rejects(
    () => migrateLegacyState({
      statePath: second.statePath,
      lease: testLeaseFor(second.statePath),
      legacyThemePath: second.legacyThemePath,
      legacyAgentLoaded: true,
      themeExists: async () => true,
      randomBytes: () => Buffer.alloc(32, 5),
    }),
    /旧版主题状态无效/,
  );
  assert.equal(await readStudioState(second.statePath), null);
});

test("compare and update returns current state on conflict and increments revision on success", async (t) => {
  const { statePath } = await fixture(t);
  await writeStudioState(statePath, stateAtRevision(3));
  const lease = testLeaseFor(statePath);

  await assert.rejects(
    () => compareAndUpdateStudioState(statePath, {
      lease,
      expectedRevision: 2,
      mutate: (state) => state,
    }),
    (error) => {
      assert.equal(error.code, "REVISION_CONFLICT");
      assert.equal(error.revision, 3);
      assert.equal(error.persistenceEnabled, true);
      assert.deepEqual(Object.keys(error).sort(), [
        "code",
        "persistenceEnabled",
        "revision",
      ]);
      const serialized = JSON.stringify(error);
      assert.doesNotMatch(serialized, new RegExp(CONTROL_TOKEN));
      assert.doesNotMatch(serialized, /controlToken|selectedThemeId|lastTransitionNonce/);
      return true;
    },
  );

  let mutationInput;
  const changed = await compareAndUpdateStudioState(statePath, {
    lease,
    expectedRevision: 3,
    mutate: (state) => {
      mutationInput = state;
      state.selectedThemeId = NATIVE_THEME_ID;
      state.revision = 999;
      return state;
    },
  });
  assert.notStrictEqual(mutationInput, changed);
  assert.equal(changed.revision, 4);
  assert.equal(changed.selectedThemeId, NATIVE_THEME_ID);
  assert.equal(changed.lastNonNativeThemeId, DEFAULT_THEME_ID);
  assert.deepEqual(await readStudioState(statePath), changed);

  await assert.rejects(
    () => compareAndUpdateStudioState(statePath, {
      lease,
      expectedRevision: 4,
      mutate: (state) => ({ ...state, lastNonNativeThemeId: NATIVE_THEME_ID }),
    }),
  );
  assert.deepEqual(await readStudioState(statePath), changed);
});

test("leased state changes fail closed when the lease is absent, unrelated, or lost before write", async (t) => {
  const { root, statePath } = await fixture(t);
  const original = stateAtRevision(3);
  await writeStudioState(statePath, original);

  await assert.rejects(
    () => compareAndUpdateStudioState(statePath, {
      expectedRevision: 3,
      mutate: (state) => state,
    }),
    /operation lease/i,
  );
  await assert.rejects(
    () => compareAndUpdateStudioState(statePath, {
      lease: testLeaseFor(join(root, "unrelated", "state.json")),
      expectedRevision: 3,
      mutate: (state) => state,
    }),
    /same state directory/i,
  );

  const lostLease = testLeaseFor(statePath);
  await assert.rejects(
    () => compareAndUpdateStudioState(statePath, {
      lease: lostLease,
      expectedRevision: 3,
      mutate: (state) => {
        lostLease.lose();
        return { ...state, persistenceEnabled: false };
      },
    }),
    (error) => error.code === "LOCK_NOT_OWNED",
  );
  assert.ok(lostLease.assertions >= 2);
  assert.deepEqual(await readStudioState(statePath), original);

  const expiresDuringWrite = testLeaseFor(statePath, { failAtAssertion: 4 });
  await assert.rejects(
    () => compareAndUpdateStudioState(statePath, {
      lease: expiresDuringWrite,
      expectedRevision: 3,
      mutate: (state) => ({ ...state, persistenceEnabled: false }),
    }),
    (error) => error.code === "LOCK_NOT_OWNED",
  );
  assert.equal(expiresDuringWrite.assertions, 4);
  assert.deepEqual(await readStudioState(statePath), original);

  const migration = await fixture(t);
  const migrationLease = testLeaseFor(migration.statePath);
  await assert.rejects(
    () => migrateLegacyState({
      statePath: migration.statePath,
      lease: migrationLease,
      legacyAgentLoaded: false,
      themeExists: async () => {
        migrationLease.lose();
        return true;
      },
      randomBytes: () => Buffer.alloc(32, 5),
    }),
    (error) => error.code === "LOCK_NOT_OWNED",
  );
  assert.equal(await readStudioState(migration.statePath), null);
});

test("a real operation lease authorizes CAS only while its claim remains owned", {
  skip: process.platform === "win32",
}, async (t) => {
  const { statePath } = await fixture(t);
  await writeStudioState(statePath, stateAtRevision(3));
  const stateRoot = await realpath(dirname(statePath));
  const canonicalStatePath = join(stateRoot, "state.json");
  const identity = {
    pid: process.pid,
    startedAt: "2026-07-17T08:00:00.000Z",
  };
  const lease = await acquireOperationLock({
    lockPath: join(stateRoot, "operation.lock"),
    stateRoot,
    operation: "state-cas-integration",
    identity,
    readProcessIdentity: async (pid) => (pid === identity.pid ? identity : null),
  });
  t.after(() => lease.release());

  const changed = await compareAndUpdateStudioState(canonicalStatePath, {
    lease,
    expectedRevision: 3,
    mutate: (state) => ({ ...state, persistenceEnabled: false }),
  });
  assert.equal(changed.revision, 4);
  assert.equal(changed.persistenceEnabled, false);

  assert.equal(await lease.release(), true);
  await assert.rejects(
    () => compareAndUpdateStudioState(canonicalStatePath, {
      lease,
      expectedRevision: 4,
      mutate: (state) => state,
    }),
    (error) => error.code === "LOCK_NOT_OWNED",
  );
  assert.deepEqual(await readStudioState(canonicalStatePath), changed);
});

test("state writes are private and atomic write failures clean sibling temporary files", async (t) => {
  const { root, statePath } = await fixture(t);
  const state = stateAtRevision(0);
  await writeStudioState(statePath, state);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.deepEqual(await readStudioState(statePath), state);

  if (process.platform !== "win32" && typeof process.getuid === "function") {
    await chmod(statePath, 0o000);
    try {
      await assert.rejects(
        () => readStudioState(statePath),
        (error) => error.code === "STATE_FILE_MODE_INVALID",
      );
    } finally {
      await chmod(statePath, 0o600);
    }
  }

  const badPath = join(root, "atomic", "state.json");
  await mkdir(badPath, { recursive: true });
  await assert.rejects(() => writeStudioState(badPath, state));
  const siblings = await readdir(join(root, "atomic"));
  assert.deepEqual(siblings, ["state.json"]);
});

test("fault before rename preserves old state and cleans newly synced private directories", async (t) => {
  const { root, statePath } = await fixture(t);
  const original = stateAtRevision(0);
  const changed = stateAtRevision(1, { persistenceEnabled: false });
  await writeStudioState(statePath, original);

  await assert.rejects(
    () => writeStudioState(statePath, changed, { faultAt: "after-temp-sync" }),
    (error) => error.code === "FAULT_AFTER_TEMP_SYNC",
  );
  assert.deepEqual(await readStudioState(statePath), original);
  assert.deepEqual(await readdir(dirname(statePath)), ["state.json"]);

  const freshPath = join(root, "fresh", "nested", "state.json");
  await assert.rejects(
    () => writeStudioState(freshPath, changed, { faultAt: "after-temp-sync" }),
    (error) => error.code === "FAULT_AFTER_TEMP_SYNC",
  );
  assert.equal(await readStudioState(freshPath), null);
  assert.deepEqual(await readdir(dirname(freshPath)), []);
  if (process.platform !== "win32") {
    assert.equal((await stat(dirname(freshPath))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, "fresh"))).mode & 0o777, 0o700);
  }
});

test("POSIX readers reject links, non-files, wrong modes, and insecure parents", {
  skip: process.platform === "win32",
}, async (t) => {
  const { root, statePath } = await fixture(t);
  const state = stateAtRevision(0);
  await writeStudioState(statePath, state);

  const targetPath = join(root, "outside-state.json");
  await writeFile(targetPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rm(statePath);
  await symlink(targetPath, statePath);
  await assert.rejects(
    () => readStudioState(statePath),
    (error) => error.code === "STATE_PATH_SYMLINK",
  );

  const outsideDirectory = join(root, "outside-state");
  const linkedDirectory = join(root, "linked-state");
  await mkdir(outsideDirectory, { mode: 0o700 });
  await writeFile(
    join(outsideDirectory, "state.json"),
    `${JSON.stringify(state)}\n`,
    { mode: 0o600 },
  );
  await symlink(outsideDirectory, linkedDirectory);
  await assert.rejects(
    () => readStudioState(join(linkedDirectory, "state.json")),
    (error) => error.code === "STATE_PARENT_SYMLINK",
  );

  await rm(statePath);
  await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o644);
  await assert.rejects(
    () => readStudioState(statePath),
    (error) => error.code === "STATE_FILE_MODE_INVALID",
  );

  await chmod(statePath, 0o600);
  await chmod(dirname(statePath), 0o755);
  await assert.rejects(
    () => readStudioState(statePath),
    (error) => error.code === "STATE_PARENT_MODE_INVALID",
  );
  await chmod(dirname(statePath), 0o700);
  assert.deepEqual(await readStudioState(statePath), state);

  await rm(statePath);
  await mkdir(statePath, { mode: 0o700 });
  await assert.rejects(
    () => readStudioState(statePath),
    (error) => error.code === "STATE_FILE_TYPE_INVALID",
  );
});

test("journal and session readers reject unknown schemas and malformed shapes", async (t) => {
  const { sessionPath, transitionPath } = await fixture(t);
  await writeTransitionJournal(transitionPath, disableJournal());
  assert.equal((await stat(transitionPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readTransitionJournal(transitionPath), disableJournal());
  await clearTransitionJournal(transitionPath);
  await clearTransitionJournal(transitionPath);
  assert.equal(await readTransitionJournal(transitionPath), null);

  await mkdir(join(transitionPath, ".."), { recursive: true });
  await writeFile(
    transitionPath,
    JSON.stringify({ ...disableJournal(), schemaVersion: 9 }),
    { mode: 0o600 },
  );
  await assert.rejects(() => readTransitionJournal(transitionPath), /schema/i);
  await writeFile(transitionPath, "{");
  await assert.rejects(() => readTransitionJournal(transitionPath), /迁移日志损坏/);

  await writeFile(sessionPath, JSON.stringify({ schemaVersion: 9 }), { mode: 0o600 });
  await assert.rejects(() => readSessionState(sessionPath), /schema/i);
  await writeFile(sessionPath, JSON.stringify({
    schemaVersion: 1,
    mode: "unknown",
    process: null,
    activeThemeId: null,
    keepUntilProcessExit: false,
  }));
  await assert.rejects(() => readSessionState(sessionPath));
});

test("session modes enforce their documented discriminated invariants", () => {
  const active = {
    schemaVersion: 1,
    mode: "active",
    process: CURRENT_PROCESS,
    activeThemeId: DEFAULT_THEME_ID,
    keepUntilProcessExit: false,
  };

  for (const malformed of [
    { ...active, process: null },
    { ...active, activeThemeId: null },
    { ...active, mode: "paused", process: null, activeThemeId: null },
    { ...active, mode: "paused" },
    { ...active, mode: "native", activeThemeId: DEFAULT_THEME_ID },
    { ...active, mode: "restoring", process: null, activeThemeId: null },
    {
      ...active,
      mode: "restoring",
      activeThemeId: null,
      keepUntilProcessExit: true,
    },
    { ...active, mode: "error" },
    { ...active, mode: "error", activeThemeId: null, keepUntilProcessExit: true },
  ]) {
    assert.throws(() => validateSessionState(malformed), /session mode invariant/i);
  }

  for (const valid of [
    active,
    { ...active, mode: "paused", activeThemeId: null },
    {
      ...active,
      mode: "paused",
      activeThemeId: null,
      keepUntilProcessExit: true,
    },
    {
      ...active,
      mode: "native",
      process: null,
      activeThemeId: null,
    },
    {
      ...active,
      mode: "native",
      activeThemeId: null,
      keepUntilProcessExit: true,
    },
    { ...active, mode: "restoring", activeThemeId: null },
    {
      ...active,
      mode: "error",
      process: null,
      activeThemeId: null,
    },
    { ...active, mode: "error", activeThemeId: null },
  ]) {
    assert.deepEqual(validateSessionState(valid), valid);
  }
});

test("prepared recovery commits state, rebuilds exact live session, and clears journal", async (t) => {
  const { statePath, sessionPath, transitionPath } = await fixture(t);
  await writeStudioState(statePath, stateAtRevision(3));
  await writeTransitionJournal(transitionPath, disableJournal());

  const recovered = await recoverStateTransition({
    statePath,
    sessionPath,
    transitionPath,
    lease: testLeaseFor(statePath),
    currentProcess: CURRENT_PROCESS,
  });

  assert.equal(recovered.state.persistenceEnabled, false);
  assert.equal(recovered.state.revision, 4);
  assert.equal(recovered.state.lastTransitionNonce, "transition-1");
  assert.deepEqual(recovered.session, {
    schemaVersion: 1,
    mode: "active",
    process: CURRENT_PROCESS,
    activeThemeId: DEFAULT_THEME_ID,
    keepUntilProcessExit: true,
  });
  assert.deepEqual(await readSessionState(sessionPath), recovered.session);
  assert.equal(await readTransitionJournal(transitionPath), null);
});

test("prepared recovery resumes an already committed CAS without another revision", async (t) => {
  const { statePath, sessionPath, transitionPath } = await fixture(t);
  await writeStudioState(statePath, stateAtRevision(3));
  await writeTransitionJournal(transitionPath, disableJournal());
  await compareAndUpdateStudioState(statePath, {
    lease: testLeaseFor(statePath),
    expectedRevision: 3,
    mutate: (state) => ({
      ...state,
      persistenceEnabled: false,
      lastTransitionNonce: "transition-1",
    }),
  });

  const recovered = await recoverStateTransition({
    statePath,
    sessionPath,
    transitionPath,
    lease: testLeaseFor(statePath),
    currentProcess: CURRENT_PROCESS,
  });
  assert.equal(recovered.state.revision, 4);
  assert.equal(recovered.session.keepUntilProcessExit, true);
  assert.equal(await readTransitionJournal(transitionPath), null);
});

test("state-committed and session-committed recovery stages are idempotent", async (t) => {
  for (const stage of ["state-committed", "session-committed"]) {
    const paths = await fixture(t);
    const committed = stateAtRevision(4, {
      persistenceEnabled: false,
      lastTransitionNonce: "transition-1",
    });
    const session = {
      schemaVersion: 1,
      mode: "active",
      process: CURRENT_PROCESS,
      activeThemeId: DEFAULT_THEME_ID,
      keepUntilProcessExit: true,
    };
    await writeStudioState(paths.statePath, committed);
    await writeTransitionJournal(paths.transitionPath, disableJournal({ stage }));
    if (stage === "session-committed") await writeSessionState(paths.sessionPath, session);

    const recovered = await recoverStateTransition({
      statePath: paths.statePath,
      sessionPath: paths.sessionPath,
      transitionPath: paths.transitionPath,
      lease: testLeaseFor(paths.statePath),
      currentProcess: CURRENT_PROCESS,
    });
    assert.deepEqual(recovered.state, committed);
    assert.deepEqual(recovered.session, session);
    assert.equal(await readTransitionJournal(paths.transitionPath), null);
  }
});

test("transition recovery fails closed on revision, desired value, or nonce mismatch", async (t) => {
  const cases = [
    stateAtRevision(5, { persistenceEnabled: false, lastTransitionNonce: "transition-1" }),
    stateAtRevision(4, { persistenceEnabled: true, lastTransitionNonce: "transition-1" }),
    stateAtRevision(4, { persistenceEnabled: false, lastTransitionNonce: "someone-else" }),
  ];

  for (const state of cases) {
    const paths = await fixture(t);
    await writeStudioState(paths.statePath, state);
    await writeTransitionJournal(paths.transitionPath, disableJournal());
    await assert.rejects(
      () => recoverStateTransition({
        statePath: paths.statePath,
        sessionPath: paths.sessionPath,
        transitionPath: paths.transitionPath,
        lease: testLeaseFor(paths.statePath),
        currentProcess: CURRENT_PROCESS,
      }),
      (error) => {
        assert.equal(error.code, "TRANSITION_CONFLICT");
        assert.equal(error.revision, state.revision);
        assert.equal(error.persistenceEnabled, state.persistenceEnabled);
        assert.deepEqual(Object.keys(error).sort(), [
          "code",
          "persistenceEnabled",
          "revision",
        ]);
        const serialized = JSON.stringify(error);
        assert.doesNotMatch(serialized, new RegExp(CONTROL_TOKEN));
        assert.doesNotMatch(serialized, /executablePath|transition-1|journal|process/);
        return true;
      },
    );
    assert.notEqual(await readTransitionJournal(paths.transitionPath), null);
    assert.equal(await readSessionState(paths.sessionPath), null);
  }
});

test("disable recovery completes without retaining injection after the exact process exits", async (t) => {
  const { statePath, sessionPath, transitionPath } = await fixture(t);
  await writeStudioState(statePath, stateAtRevision(3));
  await writeTransitionJournal(transitionPath, disableJournal());

  const recovered = await recoverStateTransition({
    statePath,
    sessionPath,
    transitionPath,
    lease: testLeaseFor(statePath),
    currentProcess: null,
  });
  assert.equal(recovered.state.persistenceEnabled, false);
  assert.deepEqual(recovered.session, {
    schemaVersion: 1,
    mode: "native",
    process: null,
    activeThemeId: null,
    keepUntilProcessExit: false,
  });
  assert.equal(await readTransitionJournal(transitionPath), null);
});
