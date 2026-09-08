import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { sourceFingerprint, treeFingerprint } from "./build-fingerprint.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workhorse-build-fingerprint-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet"], {
    cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  });
  await writeFile(path.join(root, ".gitignore"), "dist/\n");
  await writeFile(path.join(root, "source.ts"), "first");
  await mkdir(path.join(root, "dist/assets"), { recursive: true });
  await writeFile(path.join(root, "dist/assets/chunk.js"), "compiled");
  return root;
}

it("detects edits and additions to uncommitted source without treating outputs as source", async () => {
  const root = await fixture();
  const original = await sourceFingerprint(root);
  await writeFile(path.join(root, "dist/assets/chunk.js"), "another build");
  expect(await sourceFingerprint(root)).toBe(original);
  await writeFile(path.join(root, "source.ts"), "second");
  expect(await sourceFingerprint(root)).not.toBe(original);
  await writeFile(path.join(root, "source.ts"), "first");
  await writeFile(path.join(root, "new.ts"), "new module");
  expect(await sourceFingerprint(root)).not.toBe(original);
});

it("detects changed and deleted nested output chunks", async () => {
  const root = await fixture();
  const original = await treeFingerprint(root, ["dist"]);
  await writeFile(path.join(root, "dist/assets/chunk.js"), "changed");
  expect(await treeFingerprint(root, ["dist"])).not.toBe(original);
  await rm(path.join(root, "dist/assets/chunk.js"));
  expect(await treeFingerprint(root, ["dist"])).not.toBe(original);
});
