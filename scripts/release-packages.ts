import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { packedPackages, packageTarballFilename } from "./package-metadata.js";
import { runCommand } from "./run-command.js";

type ReleaseCommand = "pack" | "publish";

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
  return manifest.version;
}

async function pack(): Promise<void> {
  const destination = path.resolve("dist-tarballs");
  await mkdir(destination, { recursive: true });
  for (const packageEntry of packedPackages) {
    await runCommand("pnpm", [
      "--silent",
      "--dir",
      packageEntry.directory,
      "pack",
      "--pack-destination",
      destination,
    ]);
  }
}

async function publish(): Promise<void> {
  const version = await packageVersion();
  for (const { name } of packedPackages) {
    const tarball = packageTarballFilename(name, version);
    await runCommand("npm", [
      "publish",
      "--provenance",
      "--access",
      "public",
      path.join("dist-tarballs", tarball),
    ]);
  }
}

const command = process.argv[2] as ReleaseCommand | undefined;
if (command === "pack") await pack();
else if (command === "publish") await publish();
else throw new Error("Usage: release-packages.ts <pack|publish>");
