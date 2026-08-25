import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEMO_GO_QUEUE,
  DEMO_PYTHON_QUEUE,
  DEMO_WORKER_CONCURRENCY,
  LANGUAGE_WORKER_JOB_TYPE,
} from "./constants.js";

describe("multilanguage demo worker topology", () => {
  it("declares one equal-capacity worker in each runtime", () => {
    expect(DEMO_WORKER_CONCURRENCY).toEqual([3, 3, 3]);
    expect([DEMO_PYTHON_QUEUE, DEMO_GO_QUEUE]).toEqual(["demo-python", "demo-go"]);
    expect(LANGUAGE_WORKER_JOB_TYPE).toBe("demo.language-worker");
  });

  it("packages and supervises the Python and Go workers", async () => {
    const [dockerfile, entrypoint, developmentLauncher] = await Promise.all([
      readFile(resolve("Dockerfile"), "utf8"),
      readFile(resolve("typescript/demo/container-entrypoint.mjs"), "utf8"),
      readFile(resolve("scripts/dev.ts"), "utf8"),
    ]);

    expect(dockerfile).toContain("FROM golang:1.25-alpine AS go-build");
    expect(dockerfile).toContain("FROM python:3.14-alpine AS python-build");
    expect(entrypoint).toContain("workhorse-go-demo-worker");
    expect(entrypoint).toContain("workhorse-python-worker.py");
    expect(developmentLauncher).toContain('"./examples/demo-worker"');
    expect(developmentLauncher).toContain('"python/examples/demo_worker.py"');
  });
});
