import assert from "node:assert/strict";
import test from "node:test";

import { bundledNodeCandidates, codexAppCandidates, discoverCodex } from "../src/codex-app.mjs";
import { resolveStudioPaths } from "../src/constants.mjs";

const winEnv = { LOCALAPPDATA: "C:\\Users\\heige\\AppData\\Local", ProgramFiles: "C:\\Program Files", APPDATA: "C:\\Users\\heige\\AppData\\Roaming" };

test("lists windows install candidates from environment paths", () => {
  const candidates = codexAppCandidates({ platform: "win32", env: winEnv, home: "C:\\Users\\heige" });
  assert.ok(candidates.some((path) => path.includes("Programs")));
  assert.ok(candidates.every((path) => path.endsWith(".exe")));
});

test("resolves the bundled node next to the windows executable", () => {
  const candidates = bundledNodeCandidates("C:\\Users\\heige\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe", { platform: "win32" });
  assert.ok(candidates[0].endsWith("node.exe"));
  assert.ok(candidates[0].includes("cua_node"));
});

test("discovery reports the first existing app and node per platform", async () => {
  const disk = new Set([
    "C:\\Users\\heige\\AppData\\Local\\Programs\\Codex\\Codex.exe",
    "C:\\Users\\heige\\AppData\\Local\\Programs\\Codex\\resources\\cua_node\\node.exe",
  ]);
  const result = await discoverCodex({
    platform: "win32",
    env: winEnv,
    home: "C:\\Users\\heige",
    exists: async (path) => disk.has(path),
  });
  assert.equal(result.appFound, true);
  assert.ok(result.app.endsWith("Codex.exe"));
  assert.equal(result.bundledNodeFound, true);
});

test("discovery degrades honestly when nothing is installed", async () => {
  const result = await discoverCodex({ platform: "win32", env: winEnv, home: "C:\\Users\\heige", exists: async () => false });
  assert.equal(result.appFound, false);
  assert.equal(result.bundledNodeFound, false);
});

test("mac discovery keeps the classic bundle path", async () => {
  const result = await discoverCodex({ platform: "darwin", exists: async (path) => path === "/Applications/ChatGPT.app" });
  assert.equal(result.appFound, true);
  assert.match(result.bundledNode, /cua_node\/bin\/node$/);
});

test("state paths follow the platform convention", () => {
  const win = resolveStudioPaths({ home: "C:\\Users\\heige", platform: "win32", env: winEnv });
  assert.ok(win.stateRoot.includes("Roaming"));
  const mac = resolveStudioPaths({ home: "/Users/heige", platform: "darwin", env: {} });
  assert.ok(mac.stateRoot.includes("Application Support"));
});
