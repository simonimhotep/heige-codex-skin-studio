import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

// Codex Desktop 各平台安装位点。Windows 覆盖 electron-builder 常见目录，
// doctor 逐个探测并报告命中的那一个。
export function codexAppCandidates({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    return [
      win32.join(localAppData, "Programs", "ChatGPT", "ChatGPT.exe"),
      win32.join(localAppData, "Programs", "Codex", "Codex.exe"),
      win32.join(programFiles, "ChatGPT", "ChatGPT.exe"),
      win32.join(programFiles, "Codex", "Codex.exe"),
    ];
  }
  return ["/Applications/ChatGPT.app"];
}

export function bundledNodeCandidates(appPath, { platform = process.platform } = {}) {
  if (platform === "win32") {
    const appDir = win32.dirname(appPath);
    return [
      win32.join(appDir, "resources", "cua_node", "node.exe"),
      win32.join(appDir, "resources", "cua_node", "bin", "node.exe"),
    ];
  }
  return [posix.join(appPath, "Contents", "Resources", "cua_node", "bin", "node")];
}

async function firstExisting(paths, exists) {
  for (const path of paths) {
    if (await exists(path)) return path;
  }
  return null;
}

export async function discoverCodex({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  exists = (path) => access(path).then(() => true, () => false),
} = {}) {
  const candidates = codexAppCandidates({ platform, env, home });
  const app = await firstExisting(candidates, exists);
  const nodeCandidates = app ? bundledNodeCandidates(app, { platform }) : [];
  const bundledNode = app ? await firstExisting(nodeCandidates, exists) : null;
  return {
    platform,
    app: app ?? candidates[0],
    appFound: app !== null,
    candidates,
    bundledNode: bundledNode ?? nodeCandidates[0] ?? null,
    bundledNodeFound: bundledNode !== null,
  };
}
