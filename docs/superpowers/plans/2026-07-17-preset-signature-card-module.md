# Preset Signature Card Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable Miku-style lower-right signature card to every built-in preset without duplicating the frame asset or slowing optimistic theme switches.

**Architecture:** A single transparent frame PNG is injected once through a shared style node. Each non-legacy preset renders its hero or optional `cardArtwork` as the card artwork, while theme CSS renders the exact title and `By@HeiGe`; the existing Miku composite `polaroid.webp` remains the highest-priority compatibility path.

**Tech Stack:** Node.js 22 ESM, generated CSS, loopback CDP injection, PNG/WebP assets, Node test runner.

---

## File map

- Create `assets/signature-card-frame.png`: one transparent, text-free reusable frame.
- Modify `ASSET_PROVENANCE.md`: record the frame derivation and unresolved release rights.
- Modify `src/theme-schema.mjs`: validate and load optional `cardArtwork`.
- Modify `src/injector.mjs`: load the shared frame once and pass card resources to CSS/menu generation.
- Modify `src/skin-css.mjs`: render legacy composite or modular card and expose shared-frame CSS.
- Modify `src/skin-menu.mjs`: install and dispose one generation-bound shared style node.
- Modify `scripts/skill-package-manifest.json`: package the shared frame.
- Modify `docs/release/2026-07-16-audit-hardening-disposition.md`: update the deterministic package hash.
- Modify `test/theme-schema.test.mjs`, `test/skin-css.test.mjs`, `test/injector.test.mjs`, `test/skin-menu.dom.test.mjs`, `test/skill-package.test.mjs`, and `test/asset-provenance.test.mjs`: cover validation, rendering, cleanup, packaging, and provenance.
- Rebuild `output/heige-codex-skin-studio.skill`.

### Task 1: Create and audit the reusable transparent frame

**Files:**
- Create: `assets/signature-card-frame.png`
- Modify: `ASSET_PROVENANCE.md`
- Test: `test/asset-provenance.test.mjs`

- [ ] **Step 1: Run the provenance check before adding the asset**

Run:

```bash
node scripts/check-asset-provenance.mjs --check
```

Expected: PASS for the current tracked asset set.

- [ ] **Step 2: Create the frame with the approved image-edit prompt**

Use `themes/miku-488137/polaroid.webp` as the reference image and the built-in image editor with this exact prompt:

```text
Turn this Miku polaroid into a reusable blank signature-card frame. Preserve the white instant-photo paper, rounded outline, pink paperclip, heart, stars, tiny music-note decorations, and premium hand-crafted feeling. Straighten the card so its outer rectangle is vertical on a 2:3 canvas; the application will add the slight rotation later. Remove the character and every piece of lettering. Make the large inner photo aperture fully transparent, make the canvas outside the card fully transparent, and leave the lower caption band clean and empty. Do not add any words, logo, watermark, person, or replacement picture. Output a crisp PNG with transparency.
```

Save the accepted output as `assets/signature-card-frame.png`.

- [ ] **Step 3: Verify dimensions and alpha before tracking it**

Run:

```bash
sips -g pixelWidth -g pixelHeight -g hasAlpha assets/signature-card-frame.png
```

Expected: a 2:3 image with `hasAlpha: yes`. Inspect the file visually and reject it if the photo aperture is not transparent, the caption band contains text, or decorations cross the aperture.

- [ ] **Step 4: Add a provenance row and verify fail-closed release status**

Add this row to `ASSET_PROVENANCE.md` in path order:

```markdown
| `assets/signature-card-frame.png` | 预设主题共享签名卡相框 | 由本仓库现有 `themes/miku-488137/polaroid.webp` 经图片编辑移除人物与文字后派生，原参考素材来源证据缺失 | 未知 | 公开再分发风险未解决 | 发布前换成自制且具备完整来源记录的相框 |
```

Run:

```bash
node scripts/check-asset-provenance.mjs --check
node scripts/check-asset-provenance.mjs --release
```

Expected: `--check` passes; `--release` still fails because unresolved visual rights remain.

- [ ] **Step 5: Commit the audited frame**

```bash
git add assets/signature-card-frame.png ASSET_PROVENANCE.md
git commit -m "assets: add reusable signature card frame"
```

### Task 2: Add optional theme artwork validation

**Files:**
- Modify: `src/theme-schema.mjs`
- Modify: `test/theme-schema.test.mjs`

- [ ] **Step 1: Write failing manifest tests**

Extend the minimal normalized result with `cardArtwork: null`, then add this load test:

```js
test("loads optional signature-card artwork inside the theme budget", async () => {
  await withTheme({
    ...minimalManifest,
    cardArtwork: "card.png",
  }, async (root) => {
    await writeFile(join(root, "hero.png"), png(1600, 900));
    await writeFile(join(root, "card.png"), png(480, 600));
    const theme = await loadTheme(root);
    assert.equal(theme.manifest.cardArtwork, "card.png");
    assert.equal(theme.cardArtworkPath, join(root, "card.png"));
    assert.equal(theme.assetMetadata.cardArtwork.width, 480);
    assert.deepEqual(theme.assetBuffers.cardArtwork, png(480, 600));
  });
});
```

Also add rejection cases for `../card.png`, `card.gif`, symlink escape, empty content, an 8193-pixel side, and aggregate resources over `RESOURCE_LIMITS.themeBytes`.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --test test/theme-schema.test.mjs
```

Expected: FAIL because `cardArtwork` is not normalized or loaded.

- [ ] **Step 3: Implement the schema field and resource snapshot**

In `validateThemeManifest`, add:

```js
cardArtwork: input.cardArtwork === undefined || input.cardArtwork === null
  ? null
  : normalizeAssetPath(input.cardArtwork, "cardArtwork"),
```

In `loadTheme`, resolve it with the existing secure loader:

```js
const cardArtwork = manifest.cardArtwork
  ? await resolveAsset(root, realRoot, manifest.cardArtwork, "cardArtwork")
  : null;
```

Include its bytes in `sumWithinLimit`, then return:

```js
cardArtworkPath: cardArtwork?.path ?? null,
assetMetadata: {
  hero: hero.metadata,
  logo: logo?.metadata ?? null,
  polaroid: polaroid?.metadata ?? null,
  cardArtwork: cardArtwork?.metadata ?? null,
},
assetBuffers: {
  hero: hero.buffer,
  logo: logo?.buffer ?? null,
  polaroid: polaroid?.buffer ?? null,
  cardArtwork: cardArtwork?.buffer ?? null,
},
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test test/theme-schema.test.mjs
```

Expected: all theme-schema tests pass.

- [ ] **Step 5: Commit the schema**

```bash
git add src/theme-schema.mjs test/theme-schema.test.mjs
git commit -m "feat: validate optional signature card artwork"
```

### Task 3: Generate legacy and modular card CSS

**Files:**
- Modify: `src/skin-css.mjs`
- Modify: `test/skin-css.test.mjs`

- [ ] **Step 1: Write failing CSS tests**

Add tests for all three render modes:

```js
test("builds a modular signature card without duplicating the hero", () => {
  const hero = "data:image/webp;base64,SEVSTw==";
  const css = buildSkinCss({
    theme: { id: "genshin-night", name: "原神 · 星夜" },
    heroDataUrl: hero,
    signatureCard: true,
  });
  assert.equal(css.split(hero).length - 1, 1);
  assert.match(css, /--heige-hero-image:/);
  assert.match(css, /body::before/);
  assert.match(css, /body::after/);
  assert.match(css, /原神 · 星夜\\nBy@HeiGe/);
  assert.match(css, /--heige-signature-card-frame-image/);
  assert.match(css, /pointer-events:\\s*none/);
});

test("optional card artwork replaces only the modular card image", () => {
  const css = buildSkinCss({
    theme: { id: "custom-art", name: "独立画芯" },
    heroDataUrl: "data:image/webp;base64,SEVSTw==",
    cardArtworkDataUrl: "data:image/png;base64,Q0FSRA==",
    signatureCard: true,
  });
  assert.match(css, /--heige-card-artwork-image:\\s*url\\("data:image\\/png/);
});

test("legacy polaroid remains the only card path for Miku", () => {
  const css = buildSkinCss({
    theme: { id: "miku-488137", name: "Miku 488137" },
    heroDataUrl: "data:image/webp;base64,SEVSTw==",
    polaroidDataUrl: "data:image/webp;base64,UE9MQVJPSUQ=",
    signatureCard: true,
  });
  assert.doesNotMatch(css, /body::before[\\s\\S]*signature-card/);
  assert.equal(css.split("UE9MQVJPSUQ=").length - 1, 1);
});
```

Add a shared-style test:

```js
assert.equal(
  buildSignatureCardSharedCss("data:image/png;base64,RlJBTUU="),
  ':root{--heige-signature-card-frame-image:url("data:image/png;base64,RlJBTUU=");}',
);
```

- [ ] **Step 2: Run and observe failure**

Run:

```bash
node --test test/skin-css.test.mjs
```

Expected: FAIL because the modular card API and shared-style builder do not exist.

- [ ] **Step 3: Implement single-copy CSS variables**

Change the signature to:

```js
export function buildSkinCss({
  theme,
  heroDataUrl,
  logoDataUrl = null,
  polaroidDataUrl = null,
  cardArtworkDataUrl = null,
  signatureCard = false,
}) {
```

Declare the hero once:

```css
--heige-hero-image: url("...");
--heige-card-artwork-image: var(--heige-hero-image);
```

When `cardArtworkDataUrl` is present, set `--heige-card-artwork-image` to its validated local data URL. Replace the root hero URL with `var(--heige-hero-image)`.

Keep the current legacy `body::after` block when `polaroidDataUrl` is present. Otherwise, when `signatureCard` is true:

```css
body::before,
body::after {
  position: fixed;
  right: 20px;
  bottom: 24px;
  width: clamp(150px, 13.2vw, 200px);
  aspect-ratio: 2 / 3;
  transform: rotate(-3.5deg);
  transform-origin: center;
  pointer-events: none;
  z-index: 15;
}

body::before {
  content: "";
  background:
    var(--heige-card-artwork-image) 50% 42% / 82% 72% no-repeat,
    #fffaf5;
  border-radius: 5%;
  filter: drop-shadow(0 12px 26px color-mix(in srgb, var(--heige-text) 24%, transparent));
}

body::after {
  content: "THEME NAME\\A By@HeiGe";
  box-sizing: border-box;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0 10% 8%;
  overflow: hidden;
  white-space: pre-line;
  text-align: center;
  color: var(--heige-accent);
  font: italic 700 clamp(10px, .9vw, 14px)/1.2 ui-rounded, system-ui;
  background: var(--heige-signature-card-frame-image) center / contain no-repeat;
  filter: drop-shadow(0 12px 26px color-mix(in srgb, var(--heige-text) 24%, transparent));
}

@media (max-width: 899px), (max-height: 649px) {
  body::before,
  body::after { display: none; }
}
```

Generate `THEME NAME` with the existing safe `copy()` helper, not string interpolation.

Export:

```js
export function buildSignatureCardSharedCss(frameDataUrl) {
  if (!DATA_URL.test(frameDataUrl) || !frameDataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("signature card frame 必须是本地 PNG 数据");
  }
  return `:root{--heige-signature-card-frame-image:url(${JSON.stringify(frameDataUrl)});}`;
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test test/skin-css.test.mjs
```

Expected: all skin CSS tests pass and the hero data URL occurs once in modular output.

- [ ] **Step 5: Commit CSS rendering**

```bash
git add src/skin-css.mjs test/skin-css.test.mjs
git commit -m "feat: render reusable preset signature cards"
```

### Task 4: Inject one shared frame and clean it by generation

**Files:**
- Modify: `src/injector.mjs`
- Modify: `src/skin-menu.mjs`
- Modify: `test/injector.test.mjs`
- Modify: `test/skin-menu.dom.test.mjs`

- [ ] **Step 1: Write failing injector and DOM tests**

In injector tests, assert:

```js
assert.equal(
  FakeSession.expressions[0].split("data:image/png;base64,RlJBTUU=").length - 1,
  1,
  "shared frame must occur exactly once in the renderer expression",
);
assert.match(FakeSession.expressions[0], /By@HeiGe/);
```

Use a test dependency `signatureCardFramePath` pointing to a validated PNG fixture so the test remains deterministic.

In DOM tests, assert:

```js
const shared = page.document.querySelector('[data-heige-role="signature-card-style"]');
assert.ok(shared);
assert.equal(shared.dataset.heigeGeneration, page.window.__heigeCodexSkin.generation);
page.window.__heigeCodexSkinRuntime.dispose();
assert.equal(page.document.querySelector('[data-heige-role="signature-card-style"]'), null);
```

Also reinject and verify exactly one current shared style remains.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
node --test test/injector.test.mjs test/skin-menu.dom.test.mjs
```

Expected: FAIL because no shared frame style or card artwork resource exists.

- [ ] **Step 3: Load the frame once in the injector**

Add:

```js
import { fileURLToPath } from "node:url";
import { buildSignatureCardSharedCss, buildSkinCss } from "./skin-css.mjs";

const SIGNATURE_CARD_FRAME_PATH = fileURLToPath(
  new URL("../assets/signature-card-frame.png", import.meta.url),
);
```

Read the shared frame once per `applySkin` call:

```js
const frame = await readThemeAsset(
  deps.signatureCardFramePath ?? SIGNATURE_CARD_FRAME_PATH,
  "signature card frame",
);
const sharedStyleCss = buildSignatureCardSharedCss(dataUrl(frame));
```

Extend `readThemeResources` with `cardArtwork`, include its bytes in the theme budget, and pass:

```js
cardArtworkDataUrl: dataUrl(cardArtwork),
signatureCard: polaroid === null,
```

Do not enable the modular card in the custom-upload CSS template.

- [ ] **Step 4: Add one generation-bound shared style**

Extend `buildSkinMenuScript` input with `sharedStyleCss`. Inside the generated script:

1. Remove previous `[data-heige-role="signature-card-style"]` nodes during reinjection cleanup.
2. Create one `<style>` with `data-heige-role="signature-card-style"` and the current generation.
3. Set `textContent` from the inert JSON payload.
4. Append it beside the current theme style.
5. Remove it from `dispose()` only when owned by the current generation.

Do not put shared CSS into each theme entry.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test test/injector.test.mjs test/skin-menu.dom.test.mjs test/skin-menu.test.mjs
```

Expected: all focused tests pass, with one frame data URL in the expression and no stale shared style.

- [ ] **Step 6: Commit injection support**

```bash
git add src/injector.mjs src/skin-menu.mjs test/injector.test.mjs test/skin-menu.dom.test.mjs test/skin-menu.test.mjs
git commit -m "feat: inject one shared signature card frame"
```

### Task 5: Package the shared frame deterministically

**Files:**
- Modify: `scripts/skill-package-manifest.json`
- Modify: `test/skill-package.test.mjs`
- Modify: `output/heige-codex-skin-studio.skill`
- Modify: `docs/release/2026-07-16-audit-hardening-disposition.md`

- [ ] **Step 1: Add a failing package assertion**

Add an exact archive assertion:

```js
assert.ok(entries.includes("payload/assets/signature-card-frame.png"));
assert.equal(entries.filter((name) => name.endsWith("signature-card-frame.png")).length, 1);
```

- [ ] **Step 2: Run the package test and verify failure**

Run:

```bash
node --test test/skill-package.test.mjs
```

Expected: FAIL because the shared frame is absent from the package allowlist.

- [ ] **Step 3: Add one explicit manifest entry**

Add:

```json
{
  "source": "assets/signature-card-frame.png",
  "destination": "payload/assets/signature-card-frame.png",
  "recursive": false,
  "exclude": []
}
```

Do not recursively package the rest of `assets`.

- [ ] **Step 4: Rebuild and verify deterministic output**

Run:

```bash
tmpdir="$(mktemp -d)"
node scripts/package-skill.mjs \
  --output "$tmpdir/a.skill" \
  --source-date-epoch 1704067200
node scripts/package-skill.mjs \
  --output "$tmpdir/b.skill" \
  --source-date-epoch 1704067200
cmp "$tmpdir/a.skill" "$tmpdir/b.skill"

HEIGE_ALLOW_TRACKED_PACKAGE_OUTPUT=1 node scripts/package-skill.mjs \
  --output "/Users/blakexu/Documents/Codex 皮肤/output/heige-codex-skin-studio.skill" \
  --source-date-epoch 1704067200

node scripts/update-release-hash.mjs \
  --artifact "/Users/blakexu/Documents/Codex 皮肤/output/heige-codex-skin-studio.skill" \
  --disposition "/Users/blakexu/Documents/Codex 皮肤/docs/release/2026-07-16-audit-hardening-disposition.md"
```

Expected: the two temporary archives are byte-identical and contain one shared frame.

- [ ] **Step 5: Run focused release checks**

Run:

```bash
node --test test/skill-package.test.mjs test/product-identity.test.mjs
node scripts/check-asset-provenance.mjs --check
```

Expected: all tests and the provenance completeness check pass.

- [ ] **Step 6: Commit the package**

```bash
git add scripts/skill-package-manifest.json test/skill-package.test.mjs output/heige-codex-skin-studio.skill docs/release/2026-07-16-audit-hardening-disposition.md
git commit -m "build: package reusable signature cards"
```

### Task 6: Full regression, installation, and live acceptance

**Files:**
- Verify: `/Users/blakexu/.codex/heige-codex-skin-studio`
- Verify: `/Users/blakexu/Documents/Codex 皮肤/output/heige-codex-skin-studio.skill`

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: zero failures; live opt-in tests may remain skipped.

- [ ] **Step 2: Install the exact committed source**

Run:

```bash
HEIGE_SKIP_APPLY=1 ./scripts/install.command
"$HOME/.codex/heige-codex-skin-studio/scripts/apply.command"
```

Before and after the commands, read the runtime status through the installed bundled Node. If installation temporarily disables persistence because CDP is unavailable, restore it through the verified in-app persistence switch after Codex returns. Preserve the user’s current `miku-488137` selection and final `persistenceEnabled: true`.

Expected: source and installed `src`, `themes`, and shared frame bytes match exactly.

- [ ] **Step 3: Perform live visual switching**

Through the existing loopback CDP acceptance path:

1. Open the theme center.
2. Switch from Miku to `genshin-dawn`.
3. Verify the modular card uses the shared frame, displays the Genshin artwork, contains `原神 · 晨曦` and `By@HeiGe`, and leaves the dialog open.
4. Switch to `naruto-hokage` and repeat.
5. Switch back to `miku-488137` and verify the original composite card remains unchanged.

Expected: every immediate renderer update is below 20 ms and every durable request reaches `saved`.

- [ ] **Step 4: Verify layout boundaries**

At the normal window size, confirm the card does not cover the composer, theme trigger, or theme center. Emulate a width below 900 px and a height below 650 px through CDP and confirm both modular layers compute to `display: none`.

- [ ] **Step 5: Verify final runtime and package**

Run:

```bash
"/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
  "$HOME/.codex/heige-codex-skin-studio/src/cli.mjs" status --port 9341
shasum -a 256 "/Users/blakexu/Documents/Codex 皮肤/output/heige-codex-skin-studio.skill"
git status --short
```

Expected: Miku active, menu installed, persistence enabled, no failed main renderer, a stable package hash, and only pre-existing unrelated untracked files.
