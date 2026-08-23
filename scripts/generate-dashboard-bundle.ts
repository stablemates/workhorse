import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { repositoryRoot } from "./packages.js";

interface DashboardManifest {
  readonly readSurfaceVersion: number;
}

interface BundleManifest {
  readonly formatVersion: 1;
  readonly readSurfaceVersion: number;
  readonly archive: string;
  readonly sha256: string;
}

const check = process.argv.includes("--check");
const fetchOnly = process.argv.includes("--fetch");
const bundleDirectory = path.join(repositoryRoot, "dashboard/v1/bundle");
const languageDirectories = [
  path.join(repositoryRoot, "go/dashboard"),
  path.join(repositoryRoot, "python/src/workhorse/dashboard"),
];

function writeString(target: Buffer, offset: number, length: number, value: string): void {
  target.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  writeString(target, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarEntry(name: string, content: Buffer): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`Dashboard bundle path is too long: ${name}`);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

async function bundleFiles(directory: string, prefix = ""): Promise<readonly [string, Buffer][]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(async (entry): Promise<readonly [string, Buffer][]> => {
        const filePath = path.join(directory, entry.name);
        const archivePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        return entry.isDirectory()
          ? bundleFiles(filePath, archivePath)
          : [[archivePath, await readFile(filePath)]];
      }),
  );
  return files.flat();
}

async function createArchive(directory: string): Promise<Buffer> {
  const files = await bundleFiles(directory);
  const tar = Buffer.concat([
    ...files.map(([name, content]) => tarEntry(name, content)),
    Buffer.alloc(1024),
  ]);
  const archive = gzipSync(tar, { level: 9 });
  archive[9] = 0xff;
  return archive;
}

async function readBundleManifest(): Promise<BundleManifest> {
  return JSON.parse(
    await readFile(path.join(bundleDirectory, "bundle.json"), "utf8"),
  ) as BundleManifest;
}

async function readDashboardManifest(): Promise<DashboardManifest> {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, "dashboard/v1/manifest.json"), "utf8"),
  ) as DashboardManifest;
}

function validateBundleVersion(contract: DashboardManifest, bundle: BundleManifest): void {
  if (bundle.readSurfaceVersion !== contract.readSurfaceVersion) {
    throw new Error(
      `dashboard/v1 bundle targets read surface ${bundle.readSurfaceVersion}, but the contract targets ${contract.readSurfaceVersion}; run pnpm dashboard-bundle:generate`,
    );
  }
}

async function copyPublishedBundle(manifest: BundleManifest): Promise<void> {
  const files = ["bundle.json", manifest.archive];
  for (const directory of languageDirectories) {
    await mkdir(directory, { recursive: true });
    for (const name of await readdir(directory)) {
      if (name.endsWith(".tar.gz") && name !== manifest.archive) {
        await rm(path.join(directory, name));
      }
    }
    await Promise.all(
      files.map((name) => cp(path.join(bundleDirectory, name), path.join(directory, name))),
    );
  }
}

async function validatePublishedBundle(manifest: BundleManifest): Promise<void> {
  const archive = await readFile(path.join(bundleDirectory, manifest.archive));
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== manifest.sha256) {
    throw new Error(
      `dashboard/v1 bundle digest is stale: expected ${manifest.sha256}, got ${digest}`,
    );
  }
  for (const directory of languageDirectories) {
    for (const name of ["bundle.json", manifest.archive]) {
      const [published, fetched] = await Promise.all([
        readFile(path.join(bundleDirectory, name)),
        readFile(path.join(directory, name)).catch(() => null),
      ]);
      if (!fetched || !published.equals(fetched)) {
        throw new Error(`${path.relative(repositoryRoot, path.join(directory, name))} is stale`);
      }
    }
  }
}

if (fetchOnly) {
  const [contract, manifest] = await Promise.all([readDashboardManifest(), readBundleManifest()]);
  validateBundleVersion(contract, manifest);
  await validatePublishedBundle(manifest).catch(async () => copyPublishedBundle(manifest));
  await validatePublishedBundle(manifest);
} else {
  const contract = await readDashboardManifest();
  const archiveName = `read-surface-${contract.readSurfaceVersion}.tar.gz`;
  const temporary = await mkdtemp(path.join(tmpdir(), "workhorse-dashboard-bundle-"));
  try {
    await cp(path.join(repositoryRoot, "dashboard/app/dist/app"), path.join(temporary, "app"), {
      recursive: true,
    });
    await cp(
      path.join(repositoryRoot, "dashboard/app/browser/login.html"),
      path.join(temporary, "login.html"),
    );
    const archive = await createArchive(temporary);
    const manifest: BundleManifest = {
      formatVersion: 1,
      readSurfaceVersion: contract.readSurfaceVersion,
      archive: archiveName,
      sha256: createHash("sha256").update(archive).digest("hex"),
    };
    const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;

    if (check) {
      const [committedArchive, committedManifest] = await Promise.all([
        readFile(path.join(bundleDirectory, archiveName)).catch(() => null),
        readFile(path.join(bundleDirectory, "bundle.json"), "utf8").catch(() => null),
      ]);
      if (!committedArchive?.equals(archive) || committedManifest !== manifestContent) {
        throw new Error("dashboard/v1 bundle is stale; run pnpm dashboard-bundle:generate");
      }
      await validatePublishedBundle(manifest);
    } else {
      await mkdir(bundleDirectory, { recursive: true });
      const previous = await readBundleManifest().catch(() => undefined);
      if (previous && previous.archive !== archiveName) {
        await rm(path.join(bundleDirectory, previous.archive), { force: true });
      }
      await writeFile(path.join(bundleDirectory, archiveName), archive);
      await writeFile(path.join(bundleDirectory, "bundle.json"), manifestContent);
      await copyPublishedBundle(manifest);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
