import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";

import {
  inspectLaunchAgent,
  registerControllerAgent,
  unregisterControllerAgent,
} from "../src/macos-launch-agent.mjs";

const execFileAsync = promisify(execFile);
const enabled = process.platform === "darwin" && process.env.HEIGE_RUN_LAUNCHD_INTEGRATION === "1";

test("isolated random-label LaunchAgent can be registered and removed", { skip: !enabled }, async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "heige-launchd-integration-")),
  );
  const label = `com.heige.codex-skin-controller.test.${randomUUID()}`;
  const processUid = process.getuid();
  const options = {
    home: root,
    launchAgentsDir: join(root, "Library", "LaunchAgents"),
    stateDir: join(root, "state"),
    label,
    processUid,
    programArguments: ["/bin/sleep", "60"],
    testMode: true,
  };

  t.after(async () => {
    await execFileAsync("/bin/launchctl", ["bootout", `gui/${processUid}/${label}`]).catch(() => {});
    await unregisterControllerAgent(options).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await registerControllerAgent(options);
  assert.equal((await inspectLaunchAgent(options)).loaded, true);
  await unregisterControllerAgent(options);
  assert.equal((await inspectLaunchAgent(options)).loaded, false);
});
