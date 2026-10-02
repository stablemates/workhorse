import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = "1.31.1";
const digests: Record<string, string> = {
  linux_amd64: "497ae4fcdfa64c5b0c311ffe4c2bd991e43991e82e5367792ed78bc2dca27354",
  linux_arm64: "b7cae247740d0c51a1e657479e5b2d21e6fef428f596682a01bc55bf4ab8a23d",
  darwin_amd64: "c5af76772e3785d21663a62697056b383f07629979b1bd25b93872e73dbd519b",
  darwin_arm64: "21602158c99eb1f2bae197a66abfb1941d1e9e50b23125bb193349c6b1acc71e",
};

export async function compareGenerated(
  actualDirectory: string,
  expectedDirectory: string,
): Promise<string[]> {
  const actualNames = (await readdir(actualDirectory)).toSorted();
  const expectedNames = (await readdir(expectedDirectory)).toSorted();
  const differences: string[] = [];
  for (const name of new Set([...actualNames, ...expectedNames])) {
    if (!actualNames.includes(name) || !expectedNames.includes(name)) {
      differences.push(name);
      continue;
    }
    const actual = await readFile(path.join(actualDirectory, name));
    const expected = await readFile(path.join(expectedDirectory, name));
    if (!actual.equals(expected)) differences.push(name);
  }
  return differences.toSorted();
}

async function generate(check: boolean): Promise<void> {
  const platform = `${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
  const digest = digests[platform];
  if (digest === undefined) throw new Error(`No pinned sqlc binary for ${platform}`);
  const filename = `sqlc_${version}_${platform}.tar.gz`;
  const cache = path.join(tmpdir(), "workhorse-sqlc", digest);
  await mkdir(cache, { recursive: true });
  const archivePath = path.join(cache, filename);
  let archive: Buffer;
  try {
    archive = await readFile(archivePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const response = await fetch(
      `https://github.com/sqlc-dev/sqlc/releases/download/v${version}/${filename}`,
    );
    if (!response.ok)
      throw new Error(`sqlc download failed: HTTP ${response.status}`, { cause: error });
    archive = Buffer.from(await response.arrayBuffer());
  }
  if (createHash("sha256").update(archive).digest("hex") !== digest) {
    throw new Error(`sqlc ${version} archive checksum mismatch`);
  }
  await writeFile(archivePath, archive);
  const temporary = await mkdtemp(path.join(tmpdir(), "workhorse-sqlc-generate-"));
  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", temporary, "sqlc"]);
    const binary = path.join(temporary, "sqlc");
    if (execFileSync(binary, ["version"], { encoding: "utf8" }).trim() !== `v${version}`) {
      throw new Error(`sqlc version mismatch; expected v${version}`);
    }
    const source = fileURLToPath(new URL("../go/examples/sqlc/", import.meta.url));
    for (const sourceFilename of ["sqlc.yaml", "schema.sql", "queries.sql"]) {
      await copyFile(path.join(source, sourceFilename), path.join(temporary, sourceFilename));
    }
    execFileSync(binary, ["generate", "-f", path.join(temporary, "sqlc.yaml")], {
      stdio: "inherit",
    });
    const regenerated = path.join(temporary, "generated");
    const checkedIn = path.join(source, "generated");
    if (check) {
      const differences = await compareGenerated(regenerated, checkedIn);
      if (differences.length > 0)
        throw new Error(`sqlc generated files drift: ${differences.join(", ")}`);
    } else {
      await rm(checkedIn, { recursive: true, force: true });
      await mkdir(checkedIn);
      for (const name of await readdir(regenerated)) {
        await copyFile(path.join(regenerated, name), path.join(checkedIn, name));
      }
    }
    console.log(
      `sqlc v${version}: ${check ? "generated files match" : "application queries generated"}`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await generate(process.argv.includes("--check"));
}
