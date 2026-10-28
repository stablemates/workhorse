/**
 * Decide whether the `maven-central` or `nuget` job of `release.yml` publishes its line (SM-1861).
 *
 * A release tag publishes all seven lines from one commit, and `github-release` announces the
 * version after every registry job succeeds. If the version of the line differs from the tag, the
 * line does not join the tag, so the script writes `publish=false` and the job succeeds. If the
 * version matches the tag, each secret of the line must exist. A missing secret fails the script
 * before any upload, and the message names each missing secret. Before SM-1861, a missing secret
 * ended the job with success, and the GitHub release announced a version without that line.
 *
 * The step learns only whether each secret exists, through `HAS_<SECRET>=true`. The values stay
 * out of the step.
 *
 * The release workflow runs this with plain `node`, before any dependency is installed, so it
 * imports only Node built-ins.
 *
 * Usage: node scripts/check-release-line.ts <maven-central|nuget> <tag>
 */
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

export const lines = ["maven-central", "nuget"] as const;
export type Line = (typeof lines)[number];

interface ReleaseLine {
  /** The file that carries the version of the line, relative to the repository root. */
  readonly file: string;
  /** Matches each statement of the version. The file must hold exactly one. */
  readonly version: RegExp;
  /** What the line publishes, for the messages. */
  readonly artifacts: string;
  /** The secrets of the GitHub environment that the job reads. */
  readonly secrets: readonly string[];
}

export const releaseLines: Record<Line, ReleaseLine> = {
  "maven-central": {
    file: "jvm/gradle.properties",
    version: /^version=(\S+)$/gm,
    artifacts: "the JVM artifacts to Maven Central",
    secrets: [
      "MAVEN_CENTRAL_USERNAME",
      "MAVEN_CENTRAL_PASSWORD",
      "MAVEN_SIGNING_KEY",
      "MAVEN_SIGNING_PASSWORD",
    ],
  },
  nuget: {
    file: "dotnet/Directory.Build.props",
    version: /<Version>([^<]*)<\/Version>/g,
    artifacts: "the .NET packages to nuget.org",
    secrets: ["NUGET_USER"],
  },
};

export interface CheckOptions {
  readonly line: Line;
  readonly tag: string;
  /** The repository root that holds the version file. */
  readonly root: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface CheckOutcome {
  /** True when the line joins the tag and every secret exists, so the job publishes. */
  readonly publish: boolean;
  readonly message: string;
}

/** Throws when the line joins the tag and a secret is missing. */
export async function checkReleaseLine(options: CheckOptions): Promise<CheckOutcome> {
  const line = releaseLines[options.line];
  const source = await readFile(path.join(options.root, line.file), "utf8");
  const versions = [...source.matchAll(line.version)].map((match) => match[1]);
  if (versions.length !== 1 || !versions[0])
    throw new Error(`${line.file} states ${versions.length} versions, not one`);
  const version = versions[0];
  if (`v${version}` !== options.tag)
    return {
      publish: false,
      message: `${line.file} is at ${version}, so ${options.tag} does not publish ${line.artifacts}`,
    };
  const missing = line.secrets.filter((secret) => options.environment[`HAS_${secret}`] !== "true");
  if (missing.length > 0)
    throw new Error(
      `The ${options.line} environment lacks ${missing.join(", ")}, so ${options.tag} cannot ` +
        `publish ${line.artifacts}. Add each missing secret to the environment, then re-run the job`,
    );
  return {
    publish: true,
    message: `${line.file} is at ${version}, so ${options.tag} publishes ${line.artifacts}`,
  };
}

export interface RunOptions {
  readonly root?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Run the check from command-line arguments, and return the exit code. */
export async function runCheck(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const environment = options.environment ?? process.env;
  const [line, tag, ...rest] = argv;
  if (!lines.includes(line as Line) || !tag || rest.length > 0) {
    process.stderr.write("Usage: node scripts/check-release-line.ts <maven-central|nuget> <tag>\n");
    return 64;
  }
  const summary = async (text: string) => {
    if (environment.GITHUB_STEP_SUMMARY)
      await appendFile(environment.GITHUB_STEP_SUMMARY, `${text}\n`);
  };
  try {
    const outcome = await checkReleaseLine({
      line: line as Line,
      tag,
      root: options.root ?? path.resolve(import.meta.dirname, ".."),
      environment,
    });
    if (outcome.publish) {
      process.stdout.write(`${outcome.message}\n`);
    } else {
      process.stdout.write(`::notice::${outcome.message}\n`);
      await summary(outcome.message);
    }
    if (environment.GITHUB_OUTPUT)
      await appendFile(environment.GITHUB_OUTPUT, `publish=${String(outcome.publish)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message}\n`);
    await summary(message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exitCode = await runCheck(process.argv.slice(2));
}
