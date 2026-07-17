# Injection Lifecycle, Multi-window, and Resource Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate renderer false-success, stale injected closures, split-brain windows, unbounded image work, and the custom-pet install false-success.

**Architecture:** A strict target classifier separates the exact Codex main renderer from the known overlay and every unrelated page. Each injected window owns a disposable generation and synchronizes state through a versioned BroadcastChannel protocol. Node and browser paths share explicit resource budgets; every asynchronous image operation has cancellation and a deadline.

**Tech Stack:** Node.js 22+ ESM, CDP Runtime.evaluate, `happy-dom`, `node:test`, PNG/JPEG/WebP header parsing, BroadcastChannel.

**Prerequisite:** Complete and verify Plans 1 and 2 before this plan.

---

## File map

- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/target-classifier.mjs`
- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/resource-limits.mjs`
- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/image-metadata.mjs`
- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/pet-installer.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/cdp-client.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/injector.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/skin-menu.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/theme-schema.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/theme-store.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/controller.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/cli.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/scripts/install-pet.command`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/custom-pet/install.command`
- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/target-classifier.test.mjs`
- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/image-metadata.test.mjs`
- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/resource-limits.test.mjs`
- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/pet-installer.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/cdp-client.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/injector.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/skin-menu.dom.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/theme-schema.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/theme-store.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/controller.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/custom-pet.test.mjs`

## Task 1: Classify targets strictly and return truthful per-target results

**Files:**

- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/target-classifier.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/cdp-client.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/injector.mjs`
- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/target-classifier.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/cdp-client.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/injector.test.mjs`

- [ ] **Step 1: Write failing classification and false-success tests**

```js
test("recognizes only the observed Codex main and avatar overlay URLs", () => {
  assert.equal(classifyCodexTarget(target("app://-/index.html")), "main");
  assert.equal(classifyCodexTarget(target("app://-/index.html?initialRoute=%2Favatar-overlay")), "overlay");
  assert.equal(classifyCodexTarget(target("app://evil/index.html")), "unknown");
  assert.equal(classifyCodexTarget(target("app://-/settings.html")), "unknown");
  assert.equal(classifyCodexTarget(target("file:///Users/example/report.html")), "unknown");
  assert.equal(classifyCodexTarget(target("http://127.0.0.1:5175/")), "unknown");
});

test("overlay success cannot hide total main-window failure", async () => {
  await assert.rejects(
    removeSkin({ port: 9341, deps: allMainDeadOverlayAlive() }),
    (error) => {
      assert.equal(error.code, "ALL_MAIN_TARGETS_FAILED");
      assert.equal(error.results.failed[0].id, "main-dead");
      assert.equal(error.results.succeeded[0].id, "overlay-alive");
      return true;
    },
  );
});

test("status fails when no main renderer can be read", async () => {
  await assert.rejects(skinStatus({ port: 9341, deps: overlayOnly() }), (error) => error.code === "NO_MAIN_RENDERER");
});
```

- [ ] **Step 2: Verify RED**

```bash
cd "/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio"
node --test test/target-classifier.test.mjs test/injector.test.mjs
```

Expected: FAIL because the current predicate accepts any non-overlay `app://` URL, remove evaluates every discovered app target, and status can return an empty success.

- [ ] **Step 3: Implement strict target and result contracts**

```js
export function classifyCodexTarget(target) {
  if (target?.type !== "page") return "unknown";
  let url;
  try { url = new URL(target.url); } catch { return "unknown"; }
  if (url.protocol !== "app:" || url.hostname !== "-" || url.pathname !== "/index.html" || url.hash) return "unknown";
  if (!url.search) return "main";
  if ([...url.searchParams.keys()].length === 1 && url.searchParams.get("initialRoute") === "/avatar-overlay") return "overlay";
  return "unknown";
}
```

Preserve CDP's loopback WebSocket validation. `fetchRendererTargets()` may return renderer candidates, but only `classifyCodexTargets()` decides whether an operation may touch them. The current Mac read-only evidence on 2026-07-16 showed the exact main URL `app://-/index.html`, the exact overlay query above, plus unrelated `file://` and `http://127.0.0.1` pages; the latter two must never be evaluated.

Every operation returns this nested evidence without removing the existing user-facing summary fields during migration:

```js
{
  succeeded: [{ id, url, kind, value }],
  failed: [{ id, url, kind, error }],
  skipped: [{ id, url, kind, reason }],
}
```

`applySkin` and `skinStatus` touch only `main`. `removeSkin` may clean `main` and the exact known `overlay`, but its success criterion is still the main set. No main produces `NO_MAIN_RENDERER`; every main failing produces `ALL_MAIN_TARGETS_FAILED`; partial failure returns success plus the complete failed records. Errors expose this safe result object and do not include WebSocket URLs or stack traces.

- [ ] **Step 4: Verify GREEN**

```bash
node --test test/target-classifier.test.mjs test/cdp-client.test.mjs test/injector.test.mjs
```

Expected: strict URL, hostile URL, unrelated local page, no-main, all-main-failed, partial-main, and overlay cleanup tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/target-classifier.mjs src/cdp-client.mjs src/injector.mjs test/target-classifier.test.mjs test/cdp-client.test.mjs test/injector.test.mjs
git commit -m "fix(injector): classify Codex targets and reject false success"
```

## Task 2: Give every injected menu a disposable generation

**Files:**

- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/skin-menu.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/injector.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/skin-menu.dom.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/injector.test.mjs`

- [ ] **Step 1: Write failing reinjection and stale-async tests**

```js
test("reinjection disposes the previous generation", async () => {
  const page = await menuWindow();
  const first = page.window.__heigeCodexSkinRuntime;
  await page.injectAgain();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.channel.closed, true);
  assert.notEqual(page.window.__heigeCodexSkinRuntime.generation, first.generation);
});

test("a stale FileReader and Image callback cannot mutate the new menu", async () => {
  const page = await menuWindow({ delayedImage: true });
  const oldImport = page.window.__heigeCodexSkin.importFromDataUrl("data:image/png;base64,old", "old");
  await page.injectAgain();
  page.finishOldImage();
  await assert.rejects(oldImport, /disposed/);
  assert.notEqual(page.document.documentElement.dataset.heigeCodexSkin, "custom-upload");
  assert.equal(page.localStorageWritesAfterReinject, 0);
});

test("remove calls dispose before deleting DOM and API globals", async () => {
  await removeSkin({ port: 9341, deps });
  assert.match(lastExpression, /__heigeCodexSkinRuntime\?\.dispose/);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/skin-menu.dom.test.mjs test/injector.test.mjs
```

Expected: FAIL because liveness currently depends on a connected style node and old event handlers, timers, readers, images, and async continuations survive reinjection.

- [ ] **Step 3: Implement the runtime owner**

At the first line of the evaluated script, call the old runtime's `dispose()`, then create a cryptographically random generation and one `AbortController`. Track every listener, timer, `FileReader`, `Image`, and channel. `dispose()` aborts the signal, removes listeners, clears timers, aborts active readers, detaches image callbacks and sources, closes the channel, removes the menu and style owned by that generation, and deletes APIs only when they still point to that generation.

Every synchronous mutation and every asynchronous continuation calls:

```js
const assertCurrent = () => {
  if (signal.aborted || window.__heigeCodexSkinRuntime !== runtime) {
    throw new DOMException("HeiGe menu generation disposed", "AbortError");
  }
};
```

Expose `window.__heigeCodexSkinRuntime.status()` returning `{ generation, themeId, menu, mode, persistenceEnabled, revision }` by default. A controller-only call with the injected control capability may additionally return the single bounded in-memory `controlRequest`; public status and ordinary inspection must omit it. `removeSkin` invokes `dispose` before removing fallback nodes and globals. No old closure may write style, dataset, localStorage, alerts, or backend requests after disposal.

- [ ] **Step 4: Verify GREEN**

```bash
node --test test/skin-menu.dom.test.mjs test/injector.test.mjs
```

Expected: double injection, remove, pending fetch, pending reader, pending image, pending timer, stale API, and disposal idempotency tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skin-menu.mjs src/injector.mjs test/skin-menu.dom.test.mjs test/injector.test.mjs
git commit -m "fix(menu): dispose stale generations and async work"
```

## Task 3: Synchronize windows and repair only unhealthy targets

**Files:**

- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/skin-menu.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/injector.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/controller.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/skin-menu.dom.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/injector.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/controller.test.mjs`

- [ ] **Step 1: Write failing two-window and selective-repair tests**

```js
test("theme hidden and persistence ACK synchronize to a second renderer", async () => {
  const [left, right] = await pairedMenuWindows();
  await left.pickTheme("night-city");
  assert.equal(right.themeId, "night-city");
  await left.hideMenu();
  assert.equal(right.hidden, true);
  await left.disablePersistence();
  assert.equal(right.persistenceEnabled, false);
  assert.equal(right.revision, left.revision);
});

test("controller repairs only the window whose generation or state drifted", async () => {
  const result = await controller.tick();
  assert.deepEqual(result.repairedTargets, ["drifted"]);
  assert.deepEqual(injectedTargetIds, ["drifted"]);
  assert.deepEqual(healthyTargetIds, ["healthy"]);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/skin-menu.dom.test.mjs test/controller.test.mjs
```

Expected: FAIL because each renderer has isolated local mutations and the controller reinjects all targets as one batch.

- [ ] **Step 3: Implement a versioned broadcast protocol**

Use channel name `heige-codex-skin-v2`. Messages have exactly:

```js
{
  schemaVersion: 1,
  senderGeneration,
  sequence,
  kind: "theme" | "menu-hidden" | "persistence",
  value,
}
```

Reject unknown schemas, kinds, malformed values, messages from the same generation, and non-increasing sequence numbers per sender. Theme and hidden changes update localStorage as a compatibility source; a `storage` listener handles external changes, but the sender never assumes its own storage event will fire. Persistence messages are emitted only after a valid backend ACK and carry `{ enabled, revision }`; they never contain endpoint or token.

`skinStatus` reports each main window's generation, mode, theme, menu, persistence and revision. Add a target-ID allowlist to `applySkin` so the controller reinjects only missing, stale, or divergent windows. A failure in one target cannot dispose or overwrite a healthy target.

- [ ] **Step 4: Verify GREEN**

```bash
node --test test/skin-menu.dom.test.mjs test/injector.test.mjs test/controller.test.mjs
```

Expected: two-window theme, native mode, hidden state, persistence, loop prevention, stale message rejection, renderer reload, one-window failure, and selective repair tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skin-menu.mjs src/injector.mjs src/controller.mjs test/skin-menu.dom.test.mjs test/injector.test.mjs test/controller.test.mjs
git commit -m "feat(menu): synchronize renderers and repair drift selectively"
```

## Task 4: Enforce manifest, image, theme, menu, and upload budgets

**Files:**

- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/resource-limits.mjs`
- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/image-metadata.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/theme-schema.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/theme-store.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/injector.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/skin-menu.mjs`
- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/image-metadata.test.mjs`
- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/resource-limits.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/theme-schema.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/theme-store.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/injector.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/skin-menu.dom.test.mjs`

- [ ] **Step 1: Write failing boundary tests**

```js
test("rejects manifest bytes and nesting beyond the fixed limits", async () => {
  await assert.rejects(loadTheme(themeWithManifestBytes(65_537)), /theme.json.*65536/);
  await assert.rejects(loadTheme(themeWithJsonDepth(13)), /nesting depth.*12/);
});

test("rejects image bombs before base64 injection", async () => {
  await assert.rejects(loadTheme(themeWithPngDimensions(8193, 1)), /width/);
  await assert.rejects(loadTheme(themeWithPngDimensions(8000, 8000)), /pixels/);
  await assert.rejects(loadTheme(themeWithPngDimensions(1001, 10)), /aspect ratio/);
  assert.equal(evaluateCalls.length, 0);
});

test("browser upload fails visibly and settles within its deadline", async () => {
  const page = await menuWindow({ file: jpegFile({ bytes: 8_388_609 }) });
  await page.upload();
  assert.match(page.alert.textContent, /8 MiB/);
  assert.equal(page.pendingOperations, 0);
});

test("compressed dimension bombs are rejected before browser image decode", async () => {
  const file = pngFile({ bytes: 1024, width: 8192, height: 8192 });
  const page = await menuWindow({ file });
  await page.upload();
  assert.match(page.alert.textContent, /像素/);
  assert.equal(page.imageConstructorCalls, 0);
  assert.equal(page.objectUrlCalls, 0);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/image-metadata.test.mjs test/resource-limits.test.mjs test/theme-schema.test.mjs test/skin-menu.dom.test.mjs
```

Expected: FAIL because current loaders check file presence and extension only, and browser work has no hard byte, pixel, aspect, or timeout gate.

- [ ] **Step 3: Centralize and enforce exact budgets**

```js
export const RESOURCE_LIMITS = Object.freeze({
  manifestBytes: 64 * 1024,
  jsonDepth: 12,
  assetBytes: 8 * 1024 * 1024,
  themeBytes: 16 * 1024 * 1024,
  menuBytes: 48 * 1024 * 1024,
  imageWidth: 8192,
  imageHeight: 8192,
  imagePixels: 32_000_000,
  aspectRatio: 100,
  processedCanvasSide: 2048,
  processedCanvasPixels: 4_000_000,
  browserOperationMs: 5000,
});
```

`image-metadata.mjs` parses dimensions and MIME from PNG IHDR, JPEG SOF markers, and WebP VP8, VP8L, and VP8X headers using bounded buffer reads. The extension, magic MIME, dimensions, pixels, aspect, per-file bytes, per-theme sum, and all-menu sum must agree before any base64 conversion or CDP evaluate. Read `theme.json` as bytes, enforce 64 KiB before decode and parse, then walk the parsed value with a depth cap of 12.

The browser upload path checks `file.size`, reads one bounded `file.arrayBuffer()`, and runs the same browser-safe PNG, JPEG, and WebP header parser before `FileReader`, `URL.createObjectURL`, `Image`, or `createImageBitmap` can decode anything. Reject unsupported or mismatched MIME, malformed/truncated headers, dimensions, pixel count, aspect ratio, or more than 8 MiB at that stage. Only validated input may be decoded, and decoded dimensions must equal the header dimensions before canvas allocation. Calculate a scale satisfying both 2048 per side and 4 million output pixels. Array-buffer read, FileReader, Image, canvas context, draw, getImageData, toDataURL, storage, abort, and timeout paths all settle exactly once, revoke any object URL, and show a visible safe error. A storage quota failure may leave the theme active for the current generation only, but must say it will not survive restart.

- [ ] **Step 4: Verify GREEN with real bundled assets**

```bash
node --test test/image-metadata.test.mjs test/resource-limits.test.mjs test/theme-schema.test.mjs test/theme-store.test.mjs test/injector.test.mjs test/skin-menu.dom.test.mjs test/bundled-presets.test.mjs test/miku-asset.test.mjs
```

Expected: every limit at minus one, exact limit, and plus one; malformed headers; truncated JPEG/WebP; MIME mismatch; canvas failure; timeout; storage quota; and all current bundled presets PASS.

- [ ] **Step 5: Commit**

```bash
git add src/resource-limits.mjs src/image-metadata.mjs src/theme-schema.mjs src/theme-store.mjs src/injector.mjs src/skin-menu.mjs test/image-metadata.test.mjs test/resource-limits.test.mjs test/theme-schema.test.mjs test/theme-store.test.mjs test/injector.test.mjs test/skin-menu.dom.test.mjs
git commit -m "fix(resources): bound manifests images menus and uploads"
```

## Task 5: Remove the custom-pet installer false-success

**Files:**

- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/pet-installer.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/src/cli.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/scripts/install-pet.command`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/custom-pet/install.command`
- Create: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/pet-installer.test.mjs`
- Modify: `/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio/test/custom-pet.test.mjs`

- [ ] **Step 1: Write failing config-shape tests**

```js
test("missing config gets one desktop section and selected pet", async () => {
  await installPet(fixture({ configExists: false }));
  const config = await readFile(configPath, "utf8");
  assert.equal((config.match(/^\[desktop\]$/gm) ?? []).length, 1);
  assert.match(config, /^selected-avatar-id = "custom:miku-future"$/m);
});

test("existing desktop section is updated without writing into the next section", () => {
  const result = setSelectedPet('[desktop]\nfoo = true\n[projects."x"]\ntrust = true\n', "custom:miku-future");
  assert.match(result, /\[desktop\]\nfoo = true\nselected-avatar-id = "custom:miku-future"\n\[projects\."x"\]/);
});

test("installer never prints success unless files and config verify", async () => {
  await assert.rejects(installPet(fixture({ renameFails: true })), /配置写入失败/);
  assert.equal(successMessages.length, 0);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test test/pet-installer.test.mjs test/custom-pet.test.mjs
```

Expected: FAIL because `custom-pet/install.command` does nothing when the key is absent but still claims the pet is selected.

- [ ] **Step 3: Implement one atomic installer**

Export `setSelectedPet(configText, petId)` and `installPet({ sourceRoot, home })`. Copy the manifest and spritesheet into a temporary sibling directory, validate the copied manifest and image metadata, atomically replace the pet directory, update only the `[desktop]` section through a mode-`0600` temporary config file, preserve the original mode, and create one timestamped backup only when config content changes. Re-read both installed files and the config before returning success.

Add CLI command `install-pet`. Both shell entrypoints become thin wrappers around that command, so the packaged and repository flows cannot drift.

- [ ] **Step 4: Verify GREEN**

```bash
/bin/zsh -n scripts/install-pet.command custom-pet/install.command
node --test test/pet-installer.test.mjs test/custom-pet.test.mjs test/image-metadata.test.mjs
```

Expected: absent config, absent desktop section, existing key, later TOML section, idempotency, backup, copy failure, config failure, verification failure, and truthful output tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pet-installer.mjs src/cli.mjs scripts/install-pet.command custom-pet/install.command test/pet-installer.test.mjs test/custom-pet.test.mjs
git commit -m "fix(pet): verify installation before reporting success"
```

## Plan 3 completion gate

```bash
cd "/Users/blakexu/Documents/开源项目/repos/heige-codex-skin-studio"
npm test
git status --short
```

Expected: the complete suite PASSes, current assets are below every budget, all operations return target evidence, and the worktree is clean. This gate uses only fakes and read-only fixtures; it does not evaluate code in the live Codex renderer.
