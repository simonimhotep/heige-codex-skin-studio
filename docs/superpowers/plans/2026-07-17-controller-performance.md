# Controller Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make healthy controller ticks read-only and keep production operation-lock chains bounded without weakening mutation safety.

**Architecture:** Add a fail-closed health snapshot before the existing leased reconcile path. Only a stable state, session, process, port owner, control server and renderer snapshot may return `idle`; every other observation falls back to the existing lock-protected reconcile. Production state locks use the already-tested compaction protocol at a lower threshold.

**Tech Stack:** Node.js 22, ES modules, `node:test`, durable POSIX operation lock.

---

### Task 1: Healthy tick fast path

**Files:**
- Modify: `test/controller.test.mjs`
- Modify: `src/controller.mjs`

- [ ] **Step 1: Write the failing tests**

Add tests proving a healthy tick does not append `controller:tick` to `fx.calls.lease`, while state drift, session drift, port-owner failure, missing server and unhealthy renderer still use the leased path.

```js
test("a stable healthy tick never acquires the durable operation lease", async () => {
  const fx = fixture();
  const controller = createSkinController(fx.deps);
  await controller.start();
  fx.calls.lease.length = 0;
  const current = await controller.tick();
  assert.equal(current.action, "idle");
  assert.deepEqual(fx.calls.lease, []);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="stable healthy tick" test/controller.test.mjs`

Expected: FAIL because `controller:tick` is still acquired.

- [ ] **Step 3: Implement the fail-closed snapshot**

Add `healthyTickSnapshot()` inside `createSkinController`. It must read state, session and process twice, require no transition journal, require the existing control server, validate port ownership, analyze renderer health, compare both snapshots exactly, then return `idle`. It must return `null` on any uncertainty so `tick()` calls the existing `runSafe("controller:tick", ...)`.

```js
const sameSnapshot = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);

const healthyTickSnapshot = async () => {
  if (server === null || typeof deps.inspectSkin !== "function") return null;
  const before = {
    state: validateControlState(await deps.readState()),
    session: await deps.readSession(),
    transition: await deps.readTransition(),
    process: await probeProcess(),
  };
  if (before.transition !== null || !before.state.persistenceEnabled) return null;
  if (!sameProcessIdentity(before.session?.process, before.process)) return null;
  await assertPortOwner(before.process);
  const health = analyzeRendererHealth(await deps.inspectSkin({
    expected: {
      themeId: before.state.selectedThemeId,
      mode: before.state.selectedThemeId === NATIVE_THEME_ID ? "native" : "active",
      persistenceEnabled: true,
      revision: before.state.revision,
    },
    process: before.process,
  }), before.state);
  if (health.repairTargets?.length !== 0) return null;
  const after = {
    state: validateControlState(await deps.readState()),
    session: await deps.readSession(),
    transition: await deps.readTransition(),
    process: await probeProcess(),
  };
  return sameSnapshot(before, after) ? result("idle", before.session.mode, before.state) : null;
};
```

- [ ] **Step 4: Run controller tests and verify GREEN**

Run: `node --test test/controller.test.mjs`

Expected: all controller tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/controller.mjs test/controller.test.mjs
git commit -m "perf: avoid durable lock on healthy controller ticks"
```

### Task 2: Production lock compaction threshold

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1: Write the failing test**

Export the production lock option builder for test and assert:

```js
assert.equal((await productionLockOptions(paths, "darwin")).compactionThreshold, 8);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="production lock compaction" test/cli.test.mjs`

Expected: FAIL because the builder is private and uses the default threshold.

- [ ] **Step 3: Implement the threshold**

Rename `lockOptions` to `productionLockOptions`, export it, and include:

```js
compactionThreshold: 8,
```

Update internal callers without changing Windows or ephemeral lock semantics.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/cli.test.mjs test/operation-lock.test.mjs`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "perf: compact production lock chains earlier"
```

### Task 3: Immediate renderer feedback with durable confirmation

**Files:**
- Modify: `src/skin-menu.mjs`
- Modify: `test/skin-menu.dom.test.mjs`

- [ ] **Step 1: Write the failing interaction tests**

Use a deferred theme response and prove that the target CSS is rendered immediately while the compatibility selection remains unchanged. Cover success, controller fallback, revision conflict, and rollback.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test --test-name-pattern="renders immediately|renderer-blocked theme request" test/skin-menu.dom.test.mjs`

Expected: FAIL because the current renderer waits for the HTTP response before changing CSS.

- [ ] **Step 3: Implement optimistic rendering with rollback**

Apply the target theme only to the current renderer before the request. Keep authoritative state, local selection storage, and cross-window broadcast behind the existing controller acknowledgement. Restore the previous formal, custom, or native theme when the request is rejected, superseded, or times out.

- [ ] **Step 4: Run the menu regression suite**

Run: `node --test test/skin-menu.test.mjs test/skin-menu.dom.test.mjs test/skin-css.test.mjs`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/skin-menu.mjs test/skin-menu.dom.test.mjs
git commit -m "perf: render theme switches before durable acknowledgement"
```
