/**
 * Package the one published Rust crate and build a clean consumer from that archive.
 *
 * ADR 0074 publishes exactly one crate from `rust/`. The check finds it as the only workspace
 * member that Cargo may publish, so an interim member marked `publish = false` does not count.
 * `cargo package` verifies the archive by compiling its unpacked contents. The consumer lives in a
 * temporary directory outside the workspace. It depends on the crate by registry version, and a
 * `[patch.crates-io]` entry points that version at the unpacked archive. The consumer therefore
 * sees only the files crates.io would serve, never the checkout.
 *
 * The consumer builds with no features and with every declared feature. When a test database is
 * configured, it enqueues one task into a scratch database and the check reads that row back.
 *
 * `--allow-dirty` lets a local run package uncommitted changes. CI refuses it.
 *
 * Usage: tsx scripts/with-env.ts tsx scripts/check-rust-release.ts [--allow-dirty]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";

const root = path.resolve(import.meta.dirname, "..");
const consumerSource = path.join(root, "rust", "release-consumer", "main.rs");
const consumerBinary = "workhorse-release-consumer";
const consumerQueue = "release-consumer";
const consumerTaskType = "release.consumer";

/** Metadata fields a crates.io page needs; `cargo package` only warns when they are absent. */
const requiredMetadata = [
  "description",
  "license",
  "repository",
  "readme",
  "keywords",
  "rust_version",
] as const;

interface CargoPackage {
  id: string;
  name: string;
  version: string;
  manifest_path: string;
  publish: string[] | null;
  features: Record<string, string[]>;
  source: string | null;
  description?: string | null;
  license?: string | null;
  repository?: string | null;
  readme?: string | null;
  keywords?: string[];
  rust_version?: string | null;
}

interface CargoMetadata {
  packages: CargoPackage[];
  workspace_members: string[];
  target_directory: string;
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; capture?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? root,
      env: process.env,
      stdio: ["ignore", options.capture ? "pipe" : "inherit", "inherit"],
    });
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? String(code)}`)),
    );
  });
}

const cargo = (args: readonly string[], options?: { cwd?: string; capture?: boolean }) =>
  run("cargo", args, options);

async function metadata(manifestPath: string, noDeps: boolean): Promise<CargoMetadata> {
  const args = ["metadata", "--format-version", "1", "--manifest-path", manifestPath];
  if (noDeps) args.push("--no-deps");
  return JSON.parse(await cargo(args, { capture: true })) as CargoMetadata;
}

/** The single workspace member Cargo may publish; `publish = false` reads as an empty list. */
export function publishedCrate(workspace: CargoMetadata): CargoPackage {
  const members = new Set(workspace.workspace_members);
  const publishable = workspace.packages.filter(
    (candidate) =>
      members.has(candidate.id) && (candidate.publish === null || candidate.publish.length > 0),
  );
  if (publishable.length !== 1) {
    const names = publishable.map((candidate) => candidate.name).join(", ") || "none";
    throw new Error(`ADR 0074 publishes exactly one Rust crate; the workspace publishes ${names}`);
  }
  const crate = publishable[0]!;
  const expected = path.join(root, "rust", "Cargo.toml");
  if (path.resolve(crate.manifest_path) !== expected) {
    throw new Error(`The published crate must be rooted at rust/, not ${crate.manifest_path}`);
  }
  const missing = requiredMetadata.filter((field) => {
    const value = crate[field];
    return value === undefined || value === null || value.length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`rust/Cargo.toml lacks publishable metadata: ${missing.join(", ")}`);
  }
  return crate;
}

/**
 * The consumer manifest. The dependency key `workhorse` fixes the import path whatever the package
 * or library is named, so an SM-882 rename changes only `rust/Cargo.toml`.
 */
export function consumerManifest(crate: { name: string; version: string }, unpacked: string) {
  const name = JSON.stringify(crate.name);
  return [
    "[package]",
    `name = "${consumerBinary}"`,
    'version = "0.0.0"',
    'edition = "2021"',
    "publish = false",
    "",
    "[[bin]]",
    `name = "${consumerBinary}"`,
    'path = "src/main.rs"',
    "",
    "[dependencies]",
    `workhorse = { package = ${name}, version = "=${crate.version}" }`,
    'serde_json = "1"',
    'tokio = { version = "1", features = ["macros", "rt-multi-thread"] }',
    'tokio-postgres = "0.7"',
    "",
    "[patch.crates-io]",
    `${name} = { path = ${JSON.stringify(unpacked)} }`,
    "",
    // An empty workspace table keeps Cargo from adopting a workspace above the temporary directory.
    "[workspace]",
    "",
  ].join("\n");
}

/** A scratch name `pnpm db:sweep` recognizes: the source name, a tag, and a ten-digit digest. */
export function scratchDatabaseName(source: string, pid: number): string {
  const digest = createHash("sha256").update(`rust-release:${pid}`).digest("hex");
  return `${source.slice(0, 44)}_rc_${digest.slice(0, 10)}`;
}

function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL_TEST_PACKED;
  if (url) return url;
  if (process.env.CI || process.env.WORKHORSE_REQUIRE_DATABASE === "1") {
    throw new Error("The Rust release check needs DATABASE_URL_TEST or DATABASE_URL_TEST_PACKED");
  }
  return undefined;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function runTaskThroughConsumer(binary: string, sourceUrl: string): Promise<void> {
  const source = decodeURIComponent(new URL(sourceUrl).pathname.slice(1));
  if (!source.includes("test")) throw new Error(`${source} is not a test database`);
  const scratch = scratchDatabaseName(source, process.pid);
  const identifier = `"${scratch.replaceAll('"', '""')}"`;
  const scratchUrl = withDatabase(sourceUrl, scratch);

  const admin = new Client({ connectionString: sourceUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${identifier} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${identifier}`);
    try {
      const database = new Client({ connectionString: scratchUrl });
      await database.connect();
      try {
        await database.query(
          await readFile(path.join(root, "sql", "schema", "current.sql"), "utf8"),
        );
        const taskId = (await run(binary, [scratchUrl], { capture: true })).trim();
        const { rows } = await database.query<{
          queue_name: string;
          task_type: string;
          state: string | null;
          packaged: boolean | null;
        }>(
          `SELECT task.queue_name, task.task_type, outcome.state,
                  (outcome.result -> 'echo' ->> 'packaged')::boolean AS packaged
             FROM workhorse.task task
             LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
            WHERE task.id = $1::uuid`,
          [taskId],
        );
        const row = rows[0];
        if (row?.queue_name !== consumerQueue || row.task_type !== consumerTaskType) {
          throw new Error(`The consumer reported task ${taskId}, but no matching row exists`);
        }
        if (row.state !== "succeeded" || row.packaged !== true) {
          throw new Error(`The consumer's worker left task ${taskId} in state ${row.state}`);
        }
        console.log(`The packaged crate enqueued and ran task ${taskId} in ${scratch}`);
      } finally {
        await database.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${identifier} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}

async function checkRustRelease(argv: readonly string[]): Promise<void> {
  const allowDirty = argv.includes("--allow-dirty");
  if (allowDirty && process.env.CI) throw new Error("CI packages only committed files");
  const url = databaseUrl();

  const workspace = await metadata(path.join(root, "Cargo.toml"), true);
  const crate = publishedCrate(workspace);
  const packageArgs = ["package", "--package", crate.name, "--locked"];
  if (allowDirty) packageArgs.push("--allow-dirty");
  await cargo(packageArgs);

  const archive = path.join(
    workspace.target_directory,
    "package",
    `${crate.name}-${crate.version}.crate`,
  );
  const temporary = await mkdtemp(path.join(tmpdir(), "workhorse-rust-release-"));
  try {
    await run("tar", ["-xzf", archive, "-C", temporary]);
    const unpacked = path.join(temporary, `${crate.name}-${crate.version}`);

    const consumer = path.join(temporary, "consumer");
    await mkdir(path.join(consumer, "src"), { recursive: true });
    await writeFile(path.join(consumer, "Cargo.toml"), consumerManifest(crate, unpacked));
    await copyFile(consumerSource, path.join(consumer, "src", "main.rs"));
    const manifest = path.join(consumer, "Cargo.toml");

    const resolved = (await metadata(manifest, false)).packages.find(
      (candidate) => candidate.name === crate.name,
    );
    if (!resolved || resolved.source !== null || !resolved.manifest_path.startsWith(unpacked)) {
      throw new Error(`The consumer resolved ${crate.name} from outside ${archive}`);
    }

    // A shared target directory caches the dependencies between runs without sharing sources.
    const target = path.join(workspace.target_directory, "release-consumer");
    const build = ["build", "--manifest-path", manifest, "--target-dir", target];
    const features = Object.keys(crate.features).filter((feature) => feature !== "default");
    await cargo(build);
    if (features.length > 0) {
      await cargo([...build, "--features", features.map((f) => `workhorse/${f}`).join(",")]);
      // The all-features build replaced the binary; the database run uses the default build.
      await cargo(build);
    }
    const binary = path.join(target, "debug", consumerBinary);
    await run(binary, []);

    if (url) await runTaskThroughConsumer(binary, url);
    else console.log("SKIPPED the consumer task: DATABASE_URL_TEST is unset");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await checkRustRelease(process.argv.slice(2));
}
