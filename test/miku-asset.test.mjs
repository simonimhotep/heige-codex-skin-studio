import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const expectedAssets = [
  ["hero", "miku-full-canvas.png", 1240, 889],
  ["character", "miku-character.png", 608, 375],
  ["sidebar", "miku-sidebar-wash.png", 98, 644],
  ["polaroid", "miku-polaroid.png", 228, 230],
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("keeps every Miku preset crop valid, non-empty, and at its specified geometry", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../assets/miku-crops.json", import.meta.url), "utf8"),
  );
  const source = await readFile(new URL(`../assets/${manifest.source.file}`, import.meta.url));
  const portraitSource = await readFile(
    new URL(`../assets/${manifest.portraitSource.file}`, import.meta.url),
  );
  assert.equal(
    sha256(source),
    "ffb05df56a95748266d6e52a1bbc70a073d706e0ec2930e60735f078241316e3",
    "the UI source must be the enhanced 488137 revision",
  );
  assert.equal(sha256(source), manifest.source.sha256);
  assert.equal(
    sha256(portraitSource),
    "a1e8e01ae1617d21de5e903a2de8591489bd28018d5f19b57626c251d262527c",
    "the character source must be the enhanced portrait revision",
  );
  assert.equal(sha256(portraitSource), manifest.portraitSource.sha256);

  for (const [role, sourceName, width, height] of expectedAssets) {
    const assetPath = new URL(`../assets/${sourceName}`, import.meta.url);
    const [bytes, info] = await Promise.all([readFile(assetPath), stat(assetPath)]);
    assert.ok(info.size > 4_000, `${role} crop is unexpectedly empty`);
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    assert.equal(bytes.readUInt32BE(16), width, `${role} crop width drifted`);
    assert.equal(bytes.readUInt32BE(20), height, `${role} crop height drifted`);
    const crop = manifest.crops.find((candidate) => candidate.role === role);
    assert.equal(crop.file, sourceName);
    assert.equal(crop.width, width);
    assert.equal(crop.height, height);
    assert.ok(["ui", "portrait"].includes(crop.source), `${role} crop source is missing`);
    assert.equal(sha256(bytes), crop.sha256, `${role} crop hash drifted`);
  }
});
