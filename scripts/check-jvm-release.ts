/**
 * Stage, sign, and check the three JVM artifacts, then run clean consumers from the staged files.
 *
 * ADR 0103 publishes `workhorse`, `workhorse-kotlin`, and `workhorse-spring-boot-starter` to Maven
 * Central with the train version. Gradle writes them, signed, to `jvm/build/staging-deploy`. This
 * check then refuses the staging directory if one of these is true:
 *
 * 1. An artifact version differs from `jvm/gradle.properties`, or from the `--tag` version.
 * 2. The directory holds a module other than the three artifacts, for example `api-snapshot`.
 * 3. An artifact lacks its jar, `-sources.jar`, `-javadoc.jar`, POM, or Gradle module metadata, or
 *    one of those files lacks its `.asc`, `.md5`, or `.sha1` file.
 * 4. A checksum does not match, or a signature does not verify with the signing key.
 * 5. A `-javadoc.jar` has no `index.html`, so it holds no documentation.
 * 6. A POM lacks the metadata Central requires.
 * 7. The core or the starter does not mark each optional dependency as optional in its POM and as a
 *    feature variant in its module metadata. The core has the OpenTelemetry API and the Servlet
 *    API. The starter has each Spring module that a class-path condition guards, and it requires
 *    nothing beyond the core and Spring Boot's auto-configuration and JDBC modules.
 * 8. A jar manifest does not name its artifact as `Implementation-Title` and the train version as
 *    `Implementation-Version`.
 *
 * The signing key comes from one of two places. By default the check generates a throwaway key in
 * a temporary GnuPG home and discards it at the end. The throwaway key has the shape of the release
 * key: an ed25519 primary key that signs, with no subkey. That is the dry run of ADR 0103: it signs
 * with a key that no registry trusts and uploads nothing. With `--signing-key environment`, the
 * release stage passes the key and its passphrase from the `maven-central` environment secrets
 * `MAVEN_SIGNING_KEY` and `MAVEN_SIGNING_PASSWORD`. The check gives them only to Gradle, and it
 * refuses a key whose fingerprint is not `releaseKeyFingerprint`.
 *
 * In both cases the check verifies the signatures in a second temporary GnuPG home. It takes only
 * the public packets from the armored key and imports them there, so no secret key material goes
 * into a GnuPG home that verifies. The check stops the `gpg-agent` of each GnuPG home before it
 * deletes the home.
 *
 * Unless `--no-consumers` is set, the check then builds three consumers from `jvm/release-consumer`.
 * Each takes its artifact only from the staging directory. With a test database, each enqueues one
 * task into a scratch database and runs it, and the check reads that row back. In the same database
 * it runs `pnpm release:verify maven` against the staging directory, so a post-publish check that
 * the artifacts cannot satisfy fails before anything is published.
 *
 * No subprocess inherits the four `maven-central` secrets. Only the Gradle build that signs receives
 * the key and its passphrase, which this script sets for it.
 *
 * `--bundle <file>` writes the Central Portal bundle: the staging directory without
 * `maven-metadata.xml` files. `scripts/upload-maven-central.ts` uploads it.
 *
 * `--consumers-only` does not stage again. It checks the file list of the staging directory that
 * an earlier run wrote, and runs the consumers from it. The `maven-central` job runs it in a step
 * without the secrets, after the step that signs and writes the bundle. Thus the consumers test the
 * bytes that the job uploads.
 *
 * Usage: tsx scripts/with-env.ts tsx scripts/check-jvm-release.ts [--tag vX.Y.Z]
 *          [--signing-key throwaway|environment] [--bundle <file>]
 *          [--no-consumers | --consumers-only]
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { dropLocalDatabase } from "../typescript/core/src/drop-local-database.js";
import { consumerProperties, jdbcUrl, verifyRelease } from "./verify-release.js";

const root = path.resolve(import.meta.dirname, "..");
const jvmDirectory = path.join(root, "jvm");
const stagingDirectory = path.join(jvmDirectory, "build", "staging-deploy");
const consumerDirectory = path.join(jvmDirectory, "release-consumer");
/**
 * The fingerprint of the release key, an ed25519 primary key that signs, with no subkey. SM-1384
 * records it, and "Publication credentials" in `docs/compatibility.md` publishes it.
 */
export const releaseKeyFingerprint = "B933E2F16C3FA58E5414849A024210DB67A17773";
/** The Maven group of the three artifacts. */
export const group = "run.workhorse";
const groupPath = group.replaceAll(".", "/");
const consumerQueue = "release-consumer";
const consumerTaskType = "release.consumer";

/** The three artifacts of ADR 0103. Nothing else may publish. */
export const publishedArtifacts = [
  "workhorse",
  "workhorse-kotlin",
  "workhorse-spring-boot-starter",
] as const;
type Artifact = (typeof publishedArtifacts)[number];

/**
 * The optional dependencies of each artifact, by the feature variant that carries them. Each
 * starter feature serves one configuration of `WorkhorseAutoConfiguration` that a class-path
 * condition guards.
 */
const optionalFeatures: Readonly<
  Partial<Record<Artifact, Readonly<Record<string, readonly string[]>>>>
> = {
  workhorse: {
    opentelemetry: ["io.opentelemetry:opentelemetry-api"],
    servlet: ["jakarta.servlet:jakarta.servlet-api"],
  },
  "workhorse-spring-boot-starter": {
    // `JacksonCodecConfiguration`: `@ConditionalOnClass(JsonMapper.class)`.
    jackson: [
      "org.springframework.boot:spring-boot-jackson",
      "tools.jackson.core:jackson-databind",
    ],
    // `HealthConfiguration`: `@ConditionalOnClass({HealthIndicator.class, ...})`.
    health: ["org.springframework.boot:spring-boot-health"],
    // `DashboardConfiguration`: `@ConditionalOnClass({Filter.class, FilterRegistrationBean.class})`.
    servlet: ["org.springframework:spring-web", "jakarta.servlet:jakarta.servlet-api"],
    // `OpenTelemetryConfiguration`: `@ConditionalOnClass(OpenTelemetry.class)`.
    opentelemetry: ["io.opentelemetry:opentelemetry-api"],
  },
};

/** Every dependency the starter may require. Each other dependency must be optional. */
const starterRequirements: ReadonlySet<string> = new Set([
  `${group}:workhorse`,
  "org.springframework.boot:spring-boot-autoconfigure",
  "org.springframework.boot:spring-boot-jdbc",
]);

function optionalDependencies(artifact: Artifact): [feature: string, coordinates: string][] {
  return Object.entries(optionalFeatures[artifact] ?? {}).flatMap(([feature, modules]) =>
    modules.map((coordinates): [string, string] => [feature, coordinates]),
  );
}

/** The files each artifact publishes, after `<artifact>-<version>`. */
const artifactFiles = [".jar", "-sources.jar", "-javadoc.jar", ".pom", ".module"] as const;
/** The jars of each artifact, after `<artifact>-<version>`. Each one has a manifest. */
const jarFiles = [".jar", "-sources.jar", "-javadoc.jar"] as const;
/** The files Central requires beside each published file. */
const companionSuffixes = [".asc", ".md5", ".sha1"] as const;
/** Gradle writes these too. Central does not require them, and accepts them. */
const optionalSuffixes = [".sha256", ".sha512"] as const;

/** The consumer of each artifact, and the class whose jar it reports. */
const consumers: readonly { readonly name: string; readonly artifact: Artifact }[] = [
  { name: "java", artifact: "workhorse" },
  { name: "kotlin", artifact: "workhorse-kotlin" },
  { name: "spring-boot", artifact: "workhorse-spring-boot-starter" },
];

function run(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    capture?: boolean;
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
    /** Keep stderr out of the log, and report it only on failure. */
    quiet?: boolean;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? root,
      env: options.env ?? withoutPublicationSecrets(process.env),
      stdio: [
        options.input === undefined ? "ignore" : "pipe",
        options.capture ? "pipe" : "inherit",
        options.quiet ? "pipe" : "inherit",
      ],
    });
    let output = "";
    let errors = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
    child.stdin?.end(options.input);
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `${command} ${args[0] ?? ""} exited with ${signal ?? String(code)}${errors ? `\n${errors}` : ""}`,
            ),
          ),
    );
  });
}

/** The four secrets of the `maven-central` environment. */
const publicationSecrets = [
  "MAVEN_CENTRAL_USERNAME",
  "MAVEN_CENTRAL_PASSWORD",
  "MAVEN_SIGNING_KEY",
  "MAVEN_SIGNING_PASSWORD",
] as const;

/**
 * The environment without the publication secrets. Every subprocess starts from it, so only the
 * Gradle build that signs receives the key, and only through the variables this script sets.
 */
export function withoutPublicationSecrets(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !(publicationSecrets as readonly string[]).includes(key),
    ),
  );
}

/** The train version that every JVM artifact carries. */
export function jvmTrainVersion(gradleProperties: string): string {
  const version = /^version=(\S+)$/m.exec(gradleProperties)?.[1];
  if (!version) throw new Error("jvm/gradle.properties declares no version");
  return version;
}

/** The version a `vX.Y.Z` train tag names. */
export function tagVersion(tag: string): string {
  const match = /^v(\d+\.\d+\.\d+(?:-[-0-9A-Za-z.]+)?)$/.exec(tag);
  if (!match) throw new Error(`Expected a vX.Y.Z release tag, received ${tag}`);
  return match[1]!;
}

/** The problems with the staged file list, as paths relative to the staging directory. */
export function stagedFileProblems(files: readonly string[], version: string): string[] {
  const problems: string[] = [];
  const present = new Set(files);
  for (const file of files) {
    const [, artifact, rest] = new RegExp(`^${groupPath}/([^/]+)/(.+)$`).exec(file) ?? [];
    if (!artifact || !rest) {
      problems.push(`the staging directory holds ${file}, outside ${group}`);
    } else if (!(publishedArtifacts as readonly string[]).includes(artifact)) {
      problems.push(`the staging directory holds ${file}, but ${artifact} must never publish`);
    } else if (!rest.startsWith("maven-metadata.xml") && !rest.startsWith(`${version}/`)) {
      problems.push(`the staging directory holds ${file}, which is not version ${version}`);
    }
  }
  for (const artifact of publishedArtifacts) {
    for (const suffix of artifactFiles) {
      const file = `${groupPath}/${artifact}/${version}/${artifact}-${version}${suffix}`;
      if (!present.has(file)) {
        problems.push(`${artifact} ${version} has no ${artifact}-${version}${suffix}`);
        continue;
      }
      for (const companion of companionSuffixes) {
        if (!present.has(`${file}${companion}`)) {
          problems.push(`${artifact}-${version}${suffix} has no ${companion} file`);
        }
      }
    }
  }
  return problems;
}

/** The files that make up the Central Portal bundle. */
export function bundleFiles(files: readonly string[]): string[] {
  return files.filter((file) => !path.posix.basename(file).startsWith("maven-metadata.xml"));
}

/** The files that carry a signature, a checksum, or neither. */
function publishedFiles(files: readonly string[]): string[] {
  const suffixes = [...companionSuffixes, ...optionalSuffixes] as readonly string[];
  return bundleFiles(files).filter((file) => !suffixes.some((suffix) => file.endsWith(suffix)));
}

interface PomDependency {
  readonly coordinates: string;
  readonly version: string | undefined;
  readonly optional: boolean;
}

function element(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim();
}

function pomDependencies(pom: string): PomDependency[] {
  return [...pom.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].map(([, body = ""]) => ({
    coordinates: `${element(body, "groupId")}:${element(body, "artifactId")}`,
    version: element(body, "version"),
    optional: element(body, "optional") === "true",
  }));
}

/** The problems with one artifact's POM. */
export function pomProblems(artifact: Artifact, pom: string, version: string): string[] {
  const problems: string[] = [];
  // The project's own coordinates come before the first nested element that repeats them.
  const header = pom.split(/<(?:dependencies|dependencyManagement|parent)>/)[0] ?? "";
  const expected: Readonly<Record<string, string>> = {
    groupId: group,
    artifactId: artifact,
    version,
  };
  for (const [name, value] of Object.entries(expected)) {
    const declared = element(header, name);
    if (declared !== value)
      problems.push(`the ${artifact} POM has ${name} ${declared}, not ${value}`);
  }
  for (const name of ["name", "description", "url"]) {
    if (!element(header, name)) problems.push(`the ${artifact} POM has no ${name}`);
  }
  for (const [block, inner] of [
    ["licenses", "url"],
    ["developers", "name"],
    ["scm", "url"],
  ] as const) {
    const body = element(pom, block);
    if (!body || !element(body, inner)) {
      problems.push(`the ${artifact} POM has no ${block} with a ${inner}`);
    }
  }
  const dependencies = pomDependencies(pom);
  const optional = optionalDependencies(artifact).map(([, coordinates]) => coordinates);
  for (const coordinates of optional) {
    const dependency = dependencies.find((entry) => entry.coordinates === coordinates);
    if (!dependency?.optional) {
      problems.push(`the ${artifact} POM does not declare ${coordinates} as optional`);
    }
  }
  if (artifact === "workhorse-spring-boot-starter") {
    for (const dependency of dependencies) {
      const { coordinates } = dependency;
      if (
        !dependency.optional &&
        !optional.includes(coordinates) &&
        !starterRequirements.has(coordinates)
      ) {
        problems.push(`the ${artifact} POM requires ${coordinates}, which must be optional`);
      }
    }
  }
  if (artifact !== "workhorse") {
    const core = dependencies.find((entry) => entry.coordinates === `${group}:workhorse`);
    if (core?.version !== version) {
      problems.push(
        `the ${artifact} POM requires ${group}:workhorse ${core?.version}, not ${version}`,
      );
    }
  }
  for (const dependency of dependencies) {
    if (dependency.coordinates.startsWith(`${group}:`) && dependency.version !== version) {
      problems.push(`the ${artifact} POM requires ${dependency.coordinates} ${dependency.version}`);
    }
  }
  return problems;
}

/**
 * The main attributes of a jar manifest. A line that starts with a space continues the line before
 * it, because the JAR format wraps each line at 72 bytes. A blank line ends the main section.
 */
export function manifestAttributes(manifest: string): Map<string, string> {
  const lines: string[] = [];
  for (const line of manifest.split(/\r\n|\r|\n/)) {
    if (line === "") break;
    if (line.startsWith(" ") && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  const attributes = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(": ");
    if (separator > 0) attributes.set(line.slice(0, separator), line.slice(separator + 2));
  }
  return attributes;
}

/** The problems with the manifest of one of an artifact's jars. */
export function manifestProblems(
  artifact: Artifact,
  jar: string,
  manifest: string,
  version: string,
): string[] {
  const attributes = manifestAttributes(manifest);
  const problems: string[] = [];
  for (const [name, value] of [
    ["Implementation-Title", artifact],
    ["Implementation-Version", version],
  ] as const) {
    const declared = attributes.get(name);
    if (declared !== value) {
      problems.push(`the ${jar} manifest has ${name} ${declared}, not ${value}`);
    }
  }
  return problems;
}

/** Reads `META-INF/MANIFEST.MF` from a jar with the JDK's archiver. */
async function readManifest(jar: string, temporary: string): Promise<string> {
  const directory = await mkdtemp(path.join(temporary, "manifest-"));
  await run("jar", ["--extract", "--file", jar, "META-INF/MANIFEST.MF"], { cwd: directory });
  try {
    return await readFile(path.join(directory, "META-INF", "MANIFEST.MF"), "utf8");
  } catch {
    return "";
  }
}

/** The entries of a jar, read with the JDK's archiver. */
async function jarEntries(jar: string): Promise<string[]> {
  return (await run("jar", ["--list", "--file", jar], { capture: true }))
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * The problems with a `-javadoc.jar`. Javadoc and Dokka each write an `index.html` at the root, so
 * a jar without one holds no documentation, for example only its manifest.
 */
export function javadocProblems(jar: string, entries: readonly string[]): string[] {
  return entries.includes("index.html")
    ? []
    : [`${jar} has no index.html, so it holds no documentation`];
}

interface ModuleMetadata {
  readonly component?: {
    readonly group?: string;
    readonly module?: string;
    readonly version?: string;
  };
  readonly variants?: readonly {
    readonly name: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
    readonly capabilities?: readonly { group: string; name: string; version: string }[];
    readonly dependencies?: readonly { group: string; module: string }[];
  }[];
}

/** The Gradle attribute that tells an API variant from a runtime variant. */
const usage = "org.gradle.usage";

/** The problems with one artifact's Gradle module metadata. */
export function moduleProblems(artifact: Artifact, json: string, version: string): string[] {
  const metadata = JSON.parse(json) as ModuleMetadata;
  const problems: string[] = [];
  const component = metadata.component ?? {};
  if (component.group !== group || component.module !== artifact || component.version !== version) {
    problems.push(
      `the ${artifact} module metadata names ${component.group}:${component.module}:${component.version}`,
    );
  }
  const variants = metadata.variants ?? [];
  const depends = (variant: (typeof variants)[number], coordinates: string) =>
    (variant.dependencies ?? []).some((entry) => `${entry.group}:${entry.module}` === coordinates);
  const carriersOf = (feature: string) =>
    variants.filter((variant) =>
      (variant.capabilities ?? []).some(
        (entry) =>
          entry.group === group &&
          entry.name === `${artifact}-${feature}` &&
          entry.version === version,
      ),
    );
  // A caller that asks for a feature compiles with its API variant and runs with its runtime
  // variant, so each feature needs both.
  for (const feature of Object.keys(optionalFeatures[artifact] ?? {})) {
    const usages = new Set(carriersOf(feature).map((variant) => variant.attributes?.[usage]));
    for (const required of ["java-api", "java-runtime"]) {
      if (!usages.has(required)) {
        problems.push(
          `the ${artifact} module metadata has no ${required} variant of ${artifact}-${feature}`,
        );
      }
    }
  }
  for (const [feature, coordinates] of optionalDependencies(artifact)) {
    const capability = `${artifact}-${feature}`;
    const carriers = carriersOf(feature);
    if (carriers.length === 0 || !carriers.every((variant) => depends(variant, coordinates))) {
      problems.push(
        `the ${artifact} module metadata has no ${capability} variant with ${coordinates}`,
      );
    }
    for (const variant of variants) {
      if (!carriers.includes(variant) && depends(variant, coordinates)) {
        problems.push(
          `the ${artifact} ${variant.name} variant requires the optional ${coordinates}`,
        );
      }
    }
  }
  return problems;
}

/** A scratch name `pnpm db:sweep` recognizes: the source name, a tag, and a ten-digit digest. */
export function scratchDatabaseName(source: string, pid: number): string {
  const digest = createHash("sha256").update(`jvm-release:${pid}`).digest("hex");
  return `${source.slice(0, 44)}_gc_${digest.slice(0, 10)}`;
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(directory, relative) : Promise.resolve([relative]);
    }),
  );
  return nested.flat().toSorted();
}

interface SigningKey {
  readonly key: string;
  readonly password: string;
}

/** Stops the `gpg-agent` of a GnuPG home, if one runs. Call it before the home is deleted. */
export async function stopAgent(gnupgHome: string): Promise<void> {
  await run("gpgconf", ["--homedir", gnupgHome, "--kill", "all"], { capture: true, quiet: true });
}

/**
 * A throwaway OpenPGP key with the shape of the release key: an ed25519 primary key that signs,
 * with no subkey. GnuPG generates it in the new home `gnupgHome`, and the function stops the agent
 * of that home before it returns. Nothing outside this run ever sees the key.
 */
export async function throwawayKey(gnupgHome: string): Promise<SigningKey> {
  await mkdir(gnupgHome, { mode: 0o700 });
  const password = randomBytes(24).toString("hex");
  const gpg = [
    "--batch",
    "--homedir",
    gnupgHome,
    "--pinentry-mode",
    "loopback",
    "--passphrase-fd",
    "0",
  ];
  try {
    await run(
      "gpg",
      [
        ...gpg,
        "--quick-gen-key",
        "Workhorse release dry run <dry-run@invalid>",
        "ed25519",
        "sign",
        "1d",
      ],
      { input: password, capture: true, quiet: true },
    );
    const key = await run("gpg", [...gpg, "--armor", "--export-secret-keys"], {
      input: password,
      capture: true,
      quiet: true,
    });
    return { key, password };
  } finally {
    await stopAgent(gnupgHome);
  }
}

/** The release key from the environment. The check refuses a key with another fingerprint. */
function environmentKey(): SigningKey {
  const key = process.env.MAVEN_SIGNING_KEY;
  const password = process.env.MAVEN_SIGNING_PASSWORD;
  if (!key || password === undefined) {
    throw new Error("--signing-key environment needs MAVEN_SIGNING_KEY and MAVEN_SIGNING_PASSWORD");
  }
  return { key, password };
}

/** An OpenPGP packet: its tag and its body (RFC 9580, section 4). */
interface Packet {
  readonly tag: number;
  readonly body: Buffer;
}

/** The binary packets of an ASCII-armored OpenPGP block (RFC 9580, section 6). */
function dearmor(text: string): Buffer {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const begin = lines.findIndex((line) => /^-----BEGIN PGP [A-Z ]+-----$/.test(line));
  const end = lines.findIndex((line, index) => index > begin && line.startsWith("-----END PGP "));
  if (begin < 0 || end < 0) throw new Error("The signing key is not an ASCII-armored OpenPGP key");
  // Armor headers end at the first blank line. The checksum line starts with `=`.
  const body = lines.slice(begin + 1, end);
  const data = body.slice(body.indexOf("") + 1).filter((line) => line && !line.startsWith("="));
  return Buffer.from(data.join(""), "base64");
}

/** The packets of an OpenPGP key, from its armored text or its binary form. */
export function keyPackets(key: string | Buffer): Packet[] {
  const data = typeof key === "string" ? dearmor(key) : key;
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < data.length) {
    const header = data[offset]!;
    if ((header & 0x80) === 0) throw new Error("The signing key holds a malformed packet header");
    let tag: number;
    let length: number;
    if (header & 0x40) {
      // The current packet format. A key never uses a partial body length.
      tag = header & 0x3f;
      const first = data[offset + 1]!;
      if (first < 192) {
        length = first;
        offset += 2;
      } else if (first < 224) {
        length = ((first - 192) << 8) + data[offset + 2]! + 192;
        offset += 3;
      } else if (first === 255) {
        length = data.readUInt32BE(offset + 2);
        offset += 6;
      } else {
        throw new Error("The signing key holds a packet with a partial body length");
      }
    } else {
      // The legacy packet format, which GnuPG writes for keys.
      tag = (header >> 2) & 0x0f;
      const size = [1, 2, 4][header & 0x03];
      if (size === undefined) throw new Error("The signing key holds a packet of unknown length");
      length = data.readUIntBE(offset + 1, size);
      offset += 1 + size;
    }
    if (offset + length > data.length) throw new Error("The signing key is truncated");
    packets.push({ tag, body: data.subarray(offset, offset + length) });
    offset += length;
  }
  return packets;
}

/**
 * The length of the public part of a version 4 key packet body: the version, the creation time,
 * the algorithm, and the public key fields of that algorithm (RFC 9580, sections 5.5.2 and 5.6).
 */
function publicKeyLength(body: Buffer): number {
  if (body[0] !== 4) throw new Error(`The signing key is a version ${String(body[0])} key, not 4`);
  let offset = 6;
  const mpi = () => (offset += 2 + Math.ceil(body.readUInt16BE(offset) / 8));
  const field = () => (offset += 1 + body[offset]!);
  switch (body[5]) {
    case 1: // RSA
    case 2:
    case 3:
      mpi();
      mpi();
      break;
    case 16: // Elgamal
      mpi();
      mpi();
      mpi();
      break;
    case 17: // DSA
      mpi();
      mpi();
      mpi();
      mpi();
      break;
    case 19: // ECDSA
    case 22: // EdDSA, which ed25519 keys use in version 4
      field();
      mpi();
      break;
    case 18: // ECDH: the curve, the point, and the KDF parameters
      field();
      mpi();
      field();
      break;
    case 25: // X25519
    case 27: // Ed25519
      offset += 32;
      break;
    case 26: // X448
      offset += 56;
      break;
    case 28: // Ed448
      offset += 57;
      break;
    default:
      throw new Error(`The signing key uses the unknown public key algorithm ${String(body[5])}`);
  }
  if (offset > body.length) throw new Error("The signing key holds a truncated key packet");
  return offset;
}

/** Serializes one packet in the current packet format with a four-octet length. */
function packet(tag: number, body: Buffer): Buffer {
  const header = Buffer.alloc(6);
  header[0] = 0xc0 | tag;
  header[1] = 0xff;
  header.writeUInt32BE(body.length, 2);
  return Buffer.concat([header, body]);
}

/**
 * The public key of an armored secret key, as binary packets. A secret key packet (tag 5) becomes
 * a public key packet (tag 6), and a secret subkey packet (tag 7) becomes a public subkey packet
 * (tag 14). Each keeps only its public fields. The user IDs and the signatures stay as they are.
 * No GnuPG home sees the secret fields.
 */
export function publicKeyPackets(armoredKey: string): Buffer {
  const publicTags: Readonly<Record<number, number>> = { 5: 6, 7: 14 };
  return Buffer.concat(
    keyPackets(armoredKey).map(({ tag, body }) => {
      const publicTag = publicTags[tag];
      return publicTag === undefined
        ? packet(tag, body)
        : packet(publicTag, body.subarray(0, publicKeyLength(body)));
    }),
  );
}

/**
 * Imports only the public part of `armoredKey` into `gnupgHome`, and returns the fingerprint of its
 * primary key. If `expectedFingerprint` is set, the function refuses a key with another
 * fingerprint. The caller stops the agent of the home with `stopAgent`.
 */
export async function importPublicKey(
  gnupgHome: string,
  armoredKey: string,
  expectedFingerprint?: string,
): Promise<string> {
  const gpg = ["--batch", "--homedir", gnupgHome];
  await run("gpg", [...gpg, "--import"], {
    input: publicKeyPackets(armoredKey),
    capture: true,
    quiet: true,
  });
  // In the colon listing, the first `fpr` record after each `pub` record is its fingerprint.
  const listing = await run("gpg", [...gpg, "--with-colons", "--fingerprint", "--list-keys"], {
    capture: true,
    quiet: true,
  });
  const fingerprints: string[] = [];
  let primary = false;
  for (const fields of listing.split("\n").map((line) => line.split(":"))) {
    if (fields[0] === "pub") primary = true;
    else if (fields[0] === "sub") primary = false;
    else if (fields[0] === "fpr" && primary) {
      fingerprints.push(fields[9] ?? "");
      primary = false;
    }
  }
  if (fingerprints.length !== 1) {
    throw new Error(`The signing key holds ${String(fingerprints.length)} primary keys, not 1`);
  }
  const fingerprint = fingerprints[0]!;
  if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) {
    throw new Error(
      `The signing key has the fingerprint ${fingerprint}, not the release key ${expectedFingerprint}`,
    );
  }
  return fingerprint;
}

async function verifyStagedFiles(files: readonly string[], gnupgHome: string): Promise<string[]> {
  const problems: string[] = [];
  for (const file of publishedFiles(files)) {
    const bytes = await readFile(path.join(stagingDirectory, file));
    for (const algorithm of ["md5", "sha1"] as const) {
      const declared = (await readFile(path.join(stagingDirectory, `${file}.${algorithm}`), "utf8"))
        .trim()
        .split(/\s+/)[0];
      if (declared !== createHash(algorithm).update(bytes).digest("hex")) {
        problems.push(`${file}.${algorithm} does not match ${file}`);
      }
    }
    try {
      await run(
        "gpg",
        [
          "--batch",
          "--homedir",
          gnupgHome,
          "--verify",
          path.join(stagingDirectory, `${file}.asc`),
          path.join(stagingDirectory, file),
        ],
        { capture: true, quiet: true },
      );
    } catch {
      problems.push(`${file}.asc does not verify with the signing key`);
    }
  }
  return problems;
}

function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL_TEST_PACKED;
  if (url) return url;
  if (process.env.CI || process.env.WORKHORSE_REQUIRE_DATABASE === "1") {
    throw new Error("The JVM release check needs DATABASE_URL_TEST or DATABASE_URL_TEST_PACKED");
  }
  return undefined;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Each consumer, run from the staging directory with the pinned Gradle and JDK. */
function consumerRunner(
  directory: string,
  properties: readonly string[],
): (args: readonly string[]) => Promise<string> {
  // `-p` with the checkout as the working directory, so the pinned Gradle and JDK run it.
  return (args) =>
    run(
      "gradle",
      [
        "-p",
        directory,
        "--quiet",
        "run",
        ...properties,
        ...(args.length ? [`--args=${args.join(" ")}`] : []),
      ],
      { capture: true },
    );
}

/** Creates a scratch database with the current schema, and drops it after `use` ends. */
async function withScratchDatabase(
  sourceUrl: string,
  use: (scratchUrl: string, database: Client) => Promise<void>,
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
        await use(scratchUrl, database);
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

/** Reads back the task a consumer reports, and refuses it unless its handler echoed the payload. */
async function requireConsumerTask(database: Client, name: string, taskId: string): Promise<void> {
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
    throw new Error(`The ${name} consumer reported task ${taskId}, but no matching row exists`);
  }
  if (row.state !== "succeeded" || row.packaged !== true) {
    throw new Error(`The ${name} consumer left task ${taskId} in state ${row.state}`);
  }
}

/**
 * Runs each consumer from the staging directory. With a test database, each runs one task in a
 * scratch database, and `pnpm release:verify maven` rehearses the cold install in the same database.
 */
async function runConsumers(version: string, temporary: string): Promise<void> {
  const url = databaseUrl();
  const properties = [
    ...(await consumerProperties(version)),
    `-PworkhorseRepository=${stagingDirectory}`,
  ];
  const runners = await Promise.all(
    consumers.map(async (consumer) => {
      const directory = path.join(temporary, "consumers", consumer.name);
      await cp(path.join(consumerDirectory, consumer.name), directory, { recursive: true });
      return {
        name: consumer.name,
        artifact: consumer.artifact,
        consume: consumerRunner(directory, properties),
      };
    }),
  );

  if (!url) {
    for (const consumer of runners) {
      const expectedJar = `${consumer.artifact}-${version}.jar`;
      const loaded = (await consumer.consume([])).trim();
      if (loaded !== expectedJar) {
        throw new Error(`The ${consumer.name} consumer loaded ${loaded}, not ${expectedJar}`);
      }
    }
    console.log("SKIPPED the consumer tasks and release:verify maven: DATABASE_URL_TEST is unset");
    return;
  }

  await withScratchDatabase(url, async (scratchUrl, database) => {
    for (const consumer of runners) {
      const expectedJar = `${consumer.artifact}-${version}.jar`;
      const lines = (await consumer.consume([jdbcUrl(scratchUrl)])).trim().split("\n");
      const loaded = lines[0]?.trim();
      if (loaded !== expectedJar) {
        throw new Error(`The ${consumer.name} consumer loaded ${loaded}, not ${expectedJar}`);
      }
      const taskId = lines.at(-1)?.trim() ?? "";
      await requireConsumerTask(database, consumer.name, taskId);
      console.log(`The ${consumer.name} consumer loaded ${expectedJar} and ran task ${taskId}`);
    }
    await verifyRelease(
      "maven",
      version,
      { mavenRepo: stagingDirectory },
      { ...withoutPublicationSecrets(process.env), WORKHORSE_VERIFY_DATABASE_URL: scratchUrl },
    );
  });
}

async function writeBundle(
  files: readonly string[],
  bundle: string,
  temporary: string,
): Promise<void> {
  const contents = path.join(temporary, "bundle");
  for (const file of bundleFiles(files)) {
    await mkdir(path.dirname(path.join(contents, file)), { recursive: true });
    await cp(path.join(stagingDirectory, file), path.join(contents, file));
  }
  const target = path.resolve(bundle);
  await rm(target, { force: true });
  // The JDK's archiver, without a manifest, writes a plain zip with the repository layout.
  await run("jar", [
    "--create",
    "--no-manifest",
    "--file",
    target,
    "-C",
    contents,
    groupPath.split("/")[0]!,
  ]);
  console.log(`Wrote the Central Portal bundle ${target}`);
}

export async function checkJvmRelease(options: {
  readonly tag?: string;
  readonly signingKey: "throwaway" | "environment";
  readonly bundle?: string;
  /** `run` stages and checks, then runs the consumers. `skip` and `only` change that. */
  readonly consumers: "run" | "skip" | "only";
}): Promise<void> {
  const version = jvmTrainVersion(
    await readFile(path.join(jvmDirectory, "gradle.properties"), "utf8"),
  );
  if (options.tag !== undefined && tagVersion(options.tag) !== version) {
    throw new Error(
      `jvm/gradle.properties is ${version} but the tag is ${tagVersion(options.tag)}`,
    );
  }

  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "workhorse-jvm-release-")));
  // The home that verifies the signatures. It receives only the public key.
  const gnupgHome = path.join(temporary, "gnupg");
  try {
    if (options.consumers === "only") {
      const problems = stagedFileProblems(await listFiles(stagingDirectory), version);
      if (problems.length > 0) throw new Error(problems.join("\n"));
      await runConsumers(version, temporary);
      return;
    }

    const signing =
      options.signingKey === "environment"
        ? environmentKey()
        : await throwawayKey(path.join(temporary, "gnupg-throwaway"));
    await mkdir(gnupgHome, { mode: 0o700 });
    await importPublicKey(
      gnupgHome,
      signing.key,
      options.signingKey === "environment" ? releaseKeyFingerprint : undefined,
    );

    // Only this process receives the key. The ambient environment stays as it was.
    await run("gradle", ["-p", "jvm", "cleanStaging", "stageRelease"], {
      env: {
        ...withoutPublicationSecrets(process.env),
        MAVEN_SIGNING_KEY: signing.key,
        MAVEN_SIGNING_PASSWORD: signing.password,
      },
    });

    const files = await listFiles(stagingDirectory);
    const problems = stagedFileProblems(files, version);
    if (problems.length === 0) {
      for (const artifact of publishedArtifacts) {
        const base = path.join(
          stagingDirectory,
          groupPath,
          artifact,
          version,
          `${artifact}-${version}`,
        );
        problems.push(...pomProblems(artifact, await readFile(`${base}.pom`, "utf8"), version));
        problems.push(
          ...moduleProblems(artifact, await readFile(`${base}.module`, "utf8"), version),
        );
        for (const suffix of jarFiles) {
          const jar = `${artifact}-${version}${suffix}`;
          const manifest = await readManifest(`${base}${suffix}`, temporary);
          problems.push(...manifestProblems(artifact, jar, manifest, version));
        }
        const javadoc = `${artifact}-${version}-javadoc.jar`;
        problems.push(...javadocProblems(javadoc, await jarEntries(`${base}-javadoc.jar`)));
      }
      problems.push(...(await verifyStagedFiles(files, gnupgHome)));
    }
    if (problems.length > 0) throw new Error(problems.join("\n"));
    console.log(
      `Staged and verified ${publishedArtifacts.join(", ")} ${version} (${files.length} files, signed)`,
    );

    if (options.bundle !== undefined) await writeBundle(files, options.bundle, temporary);
    if (options.consumers === "run") {
      await runConsumers(version, temporary);
    }
  } finally {
    try {
      await stopAgent(gnupgHome);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      "signing-key": { type: "string", default: "throwaway" },
      bundle: { type: "string" },
      "no-consumers": { type: "boolean", default: false },
      "consumers-only": { type: "boolean", default: false },
    },
  });
  const signingKey = values["signing-key"];
  if (signingKey !== "throwaway" && signingKey !== "environment") {
    process.stderr.write("--signing-key must be throwaway or environment\n");
    process.exitCode = 64;
  } else if (
    values["consumers-only"] &&
    (values["no-consumers"] || values.bundle !== undefined || signingKey !== "throwaway")
  ) {
    process.stderr.write(
      "--consumers-only stages nothing, so it takes no --no-consumers, --bundle, or --signing-key\n",
    );
    process.exitCode = 64;
  } else {
    await checkJvmRelease({
      tag: values.tag,
      signingKey,
      bundle: values.bundle,
      consumers: values["consumers-only"] ? "only" : values["no-consumers"] ? "skip" : "run",
    });
  }
}
