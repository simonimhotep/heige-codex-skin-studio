import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { packageSkill } from "../scripts/package-skill.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillRoot = new URL("../skill/heige-codex-skin-studio/", import.meta.url);
const fixedEpoch = 1_704_067_200;

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function gitStatus() {
  const { stdout } = await execFileAsync("git", ["status", "--short"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return stdout;
}

function centralDirectory(buffer) {
  let end = buffer.length - 22;
  const minimum = Math.max(0, buffer.length - 65_557);
  while (end >= minimum && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < minimum) throw new Error("ZIP EOCD not found");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "central directory signature");
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const nameStart = offset + 46;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const extra = buffer.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);
    let unixMtime = null;
    for (let cursor = 0; cursor + 4 <= extra.length;) {
      const id = extra.readUInt16LE(cursor);
      const size = extra.readUInt16LE(cursor + 2);
      if (cursor + 4 + size > extra.length) throw new Error(`truncated extra field: ${name}`);
      if (id === 0x5455 && size >= 5 && (extra[cursor + 4] & 1) === 1) {
        unixMtime = extra.readUInt32LE(cursor + 5);
      }
      cursor += 4 + size;
    }
    entries.push({
      name,
      mode: (externalAttributes >>> 16) & 0o777,
      unixMtime,
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function zipEntries(path) {
  return centralDirectory(await readFile(path));
}

async function readZipText(path, entry) {
  const { stdout } = await execFileAsync("/usr/bin/unzip", ["-p", path, entry], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

test("keeps the reusable skill free of author paths", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");
  assert.match(skill, /^---\nname: heige-codex-skin-studio\n/);
  assert.doesNotMatch(skill, /\/Users\/blakexu/);
});

test("two allowlisted builds are byte-identical and do not touch tracked output", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "heige-package-test-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const beforeStatus = await gitStatus();
  const first = join(outputRoot, "first.skill");
  const second = join(outputRoot, "second.skill");
  await packageSkill(first, { sourceDateEpoch: fixedEpoch });
  await packageSkill(second, { sourceDateEpoch: fixedEpoch });
  assert.equal(await sha256(first), await sha256(second));
  assert.equal(await gitStatus(), beforeStatus);
});

test("archive is a strict runtime allowlist with fixed metadata", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "heige-package-allowlist-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const archive = join(outputRoot, "candidate.skill");
  await packageSkill(archive, { sourceDateEpoch: fixedEpoch });
  const entries = await zipEntries(archive);
  const names = entries.map(({ name }) => name);
  assert.deepEqual(names, [...names].sort(), "central directory must be lexicographically ordered");
  assert.equal(names.some((name) => name.endsWith("/")), false, "archive has no directory entries");
  for (const required of [
    "heige-codex-skin-studio/LICENSE",
    "heige-codex-skin-studio/NOTICE",
    "heige-codex-skin-studio/SECURITY.md",
    "heige-codex-skin-studio/ASSET_PROVENANCE.md",
    "heige-codex-skin-studio/SKILL.md",
    "heige-codex-skin-studio/README.md",
    "heige-codex-skin-studio/payload/src/cli.mjs",
    "heige-codex-skin-studio/payload/package.json",
  ]) assert.ok(names.includes(required), required);
  assert.equal(
    names.some((name) => /\.before-|reports\/|package-skill|check-asset-provenance|\.git\/|node_modules\/|test\//.test(name)),
    false,
  );
  for (const entry of entries) {
    assert.equal(entry.unixMtime, fixedEpoch, `fixed UTC mtime: ${entry.name}`);
    assert.equal(entry.mode, entry.name.endsWith(".command") ? 0o755 : 0o644, `fixed mode: ${entry.name}`);
  }
  const runtimePackage = JSON.parse(await readZipText(
    archive,
    "heige-codex-skin-studio/payload/package.json",
  ));
  assert.equal("devDependencies" in runtimePackage, false);
  assert.equal(JSON.stringify(runtimePackage).includes("happy-dom"), false);
  assert.equal(JSON.stringify(runtimePackage).includes("yazl"), false);
  assert.deepEqual(Object.keys(runtimePackage), ["name", "version", "type", "engines", "bin", "scripts"]);
});

test("CLI requires exact explicit absolute output and epoch arguments", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "heige-package-cli-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const script = join(repoRoot, "scripts/package-skill.mjs");
  const output = join(outputRoot, "cli.skill");
  const { stdout } = await execFileAsync(process.execPath, [
    script,
    "--output", output,
    "--source-date-epoch", String(fixedEpoch),
  ], { encoding: "utf8" });
  assert.equal(stdout.trim(), output);
  await access(output);
  for (const args of [
    [],
    ["--output", "relative.skill", "--source-date-epoch", String(fixedEpoch)],
    ["--output", output],
    ["--output", output, "--source-date-epoch", String(fixedEpoch), "--extra"],
  ]) {
    await assert.rejects(execFileAsync(process.execPath, [script, ...args]), /output|absolute|epoch|argument|usage/i);
  }
});

test("tracked candidate output needs an explicit release-only override", async () => {
  const tracked = join(repoRoot, "output/heige-codex-skin-studio.skill");
  assert.equal(isAbsolute(tracked), true);
  await assert.rejects(
    packageSkill(tracked, { sourceDateEpoch: fixedEpoch, allowTrackedOutput: false }),
    /tracked|HEIGE_ALLOW_TRACKED_PACKAGE_OUTPUT/,
  );
});

test("shell wrapper requires output and forwards an explicit epoch", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "heige-package-wrapper-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const script = join(repoRoot, "scripts/package-skill.command");
  await assert.rejects(execFileAsync(script, []), (error) => error.code === 64);
  const output = join(outputRoot, "wrapper.skill");
  const { stdout } = await execFileAsync(script, [output, String(fixedEpoch)]);
  assert.equal(stdout.trim(), output);
  assert.equal((await stat(output)).isFile(), true);
});
