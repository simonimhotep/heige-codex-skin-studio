import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  installMacosLauncher,
  renderMacosLauncherExecutable,
  renderMacosLauncherPlist,
} from "../src/macos-launcher.mjs";

const execFileAsync = promisify(execFile);
const launcherModuleUrl = new URL("../src/macos-launcher.mjs", import.meta.url).href;

async function fixture(t, suffix = "用户 空格") {
  const root = await mkdtemp(join(tmpdir(), `heige-launcher-${suffix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "家 目录");
  const installRoot = join(home, ".codex", "heige-codex-skin-studio");
  const entrypoint = join(installRoot, "scripts", "enable-skin.command");
  await mkdir(join(installRoot, "scripts"), { recursive: true });
  await writeFile(entrypoint, "#!/bin/zsh\nexit 0\n", { mode: 0o755 });
  await chmod(entrypoint, 0o755);
  return { root, home, installRoot, entrypoint };
}

test("creates a Finder-visible local app that calls only the stable enable entrypoint", async (t) => {
  const { home, installRoot, entrypoint } = await fixture(t);
  const result = await installMacosLauncher({ home, installRoot });
  assert.equal(result.appPath, join(home, "Applications", "HeiGe 皮肤启动器.app"));
  assert.equal(result.executablePath, join(result.appPath, "Contents", "MacOS", "HeiGe Skin Launcher"));
  const executable = await readFile(result.executablePath, "utf8");
  const plist = await readFile(join(result.appPath, "Contents", "Info.plist"), "utf8");
  assert.match(executable, /^#!\/bin\/zsh\n# HeiGe generated launcher schema 1\nset -euo pipefail\nexec /);
  assert.match(executable, new RegExp(entrypoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(executable, /curl|osascript|sudo|\$HOME|\$\{/);
  assert.match(plist, /com\.heige\.codex-skin-launcher/);
  assert.match(plist, /HeiGe 皮肤启动器/);
  assert.equal((await stat(result.executablePath)).mode & 0o777, 0o755);
  assert.equal((await stat(join(result.appPath, "Contents", "Info.plist"))).mode & 0o777, 0o644);
});

test("escapes plist XML and shell-quotes a stable path with punctuation", async (t) => {
  const { root } = await fixture(t, "base");
  const home = join(root, "家 & <目录>");
  const installRoot = join(home, ".codex", "HeiGe's $studio");
  const entrypoint = join(installRoot, "scripts", "enable-skin.command");
  await mkdir(join(installRoot, "scripts"), { recursive: true });
  await writeFile(entrypoint, "#!/bin/zsh\nexit 0\n", { mode: 0o755 });
  await chmod(entrypoint, 0o755);
  const result = await installMacosLauncher({ home, installRoot });
  const executable = await readFile(result.executablePath, "utf8");
  const plist = await readFile(join(result.appPath, "Contents", "Info.plist"), "utf8");
  assert.match(executable, /'"'"'/);
  assert.match(executable, /\$studio/);
  assert.match(executable, /^exec '[^\n]+'$/m);
  assert.match(plist, /家 &amp; &lt;目录&gt;/);
  assert.doesNotMatch(plist, /家 & <目录>/);
});

test("replaces only an attributed generated bundle and restores it after publish failure", async (t) => {
  const { home, installRoot } = await fixture(t);
  const first = await installMacosLauncher({ home, installRoot });
  const oldExecutable = await readFile(first.executablePath);
  await assert.rejects(
    installMacosLauncher({
      home,
      installRoot,
      hooks: { afterBackup: async () => { throw new Error("SIMULATED_PUBLISH_FAILURE"); } },
    }),
    /SIMULATED_PUBLISH_FAILURE/,
  );
  assert.deepEqual(await readFile(first.executablePath), oldExecutable);
  const leftovers = (await readdir(join(home, "Applications")))
    .filter((name) => name.includes(".staged.") || name.includes(".backup."));
  assert.deepEqual(leftovers, []);
});

test("upgrades an attributed older generated bundle and can move its stable install root", async (t) => {
  const { home, installRoot } = await fixture(t);
  const first = await installMacosLauncher({ home, installRoot });
  const plistPath = join(first.appPath, "Contents", "Info.plist");
  const oldPlist = await readFile(plistPath, "utf8");
  await writeFile(
    plistPath,
    oldPlist.replace(
      "<key>CFBundleShortVersionString</key>\n    <string>1.0</string>",
      "<key>CFBundleShortVersionString</key>\n    <string>0.9</string>",
    ),
  );

  const nextInstallRoot = join(home, ".codex", "heige-codex-skin-studio-v2");
  const nextEntrypoint = join(nextInstallRoot, "scripts", "enable-skin.command");
  await mkdir(join(nextInstallRoot, "scripts"), { recursive: true });
  await writeFile(nextEntrypoint, "#!/bin/zsh\nexit 0\n", { mode: 0o755 });
  await chmod(nextEntrypoint, 0o755);

  const upgraded = await installMacosLauncher({ home, installRoot: nextInstallRoot });
  const executable = await readFile(upgraded.executablePath, "utf8");
  assert.match(executable, new RegExp(nextEntrypoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(executable, new RegExp(join(installRoot, "scripts").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(await readFile(upgraded.plistPath, "utf8"), /<string>1\.0<\/string>/);
});

test("refuses a foreign destination, symlinked entrypoint, and non-executable entrypoint", async (t) => {
  await t.test("foreign destination", async (t) => {
    const { home, installRoot } = await fixture(t);
    const app = join(home, "Applications", "HeiGe 皮肤启动器.app");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "foreign.txt"), "do not replace\n");
    await assert.rejects(installMacosLauncher({ home, installRoot }), /归属|generated|bundle/i);
    assert.equal(await readFile(join(app, "foreign.txt"), "utf8"), "do not replace\n");
  });

  await t.test("symlinked entrypoint", async (t) => {
    const { root, home, installRoot, entrypoint } = await fixture(t);
    const outside = join(root, "outside.command");
    await writeFile(outside, "#!/bin/zsh\n", { mode: 0o755 });
    await rm(entrypoint);
    await symlink(outside, entrypoint);
    await assert.rejects(installMacosLauncher({ home, installRoot }), /符号链接|symlink|regular/i);
  });

  await t.test("non-executable entrypoint", async (t) => {
    const { home, installRoot, entrypoint } = await fixture(t);
    await chmod(entrypoint, 0o644);
    await assert.rejects(installMacosLauncher({ home, installRoot }), /可执行|executable/i);
  });
});

test("refuses a symlink at the canonical launcher path without touching its target", async (t) => {
  const { root, home, installRoot } = await fixture(t);
  const applications = join(home, "Applications");
  const outside = join(root, "outside-app");
  await mkdir(applications, { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "foreign\n");
  await symlink(outside, join(applications, "HeiGe 皮肤启动器.app"));
  await assert.rejects(installMacosLauncher({ home, installRoot }), /符号链接|symlink/i);
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "foreign\n");
  assert.equal((await lstat(join(applications, "HeiGe 皮肤启动器.app"))).isSymbolicLink(), true);
});

test("refuses extra bundle content and a nested directory symlink without deleting foreign data", async (t) => {
  await t.test("extra content", async (t) => {
    const { home, installRoot } = await fixture(t);
    const result = await installMacosLauncher({ home, installRoot });
    const extra = join(result.appPath, "Contents", "foreign.txt");
    await writeFile(extra, "preserve me\n");
    await assert.rejects(installMacosLauncher({ home, installRoot }), /额外内容|归属|generated/i);
    assert.equal(await readFile(extra, "utf8"), "preserve me\n");
  });

  await t.test("nested directory symlink", async (t) => {
    const { root, home, installRoot } = await fixture(t);
    const result = await installMacosLauncher({ home, installRoot });
    const macos = join(result.appPath, "Contents", "MacOS");
    const outside = join(root, "foreign-macos");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve me\n");
    await rm(macos, { recursive: true });
    await symlink(outside, macos);
    await assert.rejects(installMacosLauncher({ home, installRoot }), /符号链接|归属|generated/i);
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "preserve me\n");
    assert.equal((await lstat(macos)).isSymbolicLink(), true);
  });
});

test("rejects path control characters and lone UTF-16 surrogates before writing output", async () => {
  assert.throws(() => renderMacosLauncherExecutable("/tmp/bad\npath"), /控制字符/);
  assert.throws(() => renderMacosLauncherPlist("/tmp/bad\u0001path"), /控制字符/);
  assert.throws(() => renderMacosLauncherPlist("/tmp/bad\ud800path"), /控制字符/);
});

test("serializes concurrent installers with an owned cross-process lock", async (t) => {
  const { home, installRoot } = await fixture(t);
  await installMacosLauncher({ home, installRoot });
  let signalBackup;
  let continuePublish;
  const reachedBackup = new Promise((resolve) => { signalBackup = resolve; });
  const publishGate = new Promise((resolve) => { continuePublish = resolve; });
  const first = installMacosLauncher({
    home,
    installRoot,
    hooks: {
      afterBackup: async () => {
        signalBackup();
        await publishGate;
      },
    },
  });
  await reachedBackup;
  try {
    await assert.rejects(
      installMacosLauncher({ home, installRoot }),
      /另一个 HeiGe 皮肤启动器安装仍在进行/,
    );
  } finally {
    continuePublish();
  }
  await first;
});

test("recovers a backed-up launcher and stale lock after the installer is SIGKILLed", async (t) => {
  const { root, home, installRoot } = await fixture(t);
  const initial = await installMacosLauncher({ home, installRoot });
  const original = await readFile(initial.executablePath);
  const marker = join(root, "after-backup.marker");
  const childScript = join(root, "crash-installer.mjs");
  await writeFile(childScript, `
import { writeFile } from "node:fs/promises";
const { installMacosLauncher } = await import(${JSON.stringify(launcherModuleUrl)});
const [home, installRoot, marker] = process.argv.slice(2);
await installMacosLauncher({
  home,
  installRoot,
  hooks: { afterBackup: async () => {
    await writeFile(marker, "ready\\n");
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } },
});
`);
  const child = spawn(process.execPath, [childScript, home, installRoot, marker], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let markerReady = false;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(marker);
      markerReady = true;
      break;
    } catch {
      if (child.exitCode !== null) break;
      await delay(10);
    }
  }
  assert.equal(markerReady, true, `child did not reach backup phase: ${stderr}`);
  const exited = once(child, "exit");
  assert.equal(child.kill("SIGKILL"), true);
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");

  const recovered = await installMacosLauncher({ home, installRoot });
  assert.deepEqual(await readFile(recovered.executablePath), original);
  const leftovers = (await readdir(join(home, "Applications"))).filter((name) => (
    name.includes(".backup.")
    || name.includes(".staged.")
    || name === ".heige-codex-skin-launcher-transaction.json"
    || name === ".heige-codex-skin-launcher-install.lock"
  ));
  assert.deepEqual(leftovers, []);
});

test("generated Info.plist passes the macOS plist validator", {
  skip: process.platform !== "darwin" && "requires macOS plutil",
}, async (t) => {
  const { home, installRoot } = await fixture(t);
  const result = await installMacosLauncher({ home, installRoot });
  const { stdout } = await execFileAsync("plutil", ["-lint", result.plistPath]);
  assert.match(stdout, /OK/);
});

test("preserves both the operation and lock-release errors", async (t) => {
  const { home, installRoot } = await fixture(t);
  await installMacosLauncher({ home, installRoot });
  const ownerPath = join(
    home,
    "Applications",
    ".heige-codex-skin-launcher-install.lock",
    "owner.json",
  );
  await assert.rejects(
    installMacosLauncher({
      home,
      installRoot,
      hooks: {
        afterPublish: async () => {
          await writeFile(ownerPath, '{"foreign":true}\n', { mode: 0o600 });
          throw new Error("SIMULATED_OPERATION_FAILURE");
        },
      },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.message, /operation.*lock/i);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /SIMULATED_OPERATION_FAILURE/);
      assert.match(error.errors[1].message, /ownership|安全释放/);
      return true;
    },
  );
});
