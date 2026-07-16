import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
import {
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

import { validateImageMetadata } from "./image-metadata.mjs";
import { parseBoundedJson, readBoundedFile, RESOURCE_LIMITS } from "./resource-limits.mjs";
import { loadTheme } from "./theme-schema.mjs";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
// 单张源图上限：base64 后要内联进一条 CDP Runtime.evaluate，过大易触发 5 秒命令超时
const MAX_SOURCE_IMAGE_BYTES = RESOURCE_LIMITS.assetBytes;
const IMAGE_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);
const THEME_NAME_MAX = 80;

async function requireCanonicalExistingAncestor(path) {
  let current = path;
  while (true) {
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError("主题存储路径祖先必须是真实目录且不得是符号链接");
    }
    if (await realpath(current) !== current) {
      throw new TypeError("主题存储路径祖先必须是规范真实目录");
    }
    return;
  }
}

function validThemeName(value) {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.trim().length > THEME_NAME_MAX
    || value.includes("\0")
    || /[\r\n]/.test(value)
  ) throw new TypeError(`主题名必须是 1 到 ${THEME_NAME_MAX} 个字符的单行文本`);
  return value.trim();
}

async function requireSafeStoreRoot(storeRoot) {
  if (
    typeof storeRoot !== "string"
    || !isAbsolute(storeRoot)
    || resolve(storeRoot) !== storeRoot
    || storeRoot.includes("\0")
  ) throw new TypeError("主题存储目录必须是规范绝对路径");
  await requireCanonicalExistingAncestor(storeRoot);
  await mkdir(storeRoot, { recursive: true, mode: 0o700 });
  const info = await lstat(storeRoot);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("主题存储目标必须是真实目录");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new TypeError("主题存储目录必须属于当前用户");
  }
  const canonical = await realpath(storeRoot);
  if (canonical !== storeRoot) throw new TypeError("主题存储目录必须是规范真实路径");
  const canonicalInfo = await lstat(canonical);
  if (
    canonicalInfo.isSymbolicLink()
    || !canonicalInfo.isDirectory()
    || canonicalInfo.dev !== info.dev
    || canonicalInfo.ino !== info.ino
  ) throw new TypeError("主题存储目录的真实身份不稳定");
  await chmod(storeRoot, 0o700);
  return canonical;
}

async function writeExclusive(path, bytes, mode) {
  const handle = await open(
    path,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  if (process.platform === "win32") return;
  const handle = await open(path, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function destinationState(path, id) {
  let info;
  try { info = await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw new TypeError("目标主题目录不得是符号链接");
  if (!info.isDirectory() || await realpath(path) !== path) {
    throw new TypeError("目标主题路径不是规范真实目录");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new TypeError("目标主题目录必须属于当前用户");
  }
  let existing;
  try { existing = await loadTheme(path); } catch (cause) {
    throw new Error("拒绝覆盖无法归属的现有主题目录", { cause });
  }
  if (existing.manifest.id !== id) throw new Error("现有主题目录归属与目标 ID 不匹配");
  return info;
}

async function invokeHook(hooks, name, value) {
  const hook = hooks?.[name];
  if (hook === undefined) return;
  if (typeof hook !== "function") throw new TypeError(`hooks.${name} 必须是函数`);
  await hook(value);
}

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "custom-skin";
}

export async function createSingleImageTheme({ imagePath, name, storeRoot, colors = {}, hooks = {} }) {
  name = validThemeName(name);
  const extension = extname(imagePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new Error("素材必须是 PNG、JPG、JPEG 或 WebP 图片");
  }
  let sourceBytes;
  try {
    ({ bytes: sourceBytes } = await readBoundedFile(imagePath, {
      maxBytes: MAX_SOURCE_IMAGE_BYTES,
      label: "素材图片",
    }));
  } catch (error) {
    if (/8388608|超过/.test(error?.message ?? "")) {
      throw new Error("素材图片过大（上限 8MB），请先压缩后再做主题，否则注入会超时");
    }
    throw error;
  }
  validateImageMetadata(sourceBytes, { expectedMime: IMAGE_MIME.get(extension) });

  const digest = createHash("sha256")
    .update(name, "utf8")
    .update("\0")
    .update(sourceBytes)
    .digest("hex")
    .slice(0, 16);
  const id = `${slugify(name)}-${digest}`;
  storeRoot = await requireSafeStoreRoot(storeRoot);
  const destination = join(storeRoot, id);
  const transactionId = randomUUID();
  const temporary = join(storeRoot, `.${id}.tmp-${transactionId}`);
  const retired = join(storeRoot, `.${id}.retired-${transactionId}`);
  const hero = `hero${extension}`;
  const manifest = {
    schemaVersion: 1,
    id,
    name,
    hero,
    colors: {
      accent: colors.accent ?? "#24c9d7",
      secondary: colors.secondary ?? "#ef8fd3",
      surface: colors.surface ?? "#f7fbff",
      text: colors.text ?? "#17344f",
    },
    copy: null,
  };

  await mkdir(temporary, { mode: 0o700 });
  let existingRetired = false;
  let published = false;
  try {
    await writeExclusive(join(temporary, hero), sourceBytes, 0o600);
    await writeExclusive(
      join(temporary, "theme.json"),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      0o600,
    );
    await syncDirectory(temporary);
    const staged = await loadTheme(temporary);
    if (
      staged.manifest.id !== id
      || staged.manifest.name !== name
      || !staged.assetBuffers.hero.equals(sourceBytes)
    ) throw new Error("暂存主题与已验证输入不一致");
    const existing = await destinationState(destination, id);
    await invokeHook(hooks, "beforePublish", { destination, temporary, retired, existing });
    if (existing !== null) {
      await rename(destination, retired);
      existingRetired = true;
      await syncDirectory(storeRoot);
      await invokeHook(hooks, "afterExistingRetired", { destination, temporary, retired });
    }
    await rename(temporary, destination);
    published = true;
    await syncDirectory(storeRoot);
    await invokeHook(hooks, "afterPublished", { destination, retired });
    const installed = await loadTheme(destination);
    if (
      installed.manifest.id !== id
      || installed.manifest.name !== name
      || !installed.assetBuffers.hero.equals(sourceBytes)
    ) throw new Error("发布后的主题与已验证输入不一致");
  } catch (error) {
    const rollbackErrors = [];
    const failed = join(storeRoot, `.${id}.failed-${transactionId}`);
    if (published) {
      await rename(destination, failed).catch((failure) => rollbackErrors.push(failure));
    }
    if (existingRetired) {
      await rename(retired, destination).catch((failure) => rollbackErrors.push(failure));
    }
    await rm(failed, { recursive: true, force: true }).catch((failure) => rollbackErrors.push(failure));
    await rm(temporary, { recursive: true, force: true }).catch((failure) => rollbackErrors.push(failure));
    await syncDirectory(storeRoot).catch((failure) => rollbackErrors.push(failure));
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], `${error.message}；主题发布回滚失败`);
    }
    throw error;
  }
  if (existingRetired) {
    await rm(retired, { recursive: true });
    await syncDirectory(storeRoot);
  }
  return { id, path: destination, manifest };
}

export async function listThemes({ roots }) {
  const themes = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const { bytes } = await readBoundedFile(join(root, entry.name, "theme.json"), {
          maxBytes: RESOURCE_LIMITS.manifestBytes,
          label: "theme.json",
        });
        const manifest = parseBoundedJson(bytes);
        // 形状守卫：合法 JSON 但缺 name/id 的坏主题不能进列表，
        // 否则后面 sort 的 a.name.localeCompare 会因 undefined 崩掉整个 list/apply
        if (typeof manifest?.id !== "string" || typeof manifest?.name !== "string") continue;
        themes.push({ ...manifest, path: join(root, entry.name) });
      } catch {
        // A half-copied folder is ignored so listing remains fast and useful.
      }
    }
  }
  return themes.sort((a, b) => a.name.localeCompare(b.name));
}
