import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillRoot = new URL("../skill/heige-codex-skin-studio/", import.meta.url);

test("keeps the reusable skill free of author paths", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");

  assert.match(skill, /^---\nname: heige-codex-skin-studio\n/);
  assert.doesNotMatch(skill, /\/Users\/blakexu/);
});

test("packages and installs a self-contained distribution", async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "heige-skin-skill-")));
  t.after(() => rm(home, { recursive: true, force: true }));

  await execFileAsync(join(repoRoot, "scripts/package-skill.command"));

  const archive = join(repoRoot, "output/heige-codex-skin-studio.skill");
  await execFileAsync("/usr/bin/unzip", ["-q", archive, "-d", home]);

  const unpacked = join(home, "heige-codex-skin-studio");
  await execFileAsync(join(unpacked, "scripts/install.command"), [], {
    env: { ...process.env, HOME: home, HEIGE_SKIP_APPLY: "1" },
  });

  const installed = join(home, ".codex/heige-codex-skin-studio");
  for (const relative of [
    "src/cli.mjs",
    "themes/miku-488137/theme.json",
    "custom-pet/install.command",
    "scripts/apply.command",
    "scripts/pause.command",
  ]) {
    await access(join(installed, relative));
  }

  const { stdout } = await execFileAsync(
    process.execPath,
    [join(installed, "src/cli.mjs"), "list"],
    { env: { ...process.env, HOME: home } },
  );
  const themes = JSON.parse(stdout);
  assert.ok(
    themes.some((theme) => theme.id === "miku-488137"),
    "installed copy must ship the Miku preset",
  );
});
