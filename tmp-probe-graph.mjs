import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { queryWindowsRuntimeSnapshot, classifyWindowsPreflightSnapshot } from "./src/windows-runtime.mjs";
import { probeWindowsNativeProcessFromSnapshot } from "./src/cli.mjs";

const install = join(process.env.USERPROFILE, ".codex", "heige-codex-skin-studio");
const common = join(install, "scripts", "windows", "lib", "common.ps1");

function ps(script) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 10e6,
    windowsHide: true,
    env: process.env,
  });
  return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

if (!process.env.HEIGE_WINDOWS_APP_IDENTITY) {
  const r = ps(`. '${common.replace(/'/g, "''")}'; ConvertTo-HeiGeCodexAppIdentityToken -App (Resolve-CodexApp)`);
  if (r.status !== 0) throw new Error(r.err || r.out);
  process.env.HEIGE_WINDOWS_APP_IDENTITY = r.out.split(/\r?\n/).filter(Boolean).at(-1);
  console.log("identity set, len", process.env.HEIGE_WINDOWS_APP_IDENTITY.length);
}

const mode = process.argv[2] || "snapshot";
if (mode === "native") {
  console.log("close", ps(`& '${join(install, "scripts", "windows", "close-codex.ps1").replace(/'/g, "''")}'`).out.slice(0, 240));
  console.log("native", ps(`. '${common.replace(/'/g, "''")}'; Start-CodexNative -AppInfo (Resolve-CodexApp); 'started'`).out);
  await new Promise((r) => setTimeout(r, 5000));
}

const snap = await queryWindowsRuntimeSnapshot({
  port: 9341,
  env: process.env,
  powershellPath: join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  commonScriptPath: common,
});
console.log(JSON.stringify({
  processCount: snap.processes.length,
  listenerCount: snap.listeners.length,
  processes: snap.processes.map((p) => ({ pid: p.pid, ppid: p.parentProcessId })),
  listeners: snap.listeners.map((l) => ({ pid: l.pid, port: l.localPort })),
}, null, 2));

try {
  console.log("probe", probeWindowsNativeProcessFromSnapshot(snap, { port: 9341 }));
} catch (e) {
  console.log("probe FAIL", e.message);
}

if (snap.listeners.length === 0) {
  try {
    console.log("classify", classifyWindowsPreflightSnapshot(snap, { port: 9341, requirePort: false }).process);
  } catch (e) {
    console.log("classify FAIL", e.message);
  }
}
