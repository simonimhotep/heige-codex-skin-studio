import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.mjs";

function deps(overrides = {}) {
  return {
    bundledThemesRoot: "/bundle/themes",
    userThemesRoot: "/user/themes",
    listThemes: async () => [{ id: "miku-488137", name: "Miku", path: "/bundle/themes/miku-488137" }],
    loadTheme: async (path) => ({ manifest: { id: path.split("/").at(-1) }, heroPath: "/tmp/hero.png" }),
    applySkin: async ({ loadedTheme, port }) => ({ applied: 1, themeId: loadedTheme.manifest.id, port }),
    removeSkin: async () => ({ removed: 1 }),
    skinStatus: async () => [{ installed: true, themeId: "miku-488137" }],
    createSingleImageTheme: async ({ imagePath, name }) => ({ id: "new-skin", imagePath, name }),
    ...overrides,
  };
}

test("lists and applies the bundled Miku preset by default", async () => {
  assert.deepEqual(await runCli(["list"], deps()), [{ id: "miku-488137", name: "Miku", path: "/bundle/themes/miku-488137" }]);
  assert.deepEqual(await runCli(["apply"], deps()), { applied: 1, themeId: "miku-488137", port: 9341 });
});

test("creates a skin directly from one image", async () => {
  assert.deepEqual(
    await runCli(["create", "--image", "/tmp/art.webp", "--name", "Fast Skin"], deps()),
    { id: "new-skin", imagePath: "/tmp/art.webp", name: "Fast Skin" },
  );
});

test("rejects unknown commands and missing options", async () => {
  await assert.rejects(() => runCli(["create", "--image", "/tmp/a.png"], deps()), /--name/);
  await assert.rejects(() => runCli(["launch"], deps()), /未知命令/);
});
