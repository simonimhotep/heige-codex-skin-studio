import assert from "node:assert/strict";
import test from "node:test";

import { readProcessIdentity } from "../src/process-identity.mjs";

test("Windows process identity uses trusted PowerShell with an isolated module path", async () => {
  const env = {
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
    psMODULEpath: "C:\\Users\\Alice\\Documents\\PowerShell\\Modules",
  };
  const calls = [];
  const result = await readProcessIdentity(4242, {
    platform: "win32",
    env,
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: JSON.stringify({
          pid: 4242,
          startedAt: "2026-07-17T08:00:00.0000000Z",
        }),
      };
    },
  });

  assert.deepEqual(result, {
    pid: 4242,
    startedAt: "2026-07-17T08:00:00.0000000Z",
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].file,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.equal(calls[0].args.includes("-NoProfile"), true);
  assert.deepEqual(calls[0].options.env, {
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
  });
  assert.equal(env.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules");
});
