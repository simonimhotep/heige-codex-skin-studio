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
} = {}) {
  const events = [];
  let journal = null;
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
    prepareTree: async () => (mark("tree-prepare"), tree),
    publishTree: async () => mark("tree-publish"),
    rollbackTree: async () => mark("tree-rollback"),
    finalizeTree: async () => mark("tree-finalize"),
    prepareLauncher: async () => (mark("launcher-prepare"), launcher),
    publishLauncher: async () => mark("launcher-publish"),
    rollbackLauncher: async () => mark("launcher-rollback"),
    finalizeLauncher: async () => mark("launcher-finalize"),
    prepareState: async (input) => (mark("state-prepare", input), state),
    publishState: async () => mark("state-publish"),
    rollbackState: async () => mark("state-rollback"),
    finalizeState: async () => mark("state-finalize"),
    createFreezeDescriptor: async () => (mark("freeze-intent"), freeze),
    prepareFreeze: async () => (mark("freeze-prepare"), {
      servicesFound: true,
      transaction: freeze,
    }),
    stopFreezeForRollback: async () => mark("freeze-stop"),
    rollbackFreeze: async () => mark("freeze-rollback"),
    finalizeFreeze: async (_descriptor, options) => mark("freeze-finalize", options),
    awaitExactReady: async (input) => {
      mark("ready", input.outerTransaction);
      if (ready) return ready(input);
      return { persistenceEnabled: true, revision: state.afterState.revision };
    },
    checkpoint: async (phase) => {
      mark("checkpoint", phase);
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
