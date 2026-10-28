import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkReleaseLine, lines, releaseLines, runCheck } from "./check-release-line.js";

const repository = path.resolve(import.meta.dirname, "..");

/** Each secret of the line, set. */
const allSecrets = (line: (typeof lines)[number]) =>
  Object.fromEntries(releaseLines[line].secrets.map((secret) => [`HAS_${secret}`, "true"]));

describe("the release line check before a Maven Central or nuget.org upload", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "workhorse-release-line-"));
    await mkdir(path.join(root, "jvm"));
    await mkdir(path.join(root, "dotnet"));
    await writeFile(
      path.join(root, "jvm/gradle.properties"),
      "group=run.workhorse\nversion=0.11.0\n",
    );
    await writeFile(
      path.join(root, "dotnet/Directory.Build.props"),
      "<Project>\n  <PropertyGroup>\n    <Version>0.11.0</Version>\n  </PropertyGroup>\n</Project>\n",
    );
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  it("names the secrets that each job of release.yml reads", async () => {
    const workflow = await readFile(path.join(repository, ".github/workflows/release.yml"), "utf8");
    for (const line of lines) {
      const end = line === "maven-central" ? "\n  nuget:" : "\n  github-release:";
      const job = workflow.slice(workflow.indexOf(`\n  ${line}:`), workflow.indexOf(end));
      const read = new Set([...job.matchAll(/secrets\.(\w+)/g)].map((match) => match[1]));
      expect(read).toEqual(new Set(releaseLines[line].secrets));
      for (const secret of releaseLines[line].secrets)
        expect(job).toContain(`HAS_${secret}: \${{ secrets.${secret} != '' }}`);
      expect(job).toContain(`node scripts/check-release-line.ts ${line} "$GITHUB_REF_NAME"`);
    }
  });

  it("reads the version of each line from the files of this repository", async () => {
    for (const line of lines) {
      const outcome = await checkReleaseLine({
        line,
        tag: "v0.0.0-not-a-version",
        root: repository,
        environment: {},
      });
      expect(outcome.publish).toBe(false);
      expect(outcome.message).toMatch(/is at \d+\.\d+\.\d+/);
    }
  });

  describe.each(lines)("for %s", (line) => {
    const check = (tag: string, environment: Record<string, string>) =>
      checkReleaseLine({ line, tag, root, environment });

    it("publishes when the version matches the tag and every secret exists", async () => {
      const outcome = await check("v0.11.0", allSecrets(line));
      expect(outcome.publish).toBe(true);
    });

    it("publishes nothing and succeeds when the version differs from the tag", async () => {
      // The secrets do not matter, because the line does not join this tag.
      const outcome = await check("v0.12.0", {});
      expect(outcome.publish).toBe(false);
      expect(outcome.message).toContain(`${releaseLines[line].file} is at 0.11.0`);
      expect(outcome.message).toContain("v0.12.0 does not publish");
    });

    it.each(releaseLines[line].secrets)(
      "fails before the upload and names %s when it is missing",
      async (secret) => {
        const environment = { ...allSecrets(line), [`HAS_${secret}`]: "false" };
        await expect(check("v0.11.0", environment)).rejects.toThrow(secret);
        await expect(check("v0.11.0", environment)).rejects.toThrow(
          `The ${line} environment lacks`,
        );
      },
    );

    it("names every missing secret", async () => {
      const error = await check("v0.11.0", {}).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      for (const secret of releaseLines[line].secrets)
        expect((error as Error).message).toContain(secret);
    });

    it("fails when the version file has no version", async () => {
      await writeFile(path.join(root, releaseLines[line].file), "nothing here\n");
      await expect(check("v0.11.0", allSecrets(line))).rejects.toThrow(
        `${releaseLines[line].file} states 0 versions, not one`,
      );
    });

    it("fails when the version file states a second version", async () => {
      const file = path.join(root, releaseLines[line].file);
      const second =
        line === "maven-central"
          ? "version=0.10.1\n"
          : "<Project><Version>0.10.1</Version></Project>\n";
      await writeFile(file, `${await readFile(file, "utf8")}${second}`);
      await expect(check("v0.11.0", allSecrets(line))).rejects.toThrow(
        `${releaseLines[line].file} states 2 versions, not one`,
      );
    });
  });

  describe("from the command line", () => {
    let output: string;
    let summary: string;

    beforeEach(async () => {
      output = path.join(root, "output");
      summary = path.join(root, "summary");
      await writeFile(output, "");
      await writeFile(summary, "");
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });

    const run = (argv: string[], secrets: Record<string, string>) =>
      runCheck(argv, {
        root,
        environment: { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...secrets },
      });

    it("writes publish=true on a match", async () => {
      expect(await run(["nuget", "v0.11.0"], allSecrets("nuget"))).toBe(0);
      expect(await readFile(output, "utf8")).toBe("publish=true\n");
    });

    it("writes publish=false and a notice on a mismatch", async () => {
      expect(await run(["maven-central", "v0.12.0"], {})).toBe(0);
      expect(await readFile(output, "utf8")).toBe("publish=false\n");
      expect(await readFile(summary, "utf8")).toContain("does not publish");
      expect(process.stdout.write).toHaveBeenCalledWith(expect.stringMatching(/^::notice::/));
    });

    it("exits 1, writes no output, and names the secret when one is missing", async () => {
      const secrets = { ...allSecrets("maven-central"), HAS_MAVEN_SIGNING_KEY: "false" };
      expect(await run(["maven-central", "v0.11.0"], secrets)).toBe(1);
      expect(await readFile(output, "utf8")).toBe("");
      expect(await readFile(summary, "utf8")).toContain("MAVEN_SIGNING_KEY");
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringMatching(/^::error::.*MAVEN_SIGNING_KEY/),
      );
    });

    it("refuses an unknown line or a missing tag", async () => {
      expect(await run(["crates-io", "v0.11.0"], {})).toBe(64);
      expect(await run(["nuget"], {})).toBe(64);
      expect(await run(["nuget", "v0.11.0", "extra"], {})).toBe(64);
    });
  });
});
