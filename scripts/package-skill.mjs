#!/usr/bin/env node
import { constants as fsConstants, createWriteStream } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import yazl from "yazl";

const execFile = promisify(execFileCallback);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "scripts/skill-package-manifest.json");
const trackedOutput = join(root, "output/heige-codex-skin-studio.skill");
const archiveRoot = "heige-codex-skin-studio";
export const TRACKED_PACKAGE_SOURCE_DATE_EPOCH = 1_704_067_200;
const exactManifestKeys = ["entries", "schemaVersion"];
const exactEntryKeys = ["destination", "exclude", "recursive", "source"];
const runtimeScriptNames = ["apply", "doctor", "list", "status"];
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_INPUT_BYTES = 128 * 1024 * 1024;

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function safeRelativePath(value, label, { allowEmpty = false } = {}) {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || isAbsolute(value)
    || value.includes("\\")
    || value.includes("\0")
  ) throw new TypeError(`${label} 必须是安全的 POSIX 相对路径`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError(`${label} 含有无效路径段`);
  }
  return value;
}

function parseEpoch(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 315_532_800 || number > 4_102_444_800) {
    throw new TypeError("source date epoch 必须是 1980 到 2100 之间的整数秒");
  }
  return number;
}

function parseManifest(input) {
  if (!exactKeys(input, exactManifestKeys) || input.schemaVersion !== 1 || !Array.isArray(input.entries)) {
    throw new TypeError("skill package manifest 结构无效");
  }
  return input.entries.map((entry, index) => {
    if (!exactKeys(entry, exactEntryKeys) || typeof entry.recursive !== "boolean" || !Array.isArray(entry.exclude)) {
      throw new TypeError(`skill package manifest entry ${index} 结构无效`);
    }
    const source = safeRelativePath(entry.source, `entry ${index} source`);
    const destination = safeRelativePath(entry.destination, `entry ${index} destination`);
    const exclude = entry.exclude.map((path) => safeRelativePath(path, `entry ${index} exclude`));
    if (new Set(exclude).size !== exclude.length) throw new TypeError(`entry ${index} exclude 含重复路径`);
    return { source, destination, recursive: entry.recursive, exclude: new Set(exclude) };
  });
}

function archivePath(destination) {
  const path = `${archiveRoot}/${destination}`;
  safeRelativePath(path, "archive destination");
  return path;
}

async function regularFile(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new TypeError(`${label} 必须是普通文件且不得是符号链接`);
  return info;
}

async function assertNoSymlinkAncestors(path, label) {
  const relativePath = relative(root, path);
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new TypeError(`${label} 超出仓库根目录`);
  }
  let current = root;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError(`${label} 的路径祖先不得是符号链接`);
  }
}

async function readStableFile(path, label) {
  await assertNoSymlinkAncestors(path, label);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_ENTRY_BYTES)) {
      throw new RangeError(`${label} 不是普通文件或超过 ${MAX_ENTRY_BYTES} bytes`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || BigInt(bytes.byteLength) !== before.size
    ) throw new Error(`${label} 在打包读取期间发生变化`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function repositoryRelative(path) {
  const value = relative(root, path).split(sep).join("/");
  if (value === "" || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    throw new TypeError("package source 超出仓库根目录");
  }
  return value;
}

async function trackedSourceIndex() {
  const { stdout } = await execFile("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const files = new Set(stdout.split("\0").filter(Boolean));
  const directories = new Set();
  for (const path of files) {
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(segments.slice(0, length).join("/"));
    }
  }
  return { files, directories };
}

function assertTrackedSource(path, kind, tracked) {
  const source = repositoryRelative(path);
  const allowed = kind === "directory"
    ? tracked.directories.has(source)
    : tracked.files.has(source);
  if (!allowed) throw new Error(`package source 不是 Git 已跟踪的${kind === "directory" ? "目录" : "文件"}：${source}`);
}

async function collectDirectory(sourceRoot, destinationRoot, exclude, tracked) {
  const result = [];
  const visit = async (directory, prefix = "") => {
    const directoryInfo = await lstat(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new TypeError(`package source 目录无效：${relative(root, directory)}`);
    }
    assertTrackedSource(directory, "directory", tracked);
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const childRelative = prefix ? `${prefix}/${name}` : name;
      if (exclude.has(childRelative)) continue;
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new TypeError(`package source 不得包含符号链接：${childRelative}`);
      if (info.isDirectory()) await visit(path, childRelative);
      else if (info.isFile()) {
        assertTrackedSource(path, "file", tracked);
        result.push({ source: path, destination: archivePath(`${destinationRoot}/${childRelative}`) });
      } else throw new TypeError(`package source 只允许普通文件：${childRelative}`);
    }
  };
  await visit(sourceRoot);
  for (const excluded of exclude) {
    const path = join(sourceRoot, ...excluded.split("/"));
    try { await lstat(path); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
  return result;
}

async function collectFiles(manifest, tracked) {
  const files = [];
  for (const entry of manifest) {
    const source = join(root, ...entry.source.split("/"));
    await assertNoSymlinkAncestors(source, entry.source);
    if (entry.recursive) {
      files.push(...await collectDirectory(source, entry.destination, entry.exclude, tracked));
    } else {
      if (entry.exclude.size !== 0) throw new TypeError(`单文件 entry 不得含 exclude：${entry.source}`);
      await regularFile(source, entry.source);
      assertTrackedSource(source, "file", tracked);
      files.push({ source, destination: archivePath(entry.destination) });
    }
  }
  const rootPackage = JSON.parse((await readStableFile(join(root, "package.json"), "package.json")).toString("utf8"));
  const runtimePackage = {
    name: rootPackage.name,
    version: rootPackage.version,
    type: rootPackage.type,
    engines: rootPackage.engines,
    bin: rootPackage.bin,
    scripts: Object.fromEntries(runtimeScriptNames
      .filter((name) => typeof rootPackage.scripts?.[name] === "string")
      .map((name) => [name, rootPackage.scripts[name]])),
    ...(rootPackage.dependencies === undefined ? {} : { dependencies: rootPackage.dependencies }),
  };
  if (
    typeof runtimePackage.name !== "string"
    || typeof runtimePackage.version !== "string"
    || runtimePackage.type !== "module"
    || runtimePackage.engines?.node !== ">=22"
    || exactKeys(runtimePackage.bin, ["heige-codex-skin"]) === false
  ) throw new TypeError("root package.json 缺少受支持的 runtime 字段");
  files.push({
    bytes: Buffer.from(`${JSON.stringify(runtimePackage, null, 2)}\n`, "utf8"),
    destination: archivePath("payload/package.json"),
  });
  files.sort((left, right) => left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0);
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.destination)) throw new TypeError(`archive destination 重复：${file.destination}`);
    seen.add(file.destination);
  }
  return files;
}

async function isTrackedOutputAlias(output) {
  if (resolve(output) === resolve(trackedOutput)) return true;
  const [outputParent, trackedParent] = await Promise.all([
    realpath(dirname(output)),
    realpath(dirname(trackedOutput)),
  ]);
  return join(outputParent, output.split(sep).at(-1)) === join(trackedParent, trackedOutput.split(sep).at(-1));
}

async function writeArchive(output, files, epoch) {
  const temporary = join(dirname(output), `.${output.split(sep).at(-1)}.${process.pid}.${Date.now()}.tmp`);
  const zip = new yazl.ZipFile();
  const sink = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const writing = pipeline(zip.outputStream, sink);
  try {
    const options = {
      mtime: new Date(epoch * 1000),
      mode: 0o100644,
      compress: true,
      compressionLevel: 9,
    };
    let inputBytes = 0;
    for (const file of files) {
      const bytes = file.bytes ?? await readStableFile(file.source, relative(root, file.source));
      inputBytes += bytes.byteLength;
      if (!Number.isSafeInteger(inputBytes) || inputBytes > MAX_ARCHIVE_INPUT_BYTES) {
        throw new RangeError(`package input 超过 ${MAX_ARCHIVE_INPUT_BYTES} bytes`);
      }
      zip.addBuffer(bytes, file.destination, {
        ...options,
        mode: file.destination.endsWith(".command") ? 0o100755 : options.mode,
      });
    }
    zip.end();
    await writing;
    await chmod(temporary, 0o644);
    await rename(temporary, output);
  } catch (error) {
    try { zip.end(); } catch {}
    await writing.catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function packageSkill(output, {
  sourceDateEpoch,
  allowTrackedOutput = process.env.HEIGE_ALLOW_TRACKED_PACKAGE_OUTPUT === "1",
} = {}) {
  if (typeof output !== "string" || !isAbsolute(output) || output.includes("\0")) {
    throw new TypeError("output 必须是非空绝对路径");
  }
  output = resolve(output);
  const epoch = parseEpoch(sourceDateEpoch);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  if (!allowTrackedOutput && await isTrackedOutputAlias(output)) {
    throw new Error("tracked package output 仅可在 HEIGE_ALLOW_TRACKED_PACKAGE_OUTPUT=1 时刷新");
  }
  try {
    const outputInfo = await lstat(output);
    if (outputInfo.isSymbolicLink() || !outputInfo.isFile()) throw new TypeError("output 现有目标必须是普通文件且不得是符号链接");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const manifest = parseManifest(JSON.parse((await readStableFile(manifestPath, "skill package manifest")).toString("utf8")));
  const files = await collectFiles(manifest, await trackedSourceIndex());
  await writeArchive(output, files, epoch);
  return output;
}

function parseArguments(argv, environment) {
  let output = null;
  let epoch = environment.SOURCE_DATE_EPOCH ?? null;
  let explicitEpoch = false;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || (flag !== "--output" && flag !== "--source-date-epoch")) {
      throw new TypeError("usage: package-skill.mjs --output /absolute/file.skill --source-date-epoch SECONDS");
    }
    if (flag === "--output") {
      if (output !== null) throw new TypeError("duplicate output argument");
      output = value;
    } else {
      if (explicitEpoch) throw new TypeError("duplicate source date epoch argument");
      explicitEpoch = true;
      epoch = value;
    }
  }
  if (output === null || epoch === null) throw new TypeError("output and source date epoch are required");
  return { output, epoch };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { output, epoch } = parseArguments(process.argv.slice(2), process.env);
    console.log(await packageSkill(output, { sourceDateEpoch: epoch }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 64;
  }
}
