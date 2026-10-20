import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { downloadThenCheck, toolBinary } from "./run-go-check.js";

// The download fails while the marker file is missing and creates it, so it fails once and then
// passes, as a module download does after a transient stream reset.
const failOnce = [
  "-e",
  "const fs = require('node:fs'); if (!fs.existsSync('marker')) { fs.writeFileSync('marker', ''); process.exit(1); }",
];
const alwaysFail = ["-e", "process.exit(2)"];
// The check appends one line to `checks` each time it runs, then exits with the given status.
const check = (status: number) => [
  "-e",
  `require('node:fs').appendFileSync('checks', 'run\\n'); process.exit(${status});`,
];

let scratch: string;
let reports: string[];
const retry = () => ({
  report: (message: string) => reports.push(message),
  wait: async () => {},
});
const download = (args: readonly string[]) => ({
  label: "go mod download",
  command: process.execPath,
  args,
  cwd: scratch,
});
const checkRuns = async () =>
  (await readFile(path.join(scratch, "checks"), "utf8").catch(() => "")).split("\n").length - 1;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "run-go-check-test-"));
  reports = [];
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

it("retries a download that fails once, then runs the check once", async () => {
  const status = await downloadThenCheck(
    [download(failOnce)],
    { command: process.execPath, args: check(0), cwd: scratch },
    retry(),
  );

  expect(status).toBe(0);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatch(/^go mod download: attempt 1 of 3 failed/);
  expect(await checkRuns()).toBe(1);
});

it("returns a finding of the check at once, with no retry", async () => {
  // govulncheck exits 3 when it finds a vulnerability.
  const status = await downloadThenCheck(
    [download(["-e", ""])],
    { command: process.execPath, args: check(3), cwd: scratch },
    retry(),
  );

  expect(status).toBe(3);
  expect(reports).toEqual([]);
  expect(await checkRuns()).toBe(1);
});

it("does not run the check when a download fails on every attempt", async () => {
  await expect(
    downloadThenCheck(
      [download(alwaysFail)],
      { command: process.execPath, args: check(0), cwd: scratch },
      retry(),
    ),
  ).rejects.toThrow(/exited with 2$/);

  expect(reports).toHaveLength(3);
  expect(await checkRuns()).toBe(0);
});

it("names the installed binary after the last element of the package path", () => {
  const suffix = process.platform === "win32" ? ".exe" : "";
  expect(toolBinary("honnef.co/go/tools/cmd/staticcheck@v0.7.0")).toBe(`staticcheck${suffix}`);
  expect(toolBinary("golang.org/x/vuln/cmd/govulncheck@v1.7.0")).toBe(`govulncheck${suffix}`);
  expect(() => toolBinary("golang.org/x/vuln/cmd/govulncheck")).toThrow(/<package>@<version>/);
});
