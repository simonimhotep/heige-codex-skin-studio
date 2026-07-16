import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installTree, recoverInstallTree } from "../src/install-transaction.mjs";

const installModule = fileURLToPath(new URL("../src/install-transaction.mjs", import.meta.url));

async function sourceFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-install-crash-")));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "home", ".codex", "heige-codex-skin-studio");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "package.json"), `${JSON.stringify({
    name: "heige-codex-skin-studio",
    version: "1.0.0",
    type: "module",
    bin: { "heige-codex-skin": "src/cli.mjs" },
  })}\n`);
  for (const directory of ["src", "themes", "scripts", "custom-pet"]) {
    await mkdir(join(sourceRoot, directory), { recursive: true });
    await writeFile(join(sourceRoot, directory, `${directory}.txt`), `${directory}-v1\n`);
  }
  await writeFile(
    join(sourceRoot, "src", "cli.mjs"),
    "#!/usr/bin/env node\nimport { resolveStudioPaths } from \"./constants.mjs\";\nvoid resolveStudioPaths;\n",
    { mode: 0o755 },
  );
  await writeFile(join(sourceRoot, "scripts", "enable-skin.command"), "#!/bin/zsh\nexit 0\n", {
    mode: 0o755,
  });
  await writeFile(
    join(sourceRoot, "scripts", "enable-persist.command"),
    "#!/bin/zsh\nexec \"$ROOT/scripts/lib/run-cli.zsh\" enable-skin\n",
    { mode: 0o755 },
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, sourceRoot, targetRoot };
}

async function waitForReady(child, path, stderr) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      if ((await readFile(path, "utf8")) === "ready\n") return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null) {
      throw new Error(`crash fixture exited before its boundary: ${stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for crash boundary: ${stderr()}`);
}

async function killAtBoundary(t, { root, sourceRoot, targetRoot, hook, testModeHome = "" }) {
  const readyPath = join(root, `${hook}.ready`);
  const childScript = join(root, `${hook}.mjs`);
  await writeFile(childScript, `
import { writeFile } from "node:fs/promises";
import { installTree } from ${JSON.stringify(installModule)};

await installTree({
  sourceRoot: process.argv[2],
  targetRoot: process.argv[3],
  ...(process.argv[6] ? { testMode: { currentUserHome: process.argv[6] } } : {}),
  hooks: {
    [process.argv[5]]: async () => {
      await writeFile(process.argv[4], "ready\\n");
      await new Promise(() => { setInterval(() => {}, 1_000); });
    },
  },
});
`);
  const child = spawn(process.execPath, [
    childScript,
    sourceRoot,
    targetRoot,
    readyPath,
    hook,
    testModeHome,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  await waitForReady(child, readyPath, () => stderr);
  const exited = once(child, "exit");
  assert.equal(child.kill("SIGKILL"), true);
  const [exitCode, signal] = await exited;
  assert.equal(exitCode, null);
  assert.equal(signal, "SIGKILL");
}

async function assertRecoveryArtifactsGone(targetRoot) {
  await assert.rejects(lstat(`${targetRoot}.install-journal.json`), /ENOENT/);
  await assert.rejects(lstat(`${targetRoot}.install-prepare.json`), /ENOENT/);
  await assert.rejects(lstat(`${targetRoot}.install.lock`), /ENOENT/);
  const parentNames = await readdir(join(targetRoot, ".."));
  assert.equal(parentNames.some((name) => name.includes(".staged.") || name.includes(".backup.")), false);
}

for (const hook of ["afterStageCreated", "afterPrepare"]) {
  test(`SIGKILL at ${hook} recovers the durable preparation intent`, async (t) => {
    const fixture = await sourceFixture(t);

    await killAtBoundary(t, { ...fixture, hook });

    assert.equal((await lstat(`${fixture.targetRoot}.install-prepare.json`)).isFile(), true);
    const recovery = await recoverInstallTree({ targetRoot: fixture.targetRoot });
    assert.deepEqual(recovery, { recovered: true, action: "prepare-cleanup" });
    await assert.rejects(lstat(fixture.targetRoot), /ENOENT/);
    await assertRecoveryArtifactsGone(fixture.targetRoot);

    const retry = await installTree(fixture);
    assert.equal(retry.installed, true);
    assert.equal(await readFile(join(fixture.targetRoot, "src", "src.txt"), "utf8"), "src-v1\n");
  });
}

test("SIGKILL before the commit decision recovers by rolling back the old tree", async (t) => {
  const fixture = await sourceFixture(t);
  await installTree(fixture);
  await writeFile(join(fixture.sourceRoot, "src", "src.txt"), "src-v2\n");

  await killAtBoundary(t, { ...fixture, hook: "afterTargetPublished" });

  const recovery = await recoverInstallTree({ targetRoot: fixture.targetRoot });
  assert.deepEqual(recovery, { recovered: true, action: "rollback" });
  assert.equal(await readFile(join(fixture.targetRoot, "src", "src.txt"), "utf8"), "src-v1\n");
  await assertRecoveryArtifactsGone(fixture.targetRoot);
});

test("SIGKILL after the commit decision recovers by retaining the new tree and finalizing", async (t) => {
  const fixture = await sourceFixture(t);
  await installTree(fixture);
  await writeFile(join(fixture.sourceRoot, "src", "src.txt"), "src-v2\n");

  await killAtBoundary(t, { ...fixture, hook: "afterCommitDecision" });

  const recovery = await recoverInstallTree({ targetRoot: fixture.targetRoot });
  assert.deepEqual(recovery, { recovered: true, action: "roll-forward" });
  assert.equal(await readFile(join(fixture.targetRoot, "src", "src.txt"), "utf8"), "src-v2\n");
  await assertRecoveryArtifactsGone(fixture.targetRoot);
});

test("SIGKILL before commit restores a strictly attributed legacy tree", async (t) => {
  const fixture = await sourceFixture(t);
  const home = join(fixture.root, "home");
  await mkdir(fixture.targetRoot, { recursive: true });
  for (const entry of ["package.json", "src", "themes", "scripts", "custom-pet"]) {
    await cp(join(fixture.sourceRoot, entry), join(fixture.targetRoot, entry), {
      recursive: entry !== "package.json",
      preserveTimestamps: true,
    });
  }
  await writeFile(
    join(fixture.targetRoot, "INSTALLED_COMMIT"),
    "79b03dccf246134ff3b28e9d9afc7751fee8812b\n",
    { mode: 0o644 },
  );
  await writeFile(join(fixture.sourceRoot, "src", "src.txt"), "src-v2\n");

  await killAtBoundary(t, {
    ...fixture,
    hook: "afterTargetPublished",
    testModeHome: home,
  });

  const recovery = await recoverInstallTree({
    targetRoot: fixture.targetRoot,
    testMode: { currentUserHome: home },
  });
  assert.deepEqual(recovery, { recovered: true, action: "rollback" });
  assert.equal(
    await readFile(join(fixture.targetRoot, "INSTALLED_COMMIT"), "utf8"),
    "79b03dccf246134ff3b28e9d9afc7751fee8812b\n",
  );
  assert.equal(await readFile(join(fixture.targetRoot, "src", "src.txt"), "utf8"), "src-v1\n");
  await assertRecoveryArtifactsGone(fixture.targetRoot);
});
