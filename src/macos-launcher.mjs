import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const MACOS_LAUNCHER_NAME = "HeiGe 皮肤启动器";
export const MACOS_LAUNCHER_BUNDLE_ID = "com.heige.codex-skin-launcher";
export const MACOS_LAUNCHER_SCHEMA_VERSION = 1;
const EXECUTABLE_NAME = "HeiGe Skin Launcher";
const GENERATOR_ID = "heige-codex-skin-studio";
const MAX_GENERATED_FILE_BYTES = 64 * 1024;
const TRANSACTION_FILE = ".heige-codex-skin-launcher-transaction.json";
const LOCK_DIRECTORY = ".heige-codex-skin-launcher-install.lock";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLIST_KEYS = [
  "CFBundleDevelopmentRegion",
  "CFBundleDisplayName",
  "CFBundleExecutable",
  "CFBundleIdentifier",
  "CFBundleInfoDictionaryVersion",
  "CFBundleName",
  "CFBundlePackageType",
  "CFBundleShortVersionString",
  "CFBundleVersion",
  "HeiGeGeneratedBy",
  "HeiGeGeneratedLauncher",
  "HeiGeInstallRoot",
  "HeiGeLauncherSchemaVersion",
].sort();

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertTextCharacters(value, label) {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (
      point < 0x20
      || point === 0x7f
      || (point >= 0xd800 && point <= 0xdfff)
      || point === 0xfffe
      || point === 0xffff
    ) {
      throw new TypeError(`${label} 含有 XML 或 shell 不允许的控制字符`);
    }
  }
}

function assertXmlDocumentCharacters(value, label) {
  for (const character of value) {
    const point = character.codePointAt(0);
    const allowedWhitespace = point === 0x09 || point === 0x0a || point === 0x0d;
    if (
      (!allowedWhitespace && point < 0x20)
      || point === 0x7f
      || (point >= 0xd800 && point <= 0xdfff)
      || point === 0xfffe
      || point === 0xffff
    ) {
      throw new TypeError(`${label} 含有 XML 1.0 不允许的控制字符`);
    }
  }
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new TypeError(`${label} 必须是绝对路径`);
  }
  assertTextCharacters(value, label);
  return resolve(value);
}

function xmlEscape(value) {
  assertTextCharacters(String(value), "XML value");
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlUnescape(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) {
    throw new Error("Info.plist 含有不支持的 XML entity");
  }
  const decoded = value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", "\"")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
  if (xmlEscape(decoded) !== value) throw new Error("Info.plist XML 字符串不是 canonical encoding");
  return decoded;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderMacosLauncherExecutable(entrypoint) {
  entrypoint = assertAbsolutePath(entrypoint, "launcher entrypoint");
  return `#!/bin/zsh\n# HeiGe generated launcher schema ${MACOS_LAUNCHER_SCHEMA_VERSION}\nset -euo pipefail\nexec ${shellQuote(entrypoint)}\n`;
}

export function renderMacosLauncherPlist(installRoot) {
  installRoot = assertAbsolutePath(installRoot, "installRoot");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>zh_CN</string>
    <key>CFBundleDisplayName</key>
    <string>${MACOS_LAUNCHER_NAME}</string>
    <key>CFBundleExecutable</key>
    <string>${EXECUTABLE_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>${MACOS_LAUNCHER_BUNDLE_ID}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${MACOS_LAUNCHER_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>HeiGeGeneratedBy</key>
    <string>${GENERATOR_ID}</string>
    <key>HeiGeGeneratedLauncher</key>
    <true/>
    <key>HeiGeInstallRoot</key>
    <string>${xmlEscape(installRoot)}</string>
    <key>HeiGeLauncherSchemaVersion</key>
    <integer>${MACOS_LAUNCHER_SCHEMA_VERSION}</integer>
</dict>
</plist>
`;
}

async function requireRealDirectory(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} 必须是真实目录且不得是符号链接`);
  }
  return realpath(path);
}

async function requireStableEntrypoint(installRoot) {
  const canonicalRoot = await requireRealDirectory(installRoot, "installRoot");
  const scripts = join(installRoot, "scripts");
  const canonicalScripts = await requireRealDirectory(scripts, "scripts");
  if (canonicalScripts !== join(canonicalRoot, "scripts")) {
    throw new Error("scripts 必须位于 stable installRoot 内");
  }
  const entrypoint = join(scripts, "enable-skin.command");
  const info = await lstat(entrypoint);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("enable-skin.command 必须是 regular file 且不得是符号链接");
  }
  if ((info.mode & 0o111) === 0) throw new Error("enable-skin.command 必须可执行");
  if (await realpath(entrypoint) !== join(canonicalRoot, "scripts", "enable-skin.command")) {
    throw new Error("enable-skin.command 必须位于 stable installRoot 内");
  }
  return entrypoint;
}

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readSmallRegular(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_GENERATED_FILE_BYTES) {
    throw new Error(`${label} 不是受支持的 generated bundle 文件`);
  }
  return { info, text: await readFile(path, "utf8") };
}

function oneMatch(text, expression, label) {
  const matches = [...text.matchAll(expression)];
  if (matches.length !== 1) throw new Error(`Info.plist ${label} 缺失或重复`);
  return matches[0][1];
}

function plistString(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return xmlUnescape(oneMatch(
    text,
    new RegExp(`<key>${escaped}<\\/key>\\s*<string>([^<]*)<\\/string>`, "g"),
    key,
  ));
}

function parseAttributedPlist(text) {
  assertXmlDocumentCharacters(text, "Info.plist");
  const keys = [...text.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).sort();
  if (keys.length !== PLIST_KEYS.length || !keys.every((key, index) => key === PLIST_KEYS[index])) {
    throw new Error("Info.plist keys 不符合 generated launcher schema");
  }
  if (!/<key>HeiGeGeneratedLauncher<\/key>\s*<true\/>/.test(text)) {
    throw new Error("Info.plist 缺少 generated launcher 标识");
  }
  const schema = Number(oneMatch(
    text,
    /<key>HeiGeLauncherSchemaVersion<\/key>\s*<integer>(\d+)<\/integer>/g,
    "HeiGeLauncherSchemaVersion",
  ));
  if (schema !== MACOS_LAUNCHER_SCHEMA_VERSION) throw new Error("不支持的 generated launcher schema");
  if (plistString(text, "CFBundleIdentifier") !== MACOS_LAUNCHER_BUNDLE_ID) {
    throw new Error("generated launcher bundle id 不匹配");
  }
  if (plistString(text, "CFBundleExecutable") !== EXECUTABLE_NAME) {
    throw new Error("generated launcher executable 不匹配");
  }
  if (plistString(text, "HeiGeGeneratedBy") !== GENERATOR_ID) {
    throw new Error("generated launcher producer 不匹配");
  }
  const installRoot = assertAbsolutePath(plistString(text, "HeiGeInstallRoot"), "attributed installRoot");
  return { installRoot, schema };
}

async function assertExactDirectory(path, names, label) {
  const canonical = await requireRealDirectory(path, label);
  const actual = (await readdir(path)).sort();
  const expected = [...names].sort();
  if (actual.length !== expected.length || !actual.every((name, index) => name === expected[index])) {
    throw new Error(`${label} 含有未归属的额外内容`);
  }
  return canonical;
}

async function validateAttributedBundle(appPath, expected = null) {
  try {
    const canonicalApp = await assertExactDirectory(appPath, ["Contents"], "launcher app");
    const contents = join(appPath, "Contents");
    const canonicalContents = await assertExactDirectory(contents, ["Info.plist", "MacOS"], "launcher Contents");
    if (canonicalContents !== join(canonicalApp, "Contents")) throw new Error("launcher Contents escaped bundle");
    const macos = join(contents, "MacOS");
    const canonicalMacos = await assertExactDirectory(macos, [EXECUTABLE_NAME], "launcher MacOS");
    if (canonicalMacos !== join(canonicalContents, "MacOS")) throw new Error("launcher MacOS escaped bundle");
    const executablePath = join(macos, EXECUTABLE_NAME);
    const plistPath = join(contents, "Info.plist");
    const [{ info: executableInfo, text: executable }, { info: plistInfo, text: plist }] = await Promise.all([
      readSmallRegular(executablePath, "launcher executable"),
      readSmallRegular(plistPath, "Info.plist"),
    ]);
    const attribution = parseAttributedPlist(plist);
    if (executable !== renderMacosLauncherExecutable(join(
      attribution.installRoot,
      "scripts",
      "enable-skin.command",
    ))) throw new Error("generated launcher executable 与 attributed installRoot 不匹配");
    if ((executableInfo.mode & 0o777) !== 0o755 || (plistInfo.mode & 0o777) !== 0o644) {
      throw new Error("generated bundle 权限不正确");
    }
    if (expected !== null && (executable !== expected.executable || plist !== expected.plist)) {
      throw new Error("staged generated bundle 与期望字节不一致");
    }
    return { ...attribution, executablePath, plistPath };
  } catch (cause) {
    throw new Error(
      `launcher 目标归属校验失败，不是完整的 generated bundle：${cause?.message ?? "unknown"}`,
      { cause },
    );
  }
}

async function stageBundle(stagePath, expected) {
  const contents = join(stagePath, "Contents");
  const macos = join(contents, "MacOS");
  await mkdir(macos, { recursive: true, mode: 0o755 });
  await chmod(stagePath, 0o755);
  await chmod(contents, 0o755);
  await chmod(macos, 0o755);
  await writeFile(join(contents, "Info.plist"), expected.plist, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  await writeFile(join(macos, EXECUTABLE_NAME), expected.executable, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o755,
  });
  await chmod(join(contents, "Info.plist"), 0o644);
  await chmod(join(macos, EXECUTABLE_NAME), 0o755);
  await validateAttributedBundle(stagePath, expected);
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeDurableJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    const handle = await open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readTransaction(path) {
  const info = await pathInfo(path);
  if (info === null) return null;
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_GENERATED_FILE_BYTES || (info.mode & 0o777) !== 0o600) {
    throw new Error("launcher transaction journal 不是 mode 0600 regular file");
  }
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch (cause) {
    throw new Error("launcher transaction journal JSON 无效", { cause });
  }
  if (
    !exactKeys(value, ["hadExisting", "phase", "schemaVersion", "transactionId"])
    || value.schemaVersion !== 1
    || typeof value.hadExisting !== "boolean"
    || !["prepared", "backed-up", "published"].includes(value.phase)
    || typeof value.transactionId !== "string"
    || !UUID_PATTERN.test(value.transactionId)
  ) throw new Error("launcher transaction journal schema 无效");
  return value;
}

async function clearTransaction(path) {
  try { await unlink(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await syncDirectory(dirname(path));
}

function transactionPaths(appPath, transactionId) {
  if (!UUID_PATTERN.test(transactionId)) throw new Error("launcher transaction id 无效");
  return {
    backupPath: `${appPath}.backup.${transactionId}`,
    stagePath: `${appPath}.staged.${transactionId}`,
  };
}

async function removeAttributedBundle(path) {
  await validateAttributedBundle(path);
  await rm(path, { recursive: true, force: true });
  await syncDirectory(dirname(path));
}

async function recoverTransaction({ appPath, journalPath }) {
  const journal = await readTransaction(journalPath);
  if (journal === null) return false;
  const { backupPath, stagePath } = transactionPaths(appPath, journal.transactionId);
  const [app, backup, stage] = await Promise.all([
    pathInfo(appPath),
    pathInfo(backupPath),
    pathInfo(stagePath),
  ]);

  if (backup !== null) {
    await validateAttributedBundle(backupPath);
    if (app !== null) await removeAttributedBundle(appPath);
    await rename(backupPath, appPath);
    await syncDirectory(dirname(appPath));
    if (stage !== null) await removeAttributedBundle(stagePath);
  } else if (app !== null) {
    await validateAttributedBundle(appPath);
    if (stage !== null) await removeAttributedBundle(stagePath);
  } else if (stage !== null && journal.hadExisting === false) {
    await validateAttributedBundle(stagePath);
    await rename(stagePath, appPath);
    await syncDirectory(dirname(appPath));
  } else if (journal.hadExisting) {
    throw new Error("launcher crash recovery 缺少原 bundle 与 backup，拒绝继续");
  }

  await clearTransaction(journalPath);
  return true;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function acquireInstallLock(applications, isAlive = processIsAlive) {
  const lockPath = join(applications, LOCK_DIRECTORY);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    if (created) {
      const owner = {
        nonce: randomUUID(),
        pid: process.pid,
        schemaVersion: 1,
      };
      try {
        await writeDurableJson(join(lockPath, "owner.json"), owner);
      } catch (error) {
        try {
          await rm(lockPath, { recursive: true, force: true });
          await syncDirectory(applications);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "launcher install lock 初始化与清理同时失败");
        }
        throw error;
      }
      return async () => {
        const ownerPath = join(lockPath, "owner.json");
        let current;
        try {
          const lockInfo = await lstat(lockPath);
          const ownerInfo = await lstat(ownerPath);
          if (
            lockInfo.isSymbolicLink()
            || !lockInfo.isDirectory()
            || (lockInfo.mode & 0o777) !== 0o700
            || ownerInfo.isSymbolicLink()
            || !ownerInfo.isFile()
            || ownerInfo.size > MAX_GENERATED_FILE_BYTES
            || (ownerInfo.mode & 0o777) !== 0o600
          ) throw new Error("launcher install lock ownership 无效");
          current = JSON.parse(await readFile(ownerPath, "utf8"));
        } catch (cause) {
          throw new Error("launcher install lock 无法安全释放", { cause });
        }
        if (!exactKeys(current, ["nonce", "pid", "schemaVersion"])
          || current.nonce !== owner.nonce
          || current.pid !== owner.pid
          || current.schemaVersion !== owner.schemaVersion) {
          throw new Error("launcher install lock ownership 已变化，拒绝删除");
        }
        await rm(lockPath, { recursive: true, force: true });
        await syncDirectory(applications);
      };
    }

    try {
      const lockInfo = await lstat(lockPath);
      if (
        lockInfo.isSymbolicLink()
        || !lockInfo.isDirectory()
        || (lockInfo.mode & 0o777) !== 0o700
        || await realpath(lockPath) !== join(await realpath(applications), LOCK_DIRECTORY)
      ) throw new Error("launcher install lock 不是 mode 0700 real directory");
      const ownerPath = join(lockPath, "owner.json");
      let owner;
      const info = await lstat(ownerPath);
      if (
        info.isSymbolicLink()
        || !info.isFile()
        || info.size > MAX_GENERATED_FILE_BYTES
        || (info.mode & 0o777) !== 0o600
      ) {
        throw new Error("launcher install lock owner 无效");
      }
      owner = JSON.parse(await readFile(ownerPath, "utf8"));
      if (
        !exactKeys(owner, ["nonce", "pid", "schemaVersion"])
        || owner.schemaVersion !== 1
        || !Number.isSafeInteger(owner.pid)
        || owner.pid <= 0
        || typeof owner.nonce !== "string"
        || !UUID_PATTERN.test(owner.nonce)
      ) throw new Error("launcher install lock owner schema 无效");
      if (await isAlive(owner.pid)) throw new Error("另一个 HeiGe 皮肤启动器安装仍在进行");
      const stale = `${lockPath}.stale.${randomUUID()}`;
      try { await rename(lockPath, stale); } catch (failure) {
        if (failure?.code === "ENOENT") continue;
        throw failure;
      }
      await rm(stale, { recursive: true, force: true });
      await syncDirectory(applications);
    } catch (cause) {
      if (cause?.code === "ENOENT") continue;
      if (cause?.message === "另一个 HeiGe 皮肤启动器安装仍在进行") throw cause;
      throw new Error("launcher install lock 无法归属，拒绝抢占", { cause });
    }
  }
  throw new Error("无法取得 launcher install lock");
}

export async function installMacosLauncher({ home, installRoot, hooks = {}, isProcessAlive } = {}) {
  home = assertAbsolutePath(home, "home");
  installRoot = assertAbsolutePath(installRoot, "installRoot");
  const canonicalHome = await requireRealDirectory(home, "home");
  const entrypoint = await requireStableEntrypoint(installRoot);
  const applications = join(home, "Applications");
  await mkdir(applications, { recursive: true, mode: 0o755 });
  const canonicalApplications = await requireRealDirectory(applications, "Applications");
  if (canonicalApplications !== join(canonicalHome, "Applications")) {
    throw new Error("Applications 必须位于用户 home 内");
  }

  const appPath = join(applications, `${MACOS_LAUNCHER_NAME}.app`);
  const journalPath = join(applications, TRANSACTION_FILE);
  const releaseLock = await acquireInstallLock(applications, isProcessAlive);
  let operationError = null;
  try {
    await recoverTransaction({ appPath, journalPath });
    const existing = await pathInfo(appPath);
    if (existing !== null) await validateAttributedBundle(appPath);
    const transactionId = randomUUID();
    const { backupPath, stagePath } = transactionPaths(appPath, transactionId);
    const expected = {
      executable: renderMacosLauncherExecutable(entrypoint),
      plist: renderMacosLauncherPlist(installRoot),
    };
    let journal = {
      schemaVersion: 1,
      transactionId,
      hadExisting: existing !== null,
      phase: "prepared",
    };
    await writeDurableJson(journalPath, journal);

    try {
      await stageBundle(stagePath, expected);
      await hooks.beforePublish?.({ appPath, stagePath });
      if (existing !== null) {
        await rename(appPath, backupPath);
        await syncDirectory(applications);
        journal = { ...journal, phase: "backed-up" };
        await writeDurableJson(journalPath, journal);
        await hooks.afterBackup?.({ appPath, backupPath, stagePath });
      }
      await rename(stagePath, appPath);
      await syncDirectory(applications);
      journal = { ...journal, phase: "published" };
      await writeDurableJson(journalPath, journal);
      const paths = await validateAttributedBundle(appPath, expected);
      await hooks.afterPublish?.({ appPath, ...paths });
      if (existing !== null) {
        await removeAttributedBundle(backupPath);
      }
      await clearTransaction(journalPath);
      return {
        appPath,
        executablePath: paths.executablePath,
        plistPath: paths.plistPath,
      };
    } catch (error) {
      try {
        await recoverTransaction({ appPath, journalPath });
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "launcher publish 与 crash recovery 同时失败");
      }
      throw error;
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseLock();
    } catch (releaseError) {
      if (operationError !== null) {
        throw new AggregateError(
          [operationError, releaseError],
          "launcher operation 与 install lock 释放同时失败",
        );
      }
      throw releaseError;
    }
  }
}
