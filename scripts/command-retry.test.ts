import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { retryStep, runCommand } from "./command-retry.js";

// The command fails while the marker file is missing and creates it, so it fails once and then
// passes, as a download does after a transient stream reset.
const failOnce = [
  "-e",
  [
    "const fs = require('node:fs');",
    "if (!fs.existsSync('marker')) { fs.writeFileSync('marker', ''); process.exit(1); }",
    "process.stdout.write('downloaded');",
  ].join(" "),
];
const alwaysFail = ["-e", "process.exit(2)"];

let scratch: string;
let reports: string[];
let waits: number[];
const options = () => ({
  label: "go mod download",
  delayMs: 1_500,
  report: (message: string) => reports.push(message),
  wait: async (ms: number) => {
    waits.push(ms);
  },
});

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "command-retry-test-"));
  reports = [];
  waits = [];
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

it("passes when a command fails once and then passes", async () => {
  const output = await retryStep(() => runCommand(process.execPath, failOnce, scratch), options());

  expect(output).toBe("downloaded");
  expect(waits).toEqual([1_500]);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatch(/^go mod download: attempt 1 of 3 failed \(.*exited with 1\)/);
  expect(reports[0]).toContain("retrying in 1.5 s");
});

it("fails with the last error when a command always fails", async () => {
  await expect(
    retryStep(() => runCommand(process.execPath, alwaysFail, scratch), options()),
  ).rejects.toThrow(/exited with 2$/);

  expect(waits).toEqual([1_500, 1_500]);
  expect(reports).toHaveLength(3);
  expect(reports[2]).toMatch(/^go mod download: attempt 3 of 3 failed \(.*exited with 2\)$/);
});

it("runs a passing step once without a report or a delay", async () => {
  let calls = 0;
  await expect(
    retryStep(async () => {
      calls += 1;
      return "ok";
    }, options()),
  ).resolves.toBe("ok");

  expect(calls).toBe(1);
  expect(reports).toEqual([]);
  expect(waits).toEqual([]);
});
