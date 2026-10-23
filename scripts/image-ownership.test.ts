import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./packages.js";

// The runtime images run as the node user, and root owns the application code (SM-1667). A
// compromised process therefore cannot replace the code that the next restart loads. Each image
// build runs a check as the node user that fails when that user can write an application file.
// This test keeps the check and the root-owned copies in the Dockerfiles, so CI holds them without
// building an image.
async function runtimeStage(dockerfile: string): Promise<string> {
  const source = await readFile(path.join(repositoryRoot, dockerfile), "utf8");
  const start = source.search(/^FROM \S+ AS runtime$/m);
  expect(start, `${dockerfile} has no runtime stage`).toBeGreaterThan(-1);
  return source.slice(start);
}

describe.each([
  { dockerfile: "Dockerfile", writable: ["/opt/workhorse-demo/logs"] },
  { dockerfile: "Dockerfile.dashboard", writable: [] },
])("$dockerfile", ({ dockerfile, writable }) => {
  it("copies the application into the runtime stage as root", async () => {
    const stage = await runtimeStage(dockerfile);
    expect(stage.match(/^COPY .*--chown.*$/gm) ?? []).toEqual([]);
    const chowns = [...stage.matchAll(/chown node:node (\S+)/g)].map((match) => match[1]);
    expect(chowns).toEqual(writable.map((directory) => path.basename(directory)));
  });

  it("fails the build when the node user can write an application file", async () => {
    const stage = await runtimeStage(dockerfile);
    const user = stage.indexOf("\nUSER node\n");
    const check = stage.indexOf(
      "! -type l \\( -user node -o -group node -o -perm -0002 \\) -print",
    );
    expect(user).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(user);
    expect(stage).toMatch(/if touch \/opt\/\S+\/\.write-probe 2>\/dev\/null; then/);
    for (const directory of writable) expect(stage).toContain(`-path ${directory} -prune`);
    expect(stage.slice(check)).toContain("exit 1");
  });
});
