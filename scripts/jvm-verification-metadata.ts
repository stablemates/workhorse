/**
 * Write or check `jvm/gradle/verification-metadata.xml`, the Gradle dependency verification of the
 * JVM build (SM-1489), and the files of the three release consumers (SM-1533).
 *
 * The release stage signs the JVM artifacts in a Gradle build that holds the signing key. Every
 * plugin and every library that loads into that build can read the key. Gradle therefore refuses
 * each artifact whose sha256 checksum is not in the metadata file or differs from it. That applies
 * to the plugin class path and to every configuration of every task, so a dependency update fails
 * each JVM build until the file is written again.
 *
 * The file has sha256 entries only. With pgp, Gradle writes a trusted key for a whole group, and
 * then accepts every version of that group with no checksum. A dependency update could then pass
 * with no change to the file.
 *
 * The script always writes the file from nothing, with verification off for those runs. The runs
 * use a scratch Gradle user home that starts empty. With a warm cache, Gradle does not record each
 * metadata file that a clean cache downloads, for example a `.module` file of a BOM on the plugin
 * class path, and a CI run with a clean cache then fails.
 *
 * 1. The first run resolves every resolvable configuration of each project through
 *    `scripts/jvm-verification-metadata/resolve.init.gradle.kts`. It also runs the tasks that
 *    resolve detached configurations: `assemble`, `spotlessCheck`, `lint -Pworkhorse.lint`, and the
 *    two `:api-snapshot` tasks.
 * 2. The second run resolves every configuration again with `-Pworkhorse.springBoot=4.1`, the
 *    versions of the Spring Boot 4.1 CI lane.
 *
 * The snapshot lane (`-Pworkhorse.springBoot=snapshot`) is not in the file. A snapshot changes
 * without notice, so the starter and the Kotlin module turn verification off only for their two
 * test class paths in that lane.
 *
 * `--check` writes the file in the same way, compares it with the committed file, and restores the
 * committed file. It fails if the two differ, so an entry that nothing resolves also fails it.
 *
 * The script also writes `jvm/release-consumer/<consumer>/gradle/verification-metadata.xml` for the
 * Java, Kotlin, and Spring Boot release consumers (SM-1533). `pnpm jvm:package-check` and
 * `pnpm release:verify maven` copy each consumer with that file and run it. A consumer takes the
 * `run.workhorse` artifacts from a staging directory or from Maven Central. Those artifacts change on
 * each build, so the file of a consumer trusts that group with no checksum, and it has a sha256
 * checksum for every other plugin and library.
 *
 * 1. A run publishes the three artifacts to a scratch Maven repository through
 *    `scripts/jvm-dependency-scan/publish.init.gradle.kts`, with the verification of the JVM build
 *    on. These artifacts declare the dependencies that each consumer resolves.
 * 2. For each consumer, a run in a scratch copy starts from a file that has only the trust of
 *    `run.workhorse`. It resolves every resolvable configuration and runs `assemble` against that
 *    repository, with the versions that `pnpm jvm:package-check` gives the consumer. The consumers
 *    run one at a time, each with a scratch Gradle user home that starts empty.
 *
 * The consumer of the dependency scan, `scripts/jvm-dependency-scan`, has no verification metadata.
 * `pnpm jvm:vuln` reads the class paths that a caller resolves from Maven Central, and a caller has
 * no checksum list. The scan must resolve as that caller does. It reads module coordinates and asks
 * the OSV database about them, and it runs no code from the modules it resolves.
 *
 * Usage: tsx scripts/with-env.ts tsx scripts/jvm-verification-metadata.ts [--check]
 */
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  jvmTrainVersion,
  publishedArtifacts,
  withoutPublicationSecrets,
} from "./check-jvm-release.js";
import { consumerProperties } from "./verify-release.js";

const root = path.resolve(import.meta.dirname, "..");
const jvmDirectory = path.join(root, "jvm");
const metadataFile = path.join(jvmDirectory, "gradle", "verification-metadata.xml");
const consumerDirectory = path.join(jvmDirectory, "release-consumer");
const publishInitScript = path.join(
  root,
  "scripts",
  "jvm-dependency-scan",
  "publish.init.gradle.kts",
);
const initScript = path.join(
  root,
  "scripts",
  "jvm-verification-metadata",
  "resolve.init.gradle.kts",
);

/** The Gradle builds under `jvm/release-consumer/` that get verification metadata. */
export const releaseConsumers = ["java", "kotlin", "spring-boot"] as const;

/** The Gradle runs that write the file, in order. */
const passes: readonly (readonly string[])[] = [
  [
    "resolveAllConfigurations",
    "assemble",
    "spotlessCheck",
    "lint",
    ":api-snapshot:javaApi",
    ":api-snapshot:kotlinApi",
    "-Pworkhorse.lint",
  ],
  ["resolveAllConfigurations", "-Pworkhorse.springBoot=4.1"],
];

/** The comment that opens the committed file. An XML comment cannot hold two hyphens in a row. */
const header = `<!--
  Gradle dependency verification of the JVM build (SM-1489). Gradle refuses each plugin and each
  library whose sha256 checksum is not in this file or differs from it.

  Do not edit this file. After a change to a Gradle dependency or plugin, write it again with
  "pnpm jvm:verification-metadata", and read the changed entries before you commit them.
  CI runs "pnpm jvm:verification-metadata:check" and fails if this file is not current.

  The file has no pgp entries. Gradle writes a pgp trusted key for a whole group, and then
  accepts every version of that group with no checksum. scripts/jvm-verification-metadata.ts
  states the full procedure.
-->
`;

/** The comment that opens the committed file of each release consumer. */
const consumerHeader = `<!--
  Gradle dependency verification of this release consumer (SM-1533). Gradle refuses each plugin
  and each library outside the run.workhorse group whose sha256 checksum is not in this file or
  differs from it. The run.workhorse artifacts come from a staging directory or from Maven Central
  and change on each build, so this file trusts that group with no checksum.

  Do not edit this file. After a change to a Gradle dependency or plugin, write it again with
  "pnpm jvm:verification-metadata", and read the changed entries before you commit them.
  CI runs "pnpm jvm:verification-metadata:check" and fails if this file is not current.
  scripts/jvm-verification-metadata.ts states the full procedure.
-->
`;

/**
 * The file that each consumer run starts from. Gradle keeps its configuration and writes no
 * checksum for a trusted group.
 */
const consumerSeed = `<?xml version="1.0" encoding="UTF-8"?>
<verification-metadata xmlns="https://schema.gradle.org/dependency-verification" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="https://schema.gradle.org/dependency-verification https://schema.gradle.org/dependency-verification/dependency-verification-1.4.xsd">
   <configuration>
      <verify-metadata>true</verify-metadata>
      <verify-signatures>false</verify-signatures>
      <trusted-artifacts>
         <trust group="run.workhorse"/>
      </trusted-artifacts>
   </configuration>
</verification-metadata>
`;

/** Puts the header after the XML declaration of the file that Gradle wrote. */
export function withHeader(generated: string, text: string = header): string {
  const declaration = /^<\?xml[^>]*\?>\n/.exec(generated);
  if (!declaration) throw new Error("The verification metadata has no XML declaration");
  return `${declaration[0]}${text}${generated.slice(declaration[0].length)}`;
}

function components(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("<component ")),
  );
}

/** The `<component>` lines that only one of the two files has, for the failure message. */
export function componentDifference(
  committed: string,
  current: string,
): { readonly missing: readonly string[]; readonly stale: readonly string[] } {
  const before = components(committed);
  const after = components(current);
  return {
    missing: [...after].filter((line) => !before.has(line)),
    stale: [...before].filter((line) => !after.has(line)),
  };
}

/**
 * Runs Gradle on `directory` from the checkout, so that the mise shims select the pinned Gradle and
 * JDK. Without `userHome`, Gradle uses the default user home and verifies as usual. A run with a
 * scratch user home uses no daemon, because the script deletes that home, and a daemon in it could
 * not run a build again. It would only hold memory until its idle timeout.
 */
function gradle(directory: string, args: readonly string[], userHome?: string): Promise<void> {
  const write =
    userHome === undefined
      ? []
      : ["--no-daemon", "--write-verification-metadata", "sha256", "--init-script", initScript];
  const environment = withoutPublicationSecrets(process.env);
  return new Promise((resolve, reject) => {
    const child = spawn("gradle", ["-p", directory, "--quiet", ...write, ...args], {
      cwd: root,
      env: userHome === undefined ? environment : { ...environment, GRADLE_USER_HOME: userHome },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`gradle ${args.join(" ")} exited with ${signal ?? String(code)}`)),
    );
  });
}

/** Writes the file of the JVM build from nothing and returns its text. */
async function generate(): Promise<string> {
  await rm(metadataFile, { force: true });
  const userHome = await mkdtemp(path.join(tmpdir(), "workhorse-gradle-home-"));
  try {
    for (const pass of passes) await gradle("jvm", pass, userHome);
  } finally {
    await rm(userHome, { recursive: true, force: true });
  }
  return withHeader(await readFile(metadataFile, "utf8"));
}

/** The committed file of a release consumer. */
function consumerMetadataFile(consumer: string): string {
  return path.join(consumerDirectory, consumer, "gradle", "verification-metadata.xml");
}

/**
 * Writes the file of each release consumer from nothing in a scratch copy, and returns the text of
 * each file, keyed by its path. The committed files do not change.
 */
async function generateConsumers(): Promise<ReadonlyMap<string, string>> {
  const work = await mkdtemp(path.join(tmpdir(), "workhorse-consumer-metadata-"));
  try {
    const repository = path.join(work, "repository");
    await gradle("jvm", [
      "--init-script",
      publishInitScript,
      `-Pworkhorse.scanRepository=${repository}`,
      ...publishedArtifacts.map(
        (artifact) => `:${artifact}:publishAllPublicationsToDependencyScanRepository`,
      ),
    ]);
    const version = jvmTrainVersion(
      await readFile(path.join(jvmDirectory, "gradle.properties"), "utf8"),
    );
    const properties = [
      ...(await consumerProperties(version)),
      `-PworkhorseRepository=${repository}`,
    ];
    // One consumer at a time. Each run downloads its whole graph into an empty user home, so
    // parallel runs would add up their memory and disk use.
    const generated = new Map<string, string>();
    for (const consumer of releaseConsumers) {
      const directory = path.join(work, "consumers", consumer);
      const seed = path.join(directory, "gradle", "verification-metadata.xml");
      await cp(path.join(consumerDirectory, consumer), directory, {
        recursive: true,
        filter: (source) => !source.endsWith("verification-metadata.xml"),
      });
      await mkdir(path.dirname(seed), { recursive: true });
      await writeFile(seed, consumerSeed);
      const userHome = path.join(work, "home");
      await mkdir(userHome, { recursive: true });
      try {
        await gradle(directory, ["resolveAllConfigurations", "assemble", ...properties], userHome);
      } finally {
        await rm(userHome, { recursive: true, force: true });
      }
      generated.set(
        consumerMetadataFile(consumer),
        withHeader(await readFile(seed, "utf8"), consumerHeader),
      );
    }
    return generated;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The failure message for a committed file that differs from the file the script writes. */
function notCurrent(file: string, committed: string, current: string): string {
  const { missing, stale } = componentDifference(committed, current);
  return [
    `${path.relative(root, file)} is not current. Run \`pnpm jvm:verification-metadata\`, read the changed entries, and commit the file.`,
    ...missing.map((line) => `  missing: ${line}`),
    ...stale.map((line) => `  stale: ${line}`),
    ...(missing.length + stale.length === 0
      ? ["  A checksum or an artifact of a component differs."]
      : []),
  ].join("\n");
}

async function main(check: boolean): Promise<void> {
  if (!check) {
    await writeFile(metadataFile, await generate());
    console.log(`Wrote ${path.relative(root, metadataFile)}`);
    // The consumer runs publish the artifacts with the file that the line above wrote.
    for (const [file, text] of await generateConsumers()) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
      console.log(`Wrote ${path.relative(root, file)}`);
    }
    return;
  }
  const committed = await readFile(metadataFile, "utf8").catch(() => "");
  let current: string;
  try {
    current = await generate();
  } finally {
    await writeFile(metadataFile, committed);
  }
  // The consumer runs publish the artifacts with the committed file, so it must be current first.
  if (current !== committed) throw new Error(notCurrent(metadataFile, committed, current));
  console.log(`${path.relative(root, metadataFile)} is current`);

  const failures: string[] = [];
  for (const [file, text] of await generateConsumers()) {
    const consumerCommitted = await readFile(file, "utf8").catch(() => "");
    if (text === consumerCommitted) console.log(`${path.relative(root, file)} is current`);
    else failures.push(notCurrent(file, consumerCommitted, text));
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
  await main(values.check);
}
