import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
// 单张源图上限：base64 后要内联进一条 CDP Runtime.evaluate，过大易触发 5 秒命令超时
const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024;

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "custom-skin";
}

export async function createSingleImageTheme({ imagePath, name, storeRoot, colors = {} }) {
  const extension = extname(imagePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new Error("素材必须是 PNG、JPG、JPEG 或 WebP 图片");
  }
  const source = await stat(imagePath);
  if (!source.isFile() || source.size === 0) throw new Error("素材图片不存在或为空");
  if (source.size > MAX_SOURCE_IMAGE_BYTES) {
    const mb = (source.size / 1024 / 1024).toFixed(1);
    throw new Error(`素材图片 ${mb}MB 过大（上限 8MB），请先压缩后再做主题，否则注入会超时`);
  }

  const digest = createHash("sha256")
    .update(`${name}\0${basename(imagePath)}\0${source.size}\0${source.mtimeMs}`)
    .digest("hex")
    .slice(0, 8);
  const id = `${slugify(name)}-${digest}`;
  const destination = join(storeRoot, id);
  const temporary = `${destination}.tmp-${process.pid}`;
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

  await mkdir(storeRoot, { recursive: true });
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    await copyFile(imagePath, join(temporary, hero));
    await writeFile(join(temporary, "theme.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
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
        const manifest = JSON.parse(await readFile(join(root, entry.name, "theme.json"), "utf8"));
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
