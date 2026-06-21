import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { strict as assert } from "node:assert";
import { resolveGeneratedImageForTest } from "./openai-tools.mjs";

const root = join(tmpdir(), `jerome-openai-tools-${randomUUID()}`);

try {
  await mkdir(join(root, "flat"), { recursive: true });
  await writeFile(join(root, "flat", "ignored.txt"), "nope");
  await writeFile(join(root, "flat.png"), "png");

  await mkdir(join(root, "nested", "outputs"), { recursive: true });
  await writeFile(join(root, "nested", "outputs", "image.webp"), "webp");
  await mkdir(join(root, "magic"), { recursive: true });
  await writeFile(
    join(root, "magic", "image"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64")
  );

  const flat = await resolveGeneratedImageForTest(root, ["flat.png"]);
  assert.equal(flat?.path, join(root, "flat.png"));
  assert.equal(flat?.ext, ".png");

  const nested = await resolveGeneratedImageForTest(root, ["nested"]);
  assert.equal(nested?.path, join(root, "nested", "outputs", "image.webp"));
  assert.equal(nested?.ext, ".webp");

  const magic = await resolveGeneratedImageForTest(root, ["magic"]);
  assert.equal(magic?.path, join(root, "magic", "image"));
  assert.equal(magic?.ext, ".png");

  const none = await resolveGeneratedImageForTest(root, ["flat"]);
  assert.equal(none, null);

  console.log("openai-tools image resolution ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
