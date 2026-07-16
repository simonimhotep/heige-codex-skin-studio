#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { classifyInjection, discoverCodex, runtimeDiagnostics } from "./codex-app.mjs";
import { DEFAULT_CDP_PORT, DEFAULT_THEME_ID, resolveStudioPaths } from "./constants.mjs";
import { applySkin, removeSkin, skinStatus } from "./injector.mjs";
import { loadTheme } from "./theme-schema.mjs";
import { createSingleImageTheme, listThemes } from "./theme-store.mjs";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const BOOLEAN_FLAGS = new Set(["prefer-stored"]);

function options(argv) {
  const result = {};
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`无法识别的参数：${key}`);
    const name = key.slice(2);
    if (BOOLEAN_FLAGS.has(name)) { result[name] = true; continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} 缺少值`);
    result[name] = value;
    index += 1;
  }
  return result;
}

function portFrom(value) {
  const port = value === undefined ? DEFAULT_CDP_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port 必须是 1024 到 65535 的整数");
  return port;
}

function defaults(overrides) {
  const paths = resolveStudioPaths();
  return {
    bundledThemesRoot: join(sourceRoot, "themes"),
    userThemesRoot: paths.userThemesRoot,
    loadTheme,
    listThemes,
    createSingleImageTheme,
    applySkin,
    removeSkin,
    skinStatus,
    ...overrides,
  };
}

export async function runCli(argv, overrides = {}) {
  const command = argv[0] ?? "help";
  const args = options(argv);
  const deps = defaults(overrides);
  const roots = [deps.bundledThemesRoot, deps.userThemesRoot];

  if (command === "help") {
    return {
      commands: ["list", "create --image PATH --name NAME", "apply [--theme ID] [--port 9341]", "pause", "status", "doctor"],
    };
  }
  if (command === "list") return deps.listThemes({ roots });
  if (command === "create") {
    if (!args.image) throw new Error("create 需要 --image");
    if (!args.name) throw new Error("create 需要 --name");
    return deps.createSingleImageTheme({ imagePath: args.image, name: args.name, storeRoot: deps.userThemesRoot });
  }
  if (command === "apply") {
    const themeId = args.theme ?? DEFAULT_THEME_ID;
    const themes = await deps.listThemes({ roots });
    const selected = themes.find((theme) => theme.id === themeId);
    if (!selected) throw new Error(`找不到主题：${themeId}`);
    const loadedTheme = await deps.loadTheme(selected.path);
    const menuThemes = [];
    for (const theme of themes) {
      if (theme.id === themeId) {
        menuThemes.push(loadedTheme);
        continue;
      }
      try {
        menuThemes.push(await deps.loadTheme(theme.path));
      } catch {
        // 坏主题不阻塞换肤，只是不进菜单
      }
    }
    return deps.applySkin({ loadedTheme, themes: menuThemes, port: portFrom(args.port), preferStored: Boolean(args["prefer-stored"]) });
  }
  if (command === "pause" || command === "restore") {
    return deps.removeSkin({ port: portFrom(args.port) });
  }
  if (command === "status") return deps.skinStatus({ port: portFrom(args.port) });
  if (command === "doctor") {
    const discovery = await (deps.discoverCodex ?? discoverCodex)();
    const runtime = await (deps.runtimeDiagnostics ?? runtimeDiagnostics)({
      appPath: discovery.app,
      port: portFrom(args.port),
    });
    return {
      ...discovery,
      cdpPort: portFrom(args.port),
      ...runtime,
      diagnosis: classifyInjection(runtime),
    };
  }
  throw new Error(`未知命令：${command}`);
}

// argv[1] 保留符号链接原路径，import.meta.url 是 realpath，npm bin 软链下必失配。
// 先把 argv[1] 解成真实路径再比，否则通过 bin 软链调用会静默什么都不做、假成功退出 0。
function isMainEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  let real = entry;
  try {
    real = realpathSync(entry);
  } catch {
    // 解析失败就退回原路径比较
  }
  return pathToFileURL(real).href === import.meta.url;
}

if (isMainEntry()) {
  runCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`HeiGe Codex Skin Studio：${error.message}\n`);
      process.exitCode = 1;
    });
}
