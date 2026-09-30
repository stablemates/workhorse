/**
 * Build the Ruby gem and run a clean consumer from the built `.gem`.
 *
 * ADR 0075 publishes one gem, `stablemates-workhorse`, from `ruby/`. The check builds it with
 * `gem build --strict`, so a specification warning fails the rehearsal. It then reads the file list
 * the archive carries: every file the gem requires at load time must be inside, and nothing from
 * the test suite may be.
 *
 * The consumer is a temporary directory outside the checkout with an empty gem home. `gem install`
 * installs the built archive there and resolves its runtime dependencies from RubyGems.org, as an
 * application would. The consumer runs without Bundler and without a load path into the checkout,
 * so it loads only the files RubyGems.org would serve. It reports where the gem loaded from, and the
 * check refuses any path outside that gem home.
 *
 * When a test database is configured, the consumer enqueues one task into a scratch database and
 * runs it through a worker, and the check reads that row back.
 *
 * Usage: tsx scripts/with-env.ts tsx scripts/check-ruby-release.ts
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { dropLocalDatabase } from "../typescript/core/src/drop-local-database.js";

const root = path.resolve(import.meta.dirname, "..");
const gemDirectory = path.join(root, "ruby");
const gemName = "stablemates-workhorse";
const consumerSource = path.join(gemDirectory, "release-consumer", "consumer.rb");
const consumerQueue = "release-consumer";
const consumerTaskType = "release.consumer";

/** Files an installed gem cannot work without, and the documents RubyGems.org links to. */
const requiredFiles = [
  "lib/stablemates/workhorse.rb",
  "lib/stablemates/workhorse/version.rb",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "README.md",
] as const;

/** Prefixes that belong to the checkout and never to the published gem. */
const excludedPrefixes = ["spec/", "examples/", "gemfiles/", "release-consumer/", "tools/"];

/** Variables that would point the consumer at the checkout's bundle or gems. */
const inheritedRubyVariables = /^(BUNDLE_|BUNDLER_|GEM_|RUBYOPT$|RUBYLIB$)/;

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; capture?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
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

/** The files a `.gem` archive lists that break the rules above, as readable problems. */
export function packagedFileProblems(files: readonly string[]): string[] {
  const present = new Set(files);
  return [
    ...requiredFiles
      .filter((file) => !present.has(file))
      .map((file) => `the gem does not carry ${file}`),
    ...files
      .filter((file) => excludedPrefixes.some((prefix) => file.startsWith(prefix)))
      .map((file) => `the gem carries ${file}, which belongs to the checkout`),
  ];
}

/** The consumer's environment: the ambient one without Ruby settings, plus an isolated gem home. */
export function consumerEnvironment(
  ambient: NodeJS.ProcessEnv,
  gemHome: string,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(ambient).filter(([key]) => !inheritedRubyVariables.test(key)),
  );
  return { ...environment, GEM_HOME: gemHome, GEM_PATH: gemHome, GEM_SPEC_CACHE: gemHome };
}

/** A scratch name `pnpm db:sweep` recognizes: the source name, a tag, and a ten-digit digest. */
export function scratchDatabaseName(source: string, pid: number): string {
  const digest = createHash("sha256").update(`ruby-release:${pid}`).digest("hex");
  return `${source.slice(0, 44)}_gc_${digest.slice(0, 10)}`;
}

function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL_TEST_PACKED;
  if (url) return url;
  if (process.env.CI || process.env.WORKHORSE_REQUIRE_DATABASE === "1") {
    throw new Error("The Ruby release check needs DATABASE_URL_TEST or DATABASE_URL_TEST_PACKED");
  }
  return undefined;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function runTaskThroughConsumer(
  consume: (args: readonly string[]) => Promise<string>,
  sourceUrl: string,
): Promise<void> {
  const source = decodeURIComponent(new URL(sourceUrl).pathname.slice(1));
  if (!source.includes("test")) throw new Error(`${source} is not a test database`);
  const scratch = scratchDatabaseName(source, process.pid);
  const identifier = `"${scratch.replaceAll('"', '""')}"`;
  const scratchUrl = withDatabase(sourceUrl, scratch);

  const admin = new Client({ connectionString: sourceUrl });
  await admin.connect();
  try {
    await dropLocalDatabase(admin, scratch);
    await admin.query(`CREATE DATABASE ${identifier}`);
    try {
      const database = new Client({ connectionString: scratchUrl });
      await database.connect();
      try {
        await database.query(
          await readFile(path.join(root, "sql", "schema", "current.sql"), "utf8"),
        );
        const taskId = (await consume([scratchUrl])).trim();
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
        console.log(`The packaged gem enqueued and ran task ${taskId} in ${scratch}`);
      } finally {
        await database.end();
      }
    } finally {
      await dropLocalDatabase(admin, scratch);
    }
  } finally {
    await admin.end();
  }
}

async function checkRubyRelease(): Promise<void> {
  const url = databaseUrl();
  // The consumer runs outside the checkout, where a version manager's shim may find no Ruby. The
  // checkout's own interpreter and its `gem` command, by absolute path, avoid that lookup.
  const bindir = (
    await run("ruby", ["-e", "print RbConfig::CONFIG.fetch('bindir')"], {
      cwd: gemDirectory,
      capture: true,
    })
  ).trim();
  const ruby = path.join(bindir, "ruby");
  const version = (
    await run(
      ruby,
      [
        "-e",
        'require_relative "lib/stablemates/workhorse/version"; print Stablemates::Workhorse::VERSION',
      ],
      { cwd: gemDirectory, capture: true },
    )
  ).trim();

  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "workhorse-ruby-release-")));
  try {
    const archive = path.join(temporary, `${gemName}-${version}.gem`);
    await run(ruby, ["-S", "gem", "build", "--strict", `${gemName}.gemspec`, "--output", archive], {
      cwd: gemDirectory,
      env: consumerEnvironment(process.env, path.join(temporary, "build-home")),
    });

    const files = JSON.parse(
      await run(
        ruby,
        [
          "-rjson",
          "-rrubygems/package",
          "-e",
          "print JSON.generate(Gem::Package.new(ARGV[0]).spec.files)",
          archive,
        ],
        { capture: true },
      ),
    ) as string[];
    const problems = packagedFileProblems(files);
    if (problems.length > 0) throw new Error(problems.join("\n"));
    console.log(`The packaged gem carries ${files.length} files`);

    const gemHome = path.join(temporary, "gems");
    const environment = consumerEnvironment(process.env, gemHome);
    const consumer = path.join(temporary, "consumer");
    await mkdir(consumer, { recursive: true });
    await copyFile(consumerSource, path.join(consumer, "consumer.rb"));
    await run(ruby, ["-S", "gem", "install", "--no-document", "--install-dir", gemHome, archive], {
      cwd: consumer,
      env: environment,
    });

    const consume = (args: readonly string[]) =>
      run(ruby, ["consumer.rb", ...args], {
        cwd: consumer,
        env: environment,
        capture: true,
      });
    const [loadedFrom, loadedVersion] = (await consume([])).trim().split("\n");
    const expected = path.join(gemHome, "gems", `${gemName}-${version}`);
    if (loadedFrom !== expected) {
      throw new Error(`The consumer loaded ${gemName} from ${loadedFrom}, not from ${expected}`);
    }
    if (loadedVersion !== version) {
      throw new Error(`The consumer loaded ${gemName} ${loadedVersion}, not ${version}`);
    }
    console.log(`The consumer loaded ${gemName} ${version} from the built archive`);

    if (url) await runTaskThroughConsumer(consume, url);
    else console.log("SKIPPED the consumer task: DATABASE_URL_TEST is unset");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await checkRubyRelease();
}
