import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { corePackage, publishedPackages, repositoryRoot } from "./packages.js";

/**
 * Post-publish version checks for each registry on the release train.
 *
 * Every step is an exact command and the output it must print. The release handoff names
 * `pnpm release:verify <target> <version>` instead of restating commands. Each release check also
 * runs its target against the artifact it is about to publish: the dry-run wheel, the packed npm
 * tarballs, the unpacked `.crate` archive, or a module proxy staged from the commit to tag. A check
 * the artifact cannot satisfy therefore fails before any tag. The PyPI check also requires a PEP 740
 * attestation from this repository's release workflow on every published file; the dry run proves
 * the same upload path with `scripts/check-attestation-upload.ts`. The Maven target builds the Java
 * and Kotlin consumers of `jvm/release-consumer`, the cold install of ADR 0103, against Maven
 * Central or against the staging directory that `scripts/check-jvm-release.ts` writes. The npm, crates.io, and Go
 * provenance review and the enqueue-and-worker smoke stay with the maintainer;
 * `docs/compatibility.md` → Release train lists them.
 */

type VerifyTarget = "crate" | "go" | "maven" | "npm" | "python";

export interface VerificationStep {
  /** Program, resolved from PATH unless it names a path inside the scratch directory. */
  readonly command: string;
  readonly args: readonly string[];
  /** Extra environment for this step only. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Trimmed stdout the step must print. Absent means only the exit status counts. */
  readonly expect?: string;
  /** A pattern the trimmed stdout must match, for output that names a new task id. */
  readonly expectPattern?: RegExp;
}

/**
 * A local artifact that stands in for the registry release, so a rehearsal runs before publishing.
 * Each option applies to one target; checks that only a registry can answer are skipped.
 */
export interface VerificationOptions {
  /** python: a wheel to install instead of the PyPI release. */
  readonly wheel?: string;
  /** npm: the directory holding every packed tarball, installed instead of the npm release. */
  readonly tarballs?: string;
  /** crate: the unpacked `.crate` archive, depended on by path instead of the crates.io release. */
  readonly crate?: string;
  /** go: a module proxy directory served ahead of proxy.golang.org. */
  readonly goProxy?: string;
  /** maven: a staged Maven repository that serves `run.workhorse` instead of Maven Central. */
  readonly mavenRepo?: string;
}

type ArtifactOption = keyof VerificationOptions;

const artifactOptions: Readonly<Record<VerifyTarget, ArtifactOption>> = {
  crate: "crate",
  go: "goProxy",
  maven: "mavenRepo",
  npm: "tarballs",
  python: "wheel",
};

/** The command-line flag for each option. */
const artifactFlags: Readonly<Record<ArtifactOption, string>> = {
  crate: "--crate",
  goProxy: "--go-proxy",
  mavenRepo: "--maven-repo",
  tarballs: "--tarballs",
  wheel: "--wheel",
};

const pythonDistribution = "stablemates-workhorse";
// The Trusted Publisher every attestation must name. A file without one reached PyPI some other way.
const pythonPublisher = { repository: "stablemates/workhorse", workflow: "release-python.yml" };
const goModule = "github.com/stablemates/workhorse/go";
// The public proxy only, with no `direct` fallback, so a version the proxy cannot serve fails.
const goEnvironment = { GOFLAGS: "-mod=mod", GOPROXY: "https://proxy.golang.org", GOWORK: "off" };

// The oldest supported Python, so the check also proves the floor `requires-python` declares.
async function pythonFloor(): Promise<string> {
  const support = JSON.parse(await readFile(path.join(repositoryRoot, "support.json"), "utf8")) as {
    readonly support: { readonly python: { readonly minimum: string } };
  };
  return support.support.python.minimum;
}

async function pythonSteps(
  version: string,
  options: VerificationOptions,
): Promise<VerificationStep[]> {
  const python = "venv/bin/python";
  return [
    { command: "uv", args: ["venv", "--python", await pythonFloor(), "venv"] },
    {
      command: "uv",
      args: [
        "pip",
        "install",
        "--python",
        python,
        "--refresh",
        options.wheel ?? `${pythonDistribution}==${version}`,
      ],
    },
    {
      command: python,
      args: ["-c", "import workhorse; print(workhorse.__version__)"],
      expect: version,
    },
    {
      command: python,
      args: [
        "-c",
        `import importlib.metadata; print(importlib.metadata.version("${pythonDistribution}"))`,
      ],
      expect: version,
    },
  ];
}

async function npmSteps(
  version: string,
  options: VerificationOptions,
): Promise<VerificationStep[]> {
  const packages = await publishedPackages();
  if (options.tarballs !== undefined) {
    const tarballs = options.tarballs;
    // The registry cannot answer `npm view` or `npm audit signatures` before publishing. The
    // rehearsal installs every tarball instead and reads each installed manifest's version.
    // Peers stay uninstalled: they are the consumer's choice, and `npm:test:packed` covers them.
    return [
      { command: "npm", args: ["init", "--yes"] },
      {
        command: "npm",
        args: [
          "install",
          "--legacy-peer-deps",
          ...packages.map((entry) => path.join(tarballs, entry.tarball)),
        ],
      },
      ...packages.map((entry) => ({
        command: "node",
        args: [
          "-p",
          `JSON.parse(require("fs").readFileSync("node_modules/${entry.name}/package.json", "utf8")).version`,
        ],
        expect: version,
      })),
      { command: "npx", args: ["--no-install", "workhorse", "--version"], expect: version },
    ];
  }
  return [
    ...packages.map((entry) => ({
      command: "npm",
      args: ["view", `${entry.name}@${version}`, "version"],
      expect: version,
    })),
    { command: "npm", args: ["init", "--yes"] },
    { command: "npm", args: ["install", `${(await corePackage()).name}@${version}`] },
    { command: "npm", args: ["audit", "signatures"] },
    { command: "npx", args: ["--no-install", "workhorse", "--version"], expect: version },
  ];
}

function crateSteps(version: string, options: VerificationOptions): VerificationStep[] {
  if (options.crate !== undefined) {
    // `cargo add` cannot resolve an unpublished version from crates.io, and it ignores
    // `[patch]`. A path dependency still records the archive's own version in the lockfile.
    return [
      { command: "cargo", args: ["init", "--name", "release_verify", "--vcs", "none"] },
      { command: "cargo", args: ["add", "workhorse", "--path", options.crate] },
      { command: "cargo", args: ["generate-lockfile"] },
      {
        command: "cargo",
        args: ["pkgid", "workhorse"],
        expect: `${pathToFileURL(options.crate).href.replace(/^file:/, "path+file:")}#workhorse@${version}`,
      },
    ];
  }
  return [
    { command: "cargo", args: ["init", "--name", "release_verify", "--vcs", "none"] },
    { command: "cargo", args: ["add", `workhorse@=${version}`] },
    { command: "cargo", args: ["generate-lockfile"] },
    {
      command: "cargo",
      args: ["pkgid", "workhorse"],
      expect: `registry+https://github.com/rust-lang/crates.io-index#workhorse@${version}`,
    },
  ];
}

const jvmDirectory = path.join(repositoryRoot, "jvm");

/** The Gradle properties that pin each JVM consumer to the versions the artifacts build against. */
export async function consumerProperties(version: string): Promise<string[]> {
  const catalogue = await readFile(path.join(jvmDirectory, "gradle", "libs.versions.toml"), "utf8");
  const pinned = (name: string) => {
    const value = new RegExp(`^${name} = "([^"]+)"$`, "m").exec(catalogue)?.[1];
    if (!value) throw new Error(`jvm/gradle/libs.versions.toml declares no ${name} version`);
    return value;
  };
  return [
    `-PworkhorseVersion=${version}`,
    `-PpgjdbcVersion=${pinned("pgjdbc")}`,
    `-PkotlinVersion=${pinned("kotlin")}`,
    `-PspringBootVersion=${pinned("spring-boot")}`,
  ];
}

/**
 * The scratch directory is outside the checkout, where a mise shim finds no pinned version. These
 * variables give the shims the versions of `mise.toml`. A CI runner without mise ignores them.
 */
async function jvmToolchainEnvironment(): Promise<Record<string, string>> {
  const pins = await readFile(path.join(repositoryRoot, "mise.toml"), "utf8");
  const environment: Record<string, string> = {};
  for (const tool of ["gradle", "java"]) {
    const value = new RegExp(`^${tool} = "([^"]+)"$`, "m").exec(pins)?.[1];
    if (value) environment[`MISE_${tool.toUpperCase()}_VERSION`] = value;
  }
  return environment;
}

/** The PostgreSQL database that the Maven target runs its tasks in. */
const verifyDatabaseVariable = "WORKHORSE_VERIFY_DATABASE_URL";

/** A JDBC URL for a `postgres://` URL, with the credentials as parameters. */
export function jdbcUrl(url: string): string {
  const parsed = new URL(url);
  const parameters = new URLSearchParams(parsed.search);
  if (parsed.username) parameters.set("user", decodeURIComponent(parsed.username));
  if (parsed.password) parameters.set("password", decodeURIComponent(parsed.password));
  const query = parameters.toString();
  return `jdbc:postgresql://${parsed.host}${parsed.pathname}${query ? `?${query}` : ""}`;
}

/**
 * The Java consumer takes `run.workhorse:workhorse`, and the Kotlin consumer takes
 * `run.workhorse:workhorse-kotlin`. ADR 0103 makes each run a task end to end: each enqueues one
 * task in the database that `WORKHORSE_VERIFY_DATABASE_URL` names, runs it, and checks that it
 * succeeded. Each prints the file name of the jar it loaded, then the task id.
 */
async function mavenSteps(
  version: string,
  options: VerificationOptions,
  ambient: NodeJS.ProcessEnv,
): Promise<VerificationStep[]> {
  const database = ambient[verifyDatabaseVariable];
  if (!database) {
    throw new Error(
      `The maven target needs ${verifyDatabaseVariable}, the URL of a PostgreSQL database with the Workhorse schema`,
    );
  }
  const environment = await jvmToolchainEnvironment();
  const properties = [
    ...(await consumerProperties(version)),
    ...(options.mavenRepo === undefined ? [] : [`-PworkhorseRepository=${options.mavenRepo}`]),
  ];
  return [
    ["java", "workhorse"],
    ["kotlin", "workhorse-kotlin"],
  ].flatMap(([consumer, artifact]) => [
    {
      command: "cp",
      args: ["-R", path.join(jvmDirectory, "release-consumer", consumer!), consumer!],
    },
    {
      command: "gradle",
      // After a publish, Gradle asks Maven Central again instead of trusting an earlier lookup.
      args: [
        "-p",
        consumer!,
        "--quiet",
        ...(options.mavenRepo === undefined ? ["--refresh-dependencies"] : []),
        "run",
        ...properties,
        `--args=${jdbcUrl(database)}`,
      ],
      environment,
      expectPattern: new RegExp(
        `^${artifact!.replaceAll("-", "\\-")}-${version.replaceAll(".", "\\.")}\\.jar\\n[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
      ),
    },
  ]);
}

/**
 * The staged proxy goes first and proxy.golang.org serves the dependencies, still with no `direct`
 * fallback. The checksum database has never seen the staged version, so it skips this module only.
 * A scratch module cache keeps the staged zip out of the cache a post-publish check would read.
 */
function goRehearsalEnvironment(proxy: string): Record<string, string> {
  return {
    ...goEnvironment,
    GOFLAGS: `${goEnvironment.GOFLAGS} -modcacherw`,
    GOMODCACHE: path.join(proxy, ".modcache"),
    GONOSUMDB: goModule,
    GOPROXY: `${pathToFileURL(proxy).href},${goEnvironment.GOPROXY}`,
  };
}

function goSteps(version: string, options: VerificationOptions): VerificationStep[] {
  const tagged = `${goModule}@v${version}`;
  const environment =
    options.goProxy === undefined ? goEnvironment : goRehearsalEnvironment(options.goProxy);
  return [
    {
      command: "go",
      args: ["list", "-m", tagged],
      environment,
      expect: `${goModule} v${version}`,
    },
    {
      command: "go",
      args: ["mod", "init", "example.com/release-verify"],
      environment,
    },
    { command: "go", args: ["get", tagged], environment },
    {
      command: "go",
      args: ["mod", "verify"],
      environment,
      expect: "all modules verified",
    },
    {
      command: "go",
      args: ["list", "-m", goModule],
      environment,
      expect: `${goModule} v${version}`,
    },
  ];
}

interface ProvenanceResponse {
  readonly attestation_bundles?: readonly {
    readonly publisher?: { readonly repository?: string; readonly workflow?: string };
    readonly attestations?: readonly unknown[];
  }[];
}

/**
 * Name each file of a PyPI release that lacks a PEP 740 attestation from the release workflow.
 * `uv publish` before 0.9.12 uploaded 0.6.0 without any and still exited 0 (SM-1098), so only
 * PyPI's integrity API can say whether the attestations arrived.
 */
export async function pythonProvenanceProblems(
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const release = await fetchImpl(`https://pypi.org/pypi/${pythonDistribution}/${version}/json`);
  if (!release.ok) {
    return [`PyPI has no ${pythonDistribution} ${version} (HTTP ${String(release.status)})`];
  }
  const files = ((await release.json()) as { readonly urls: readonly { filename: string }[] }).urls;
  if (files.length === 0) return [`PyPI lists no files for ${pythonDistribution} ${version}`];
  const problems: string[] = [];
  for (const { filename } of files) {
    const response = await fetchImpl(
      `https://pypi.org/integrity/${pythonDistribution}/${version}/${filename}/provenance`,
      { headers: { Accept: "application/vnd.pypi.integrity.v1+json" } },
    );
    if (!response.ok) {
      problems.push(`${filename} has no PyPI provenance (HTTP ${String(response.status)})`);
      continue;
    }
    const bundles = ((await response.json()) as ProvenanceResponse).attestation_bundles ?? [];
    const attested = bundles.some(
      (bundle) =>
        bundle.publisher?.repository === pythonPublisher.repository &&
        bundle.publisher.workflow === pythonPublisher.workflow &&
        (bundle.attestations?.length ?? 0) > 0,
    );
    if (!attested) {
      problems.push(
        `${filename} has no attestation from ${pythonPublisher.repository} ${pythonPublisher.workflow}`,
      );
    }
  }
  return problems;
}

function requireArtifactTarget(target: VerifyTarget, options: VerificationOptions): void {
  for (const [owner, option] of Object.entries(artifactOptions)) {
    if (owner !== target && options[option] !== undefined) {
      throw new Error(`${artifactFlags[option]} applies only to the ${owner} target`);
    }
  }
}

export async function verificationSteps(
  target: VerifyTarget,
  version: string,
  options: VerificationOptions = {},
  ambient: NodeJS.ProcessEnv = process.env,
): Promise<readonly VerificationStep[]> {
  requireArtifactTarget(target, options);
  switch (target) {
    case "python":
      return await pythonSteps(version, options);
    case "npm":
      return await npmSteps(version, options);
    case "crate":
      return crateSteps(version, options);
    case "go":
      return goSteps(version, options);
    case "maven":
      return await mavenSteps(version, options, ambient);
  }
}

/** The step as a shell line, with a database password replaced. */
export function render(step: VerificationStep): string {
  const quoted = [step.command, ...step.args]
    .map((part) => part.replace(/password=[^&\s]+/g, "password=***"))
    .map((part) =>
      /^[\w@=./:+-]+$/.test(part) ? part : `'${part.replaceAll("'", String.raw`'\''`)}'`,
    );
  const environment = Object.entries(step.environment ?? {}).map(
    ([key, value]) => `${key}=${value}`,
  );
  return [...environment, ...quoted].join(" ");
}

async function runStep(
  step: VerificationStep,
  directory: string,
  ambient: NodeJS.ProcessEnv,
): Promise<void> {
  process.stdout.write(`$ ${render(step)}\n`);
  const command = step.command.includes("/") ? path.join(directory, step.command) : step.command;
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...step.args], {
      cwd: directory,
      env: { ...ambient, ...step.environment },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${render(step)} exited with ${signal ?? String(code)}`));
    });
  });
  if (step.expect !== undefined && stdout.trim() !== step.expect) {
    throw new Error(
      `${render(step)} printed ${JSON.stringify(stdout.trim())}, expected ${step.expect}`,
    );
  }
  if (step.expectPattern !== undefined && !step.expectPattern.test(stdout.trim())) {
    throw new Error(
      `${render(step)} printed ${JSON.stringify(stdout.trim())}, expected ${String(step.expectPattern)}`,
    );
  }
}

/** Run every step for one registry in a fresh scratch directory, stopping at the first failure. */
export async function verifyRelease(
  target: VerifyTarget,
  version: string,
  options: VerificationOptions = {},
  ambient: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  requireArtifactTarget(target, options);
  // Steps run in a scratch directory, so every artifact path must be absolute. Cargo reports the
  // canonical path of a path dependency, so symbolic links are resolved too.
  const resolved = Object.fromEntries(
    await Promise.all(
      Object.entries(options).map(async ([key, value]) => [
        key,
        await realpath(path.resolve(value as string)),
      ]),
    ),
  ) as VerificationOptions;
  const steps = await verificationSteps(target, version, resolved, ambient);
  const directory = await mkdtemp(path.join(tmpdir(), `workhorse-release-verify-${target}-`));
  try {
    for (const step of steps) await runStep(step, directory, ambient);
    // A local wheel has no PyPI provenance yet; the dry run's attestation rehearsal covers it.
    if (target === "python" && resolved.wheel === undefined) {
      process.stdout.write(
        `$ check PyPI PEP 740 provenance for ${pythonDistribution} ${version}\n`,
      );
      const problems = await pythonProvenanceProblems(version);
      if (problems.length > 0) throw new Error(problems.join("; "));
    }
    process.stdout.write(`Verified ${target} ${version}\n`);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function isTarget(value: string | undefined): value is VerifyTarget {
  return (
    value === "crate" ||
    value === "go" ||
    value === "maven" ||
    value === "npm" ||
    value === "python"
  );
}

function artifactOption(flag: string | undefined): ArtifactOption | undefined {
  return (Object.keys(artifactFlags) as ArtifactOption[]).find(
    (option) => artifactFlags[option] === flag,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [target, version, flag, artifact, ...rest] = process.argv.slice(2);
  const option = artifactOption(flag);
  const artifactValid = flag === undefined || (option !== undefined && artifact !== undefined);
  if (!isTarget(target) || !version || !artifactValid || rest.length > 0) {
    process.stderr.write(
      "Usage: pnpm release:verify <python|npm|crate|go|maven> <X.Y.Z> " +
        "[--wheel <file> | --tarballs <directory> | --crate <directory> | --go-proxy <directory> | " +
        "--maven-repo <directory>]\n",
    );
    process.exitCode = 64;
  } else {
    try {
      await verifyRelease(target, version, option ? { [option]: artifact } : {});
    } catch (error) {
      process.stderr.write(`Release verification failed: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  }
}
