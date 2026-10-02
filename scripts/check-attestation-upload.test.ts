import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { attestationUploadProblems } from "./check-attestation-upload.js";

const execFileAsync = promisify(execFile);
const wheel = "fixture_package-1.0.0-py3-none-any.whl";
const sdist = "fixture_package-1.0.0.tar.gz";

// The smallest wheel and sdist whose metadata `uv publish` accepts.
const fixtureScript = String.raw`
import io, sys, tarfile, zipfile
directory = sys.argv[1]
metadata = "Metadata-Version: 2.1\nName: fixture-package\nVersion: 1.0.0\n"
with zipfile.ZipFile(f"{directory}/${wheel}", "w") as archive:
    archive.writestr("fixture_package/__init__.py", "")
    archive.writestr("fixture_package-1.0.0.dist-info/METADATA", metadata)
    archive.writestr("fixture_package-1.0.0.dist-info/WHEEL", "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
    archive.writestr("fixture_package-1.0.0.dist-info/RECORD", "")
with tarfile.open(f"{directory}/${sdist}", "w:gz") as archive:
    data = metadata.encode()
    info = tarfile.TarInfo("fixture_package-1.0.0/PKG-INFO")
    info.size = len(data)
    archive.addfile(info, io.BytesIO(data))
`;

// The check reads only whether uv sent a non-empty attestation list, not the attestation itself.
const attestation = JSON.stringify({
  version: 1,
  verification_material: { certificate: "", transparency_entries: [] },
  envelope: { statement: "", signature: "" },
});

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "workhorse-attestation-upload-"));
  await execFileAsync("python3", ["-c", fixtureScript, directory]);
  for (const file of [wheel, sdist]) {
    await writeFile(path.join(directory, `${file}.publish.attestation`), attestation);
  }
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe("attestationUploadProblems", () => {
  it("passes when the pinned uv sends an attestation with every distribution", async () => {
    await expect(attestationUploadProblems(directory)).resolves.toEqual([]);
  });

  // uv before 0.9.12 never sent attestations, which is how 0.6.0 reached PyPI unattested.
  it("fails when uv publishes without the attestations", async () => {
    await expect(
      attestationUploadProblems(directory, {
        environment: { UV_PUBLISH_NO_ATTESTATIONS: "true" },
      }),
    ).resolves.toEqual([
      `uv publish uploaded ${wheel} without attestations`,
      `uv publish uploaded ${sdist} without attestations`,
    ]);
  });

  it("fails when a distribution has no attestation file", async () => {
    await unlink(path.join(directory, `${sdist}.publish.attestation`));

    await expect(attestationUploadProblems(directory)).resolves.toEqual([
      `${sdist} has no ${sdist}.publish.attestation beside it`,
      `uv publish uploaded ${sdist} without attestations`,
    ]);
  });

  it("fails when the directory holds no distribution", async () => {
    await rm(path.join(directory, wheel));
    await rm(path.join(directory, sdist));

    await expect(attestationUploadProblems(directory)).resolves.toEqual([
      `${directory} holds no wheel or sdist`,
    ]);
  });
});

interface Step {
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface Job {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps: readonly Step[];
}

describe("the Release Python attestation rehearsal", () => {
  it("prepares the distributions exactly as the publish job does", async () => {
    const workflow = parse(
      await readFile(new URL("../.github/workflows/release-python.yml", import.meta.url), "utf8"),
    ) as { readonly jobs: Readonly<Record<string, Job>> };
    const publish = workflow.jobs.publish;
    const rehearsal = workflow.jobs["attestation-rehearsal"];
    // The steps that put attested files in python/dist and choose the uv that uploads them.
    const preparation = (job: Job | undefined) =>
      job?.steps.filter((step) =>
        /^(astral-sh\/setup-uv|actions\/download-artifact|astral-sh\/attest-action)@/.test(
          step.uses ?? "",
        ),
      );

    // The rehearsal runs on every dry run and tag push, and publication waits for it.
    expect(rehearsal?.if).toBeUndefined();
    expect(rehearsal).toMatchObject({ needs: "build", permissions: { "id-token": "write" } });
    expect(publish?.needs).toEqual(["build", "attestation-rehearsal"]);
    expect(preparation(rehearsal)).toHaveLength(3);
    expect(preparation(rehearsal)).toEqual(preparation(publish));
    expect(publish?.steps.at(-1)?.run).toBe("uv publish --trusted-publishing always python/dist/*");
    expect(rehearsal?.steps.at(-1)?.run).toBe(
      "node scripts/check-attestation-upload.ts python/dist",
    );
  });
});
