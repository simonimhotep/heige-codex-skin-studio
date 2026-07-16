import assert from "node:assert/strict";
import test from "node:test";

import {
  coordinateMacosInstall,
  recoverMacosInstallTransaction,
} from "../src/macos-install-coordinator.mjs";

const INPUT = Object.freeze({
  home: "/Users/tester",
  port: 9341,
  sourceRoot: "/source",
  stateRoot: "/Users/tester/Library/Application Support/HeiGeCodexSkinStudio",
  targetRoot: "/Users/tester/.codex/heige-codex-skin-studio",
});

function hardCrash(message) {
  const error = new Error(message);
  error.simulatedHardCrash = true;
  return error;
}

function fixture({
  persistenceEnabled = false,
  services = {},
  checkpoint = null,
  ready = null,
  crashAt = null,
  actionCrashAt = null,
} = {}) {
  const events = [];
  let journal = null;
  let crashInjected = false;
  const transactionId = "123e4567-e89b-42d3-a456-426614174000";
  const tree = { transactionId, kind: "tree" };
  const launcher = { transactionId, kind: "launcher" };
  const state = {
    transactionId,
    afterState: {
      schemaVersion: 1,
      persistenceEnabled,
      revision: persistenceEnabled ? 4 : 0,
      controlToken: "token",
    },
  };
  const freeze = { transactionId, operation: "freeze-stable-services" };
  const mark = (name, value) => {
    events.push(value === undefined ? name : [name, value]);
  };
  const crashAfter = (name) => {
    if (actionCrashAt === name && !crashInjected) {
      crashInjected = true;
      throw hardCrash(`action crash at ${name}`);
    }
  };
  const deps = {
    journalPath: "/Users/tester/Library/Application Support/HeiGeCodexSkinStudio/macos-install.json",
    randomUUID: () => transactionId,
    withCoordinatorLock: async (action) => {
      mark("coordinator-lock");
      return action();
    },
    acquireTreeLock: async () => ({
      release: async () => mark("tree-unlock"),
    }),
    acquireLauncherLock: async (options) => {
      mark("launcher-lock", options);
      return {
        applicationsPriorExisted: true,
        release: async () => mark("launcher-unlock"),
      };
    },
    readJournal: async () => journal,
    createJournal: async (input) => {
      mark("journal-create");
      journal = {
        ...input,
        decision: "undecided",
        phase: "skeleton",
        activation: "pending",
        treeParticipant: null,
        launcherParticipant: null,
        stateParticipant: null,
        freezeParticipant: null,
        ack: null,
      };
      return journal;
    },
    updateJournal: async (current, changes) => {
      assert.equal(current, journal);
      mark("journal-update", changes.phase);
      journal = { ...journal, ...changes };
      return journal;
    },
    clearJournal: async () => {
      mark("journal-clear");
      if (crashAt === "journal-clear" && !crashInjected) {
        crashInjected = true;
        throw hardCrash("crash at journal-clear");
      }
      journal = null;
    },
    recoverStandaloneTree: async () => mark("tree-recover-under-lock"),
    recoverTreePreparation: async () => mark("tree-preparation-recover"),
    recoverLauncherPreparation: async () => mark("launcher-preparation-recover"),
    inspectServices: async () => ({
      controllerLoaded: false,
      controllerPresent: false,
      legacyLoaded: false,
      legacyPresent: false,
      ...services,
    }),
    prepareTree: async () => {
      mark("tree-prepare");
      crashAfter("tree-prepare");
      return tree;
    },
    publishTree: async () => {
      mark("tree-publish");
      crashAfter("tree-publish");
    },
    rollbackTree: async () => {
      mark("tree-rollback");
      crashAfter("tree-rollback");
    },
    finalizeTree: async () => mark("tree-finalize"),
    prepareLauncher: async () => {
      mark("launcher-prepare");
      crashAfter("launcher-prepare");
      return launcher;
    },
    publishLauncher: async () => {
      mark("launcher-publish");
      crashAfter("launcher-publish");
    },
    rollbackLauncher: async () => {
      mark("launcher-rollback");
      crashAfter("launcher-rollback");
    },
    finalizeLauncher: async () => mark("launcher-finalize"),
    prepareState: async (input) => {
      mark("state-prepare", input);
      crashAfter("state-prepare");
      return state;
    },
    publishState: async () => {
      mark("state-publish");
      crashAfter("state-publish");
    },
    rollbackState: async () => {
      mark("state-rollback");
      crashAfter("state-rollback");
    },
    finalizeState: async () => mark("state-finalize"),
    createFreezeDescriptor: async () => (mark("freeze-intent"), freeze),
    prepareFreeze: async () => {
      mark("freeze-prepare");
      crashAfter("freeze-prepare");
      return { servicesFound: true, transaction: freeze };
    },
    stopFreezeForRollback: async () => {
      mark("freeze-stop");
      crashAfter("freeze-stop");
    },
    rollbackFreeze: async () => {
      mark("freeze-rollback");
      crashAfter("freeze-rollback");
    },
    finalizeFreezeRollback: async () => {
      mark("freeze-rollback-finalize");
      crashAfter("freeze-rollback-finalize");
    },
    finalizeFreeze: async (_descriptor, options) => mark("freeze-finalize", options),
    awaitExactReady: async (input) => {
      mark("ready", input.outerTransaction);
      crashAfter("ready");
      if (ready) return ready(input);
      return { persistenceEnabled: true, revision: state.afterState.revision };
    },
    checkpoint: async (phase) => {
      mark("checkpoint", phase);
      if (phase === crashAt && !crashInjected) {
        crashInjected = true;
        throw hardCrash(`crash at ${phase}`);
      }
      return checkpoint?.(phase);
    },
  };
  return { deps, events, get journal() { return journal; } };
}

test("ordinary non-persistent install never activates a controller and migrates only loaded legacy state", async () => {
  const fx = fixture({ services: { legacyPresent: true, legacyLoaded: false } });
  const result = await coordinateMacosInstall(INPUT, fx.deps);

  assert.equal(result.persistenceEnabled, false);
  assert.equal(fx.events.some((entry) => Array.isArray(entry) && entry[0] === "ready"), false);
  assert.deepEqual(
    fx.events.find((entry) => Array.isArray(entry) && entry[0] === "state-prepare")[1],
    { transactionId: "123e4567-e89b-42d3-a456-426614174000", legacyAgentLoaded: false },
  );
  assert.deepEqual(
    fx.events.find((entry) => Array.isArray(entry) && entry[0] === "freeze-finalize")[1],
    { removeFrozenServices: true },
  );
  assert.equal(fx.events.indexOf("tree-recover-under-lock") > fx.events.indexOf("coordinator-lock"), true);
});

test("an already loaded controller preserves persistence intent even without a legacy watchdog", async () => {
  const fx = fixture({
    persistenceEnabled: true,
    services: { controllerLoaded: true, controllerPresent: true },
  });
  await coordinateMacosInstall(INPUT, fx.deps);
  assert.equal(
    fx.events.find((entry) => Array.isArray(entry) && entry[0] === "state-prepare")[1]
      .legacyAgentLoaded,
    true,
  );
});

test("non-persistent activation-skipped crash rolls back without starting a controller", async () => {
  const fx = fixture({ crashAt: "activation-skipped" });
  await assert.rejects(coordinateMacosInstall(INPUT, fx.deps), /crash at/);
  await recoverMacosInstallTransaction(fx.deps);
  assert.equal(fx.journal, null);
  assert.equal(fx.events.some((entry) => Array.isArray(entry) && entry[0] === "ready"), false);
  assert.equal(fx.events.includes("freeze-stop"), false);
});

test("readiness failure durably decides rollback and reverses state launcher tree then freeze", async () => {
  const fx = fixture({
    persistenceEnabled: true,
    ready: async () => { throw new Error("ACK timeout"); },
  });
  await assert.rejects(coordinateMacosInstall(INPUT, fx.deps), /ACK timeout/);

  const ordered = ["freeze-stop", "state-rollback", "launcher-rollback", "tree-rollback", "freeze-rollback"];
  assert.deepEqual(fx.events.filter((entry) => ordered.includes(entry)), ordered);
  assert.equal(fx.journal, null);
});

for (const prestate of ["controller-only", "both", "none"]) {
  test(`rollback recovery preserves the exact ${prestate} freeze prestate after outer clear crashes`, async () => {
    const fx = fixture({
      persistenceEnabled: true,
      crashAt: "journal-clear",
      ready: async () => {
        current.controller = { bytes: "new", loaded: true, mode: 0o600 };
        throw new Error("ACK timeout after controller activation");
      },
    });
    const expected = {
      controller: prestate === "none"
        ? null
        : { bytes: "old-controller", loaded: true, mode: 0o640 },
      watchdog: prestate === "both"
        ? { bytes: "old-watchdog", loaded: true, mode: 0o600 }
        : null,
    };
    const current = structuredClone(expected);
    let freezeJournal = null;

    fx.deps.prepareFreeze = async () => {
      freezeJournal = prestate === "none" ? null : structuredClone(expected);
      current.controller = null;
      current.watchdog = null;
      return {
        servicesFound: prestate !== "none",
        transaction: prestate === "none"
          ? null
          : { transactionId: "123e4567-e89b-42d3-a456-426614174000", operation: "freeze-stable-services" },
      };
    };
    fx.deps.stopFreezeForRollback = async () => {
      current.controller = null;
      if (freezeJournal !== null) current.watchdog = null;
    };
    fx.deps.rollbackFreeze = async () => {
      if (freezeJournal === null) return { rolledBack: false };
      current.controller = structuredClone(freezeJournal.controller);
      current.watchdog = structuredClone(freezeJournal.watchdog);
      return { rolledBack: true };
    };
    fx.deps.finalizeFreezeRollback = async () => {
      freezeJournal = null;
      return { finalized: true };
    };

    await assert.rejects(
      coordinateMacosInstall(INPUT, fx.deps),
      /macOS install failed and recovery did not finish/,
    );
    assert.deepEqual(current, expected, "first rollback restored the exact old prestate");

    await recoverMacosInstallTransaction(fx.deps);

    assert.equal(fx.journal, null);
    assert.deepEqual(current, expected, "second recovery must not delete restored prestate");
  });
}

for (const [faultKind, boundary] of [
  ["actionCrashAt", "freeze-stop"],
  ["actionCrashAt", "state-rollback"],
  ["actionCrashAt", "launcher-rollback"],
  ["actionCrashAt", "tree-rollback"],
  ["actionCrashAt", "freeze-rollback"],
  ["crashAt", "freeze-rollback-restored"],
  ["actionCrashAt", "freeze-rollback-finalize"],
  ["crashAt", "freeze-rollback-finalized"],
  ["crashAt", "journal-clear"],
]) {
  test(`rollback recovery is idempotent after a hard crash at ${boundary}`, async () => {
    const fx = fixture({
      persistenceEnabled: true,
      [faultKind]: boundary,
      ready: async () => { throw new Error("ACK timeout"); },
    });

    await assert.rejects(coordinateMacosInstall(INPUT, fx.deps), /crash|failed/i);
    assert.notEqual(fx.journal, null);

    await recoverMacosInstallTransaction(fx.deps);

    assert.equal(fx.journal, null);
  });
}

test("hard crash after tree publication remains recoverable from the durable outer journal", async () => {
  const fx = fixture({
    checkpoint: async (phase) => {
      if (phase === "tree-published") throw hardCrash("tree publish crash");
    },
  });
  await assert.rejects(coordinateMacosInstall(INPUT, fx.deps), /tree publish crash/);
  assert.equal(fx.journal.phase, "tree-published");

  await recoverMacosInstallTransaction(fx.deps);
  assert.equal(fx.journal, null);
  assert.deepEqual(
    fx.events.filter((entry) => ["state-rollback", "launcher-rollback", "tree-rollback", "freeze-rollback"].includes(entry)).slice(-4),
    ["state-rollback", "launcher-rollback", "tree-rollback", "freeze-rollback"],
  );
});

test("a crash after the global commit decision only rolls participants forward", async () => {
  const fx = fixture({
    checkpoint: async (phase) => {
      if (phase === "after-commit-decision") throw hardCrash("commit crash");
    },
  });
  await assert.rejects(coordinateMacosInstall(INPUT, fx.deps), /commit crash/);
  assert.equal(fx.journal.decision, "commit");

  await recoverMacosInstallTransaction(fx.deps);
  assert.equal(fx.journal, null);
  assert.equal(fx.events.includes("state-rollback"), false);
  assert.deepEqual(
    fx.events.filter((entry) => ["state-finalize", "launcher-finalize", "tree-finalize"].includes(entry)).slice(-3),
    ["state-finalize", "launcher-finalize", "tree-finalize"],
  );
});

for (const phase of [
  "skeleton",
  "tree-prepared",
  "launcher-prepared",
  "state-prepared",
  "freeze-intent",
  "services-frozen",
  "tree-published",
  "launcher-published",
  "state-published",
  "activation-planned",
  "service-prepared",
  "ready-acked",
]) {
  test(`precommit hard crash at ${phase} is recovered only by rollback`, async () => {
    const fx = fixture({ persistenceEnabled: true, crashAt: phase });
    await assert.rejects(coordinateMacosInstall(INPUT, fx.deps), /crash at/);
    await recoverMacosInstallTransaction(fx.deps);
    assert.equal(fx.journal, null);
    assert.equal(fx.events.includes("tree-finalize"), false);
    if (["activation-planned", "service-prepared", "ready-acked"].includes(phase)) {
      assert.equal(fx.events.includes("freeze-stop"), true);
    }
  });
}

for (const action of [
  "tree-prepare",
  "launcher-prepare",
  "state-prepare",
  "freeze-prepare",
  "tree-publish",
  "launcher-publish",
  "state-publish",
  "ready",
]) {
  test(`hard crash inside ${action} is recovered from the last durable outer phase`, async () => {
    const fx = fixture({ persistenceEnabled: true, actionCrashAt: action });
    await assert.rejects(coordinateMacosInstall(INPUT, fx.deps), /action crash/);
    await recoverMacosInstallTransaction(fx.deps);
    assert.equal(fx.journal, null);
    assert.equal(fx.events.includes("tree-finalize"), false);
    if (action === "tree-prepare") assert.equal(fx.events.includes("tree-preparation-recover"), true);
    if (action === "launcher-prepare") {
      assert.equal(fx.events.includes("launcher-preparation-recover"), true);
    }
    if (action === "ready") assert.equal(fx.events.includes("freeze-stop"), true);
  });
}

for (const phase of [
  "state-finalized",
  "launcher-finalized",
  "tree-finalized",
  "freeze-finalized",
  "journal-clear",
]) {
  test(`postcommit hard crash at ${phase} is recovered only by roll-forward`, async () => {
    const fx = fixture({ crashAt: phase });
    await assert.rejects(coordinateMacosInstall(INPUT, fx.deps), /crash at/);
    assert.equal(fx.journal.decision, "commit");
    await recoverMacosInstallTransaction(fx.deps);
    assert.equal(fx.journal, null);
    assert.equal(fx.events.includes("state-rollback"), false);
  });
}
