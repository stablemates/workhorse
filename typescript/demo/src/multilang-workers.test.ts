import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEMO_GO_QUEUE,
  DEMO_PYTHON_QUEUE,
  DEMO_QUEUE,
  DEMO_RATE_LIMIT_QUEUE,
  DEMO_SHARED_QUEUE,
  DEMO_WORKER_CONCURRENCY,
  LANGUAGE_WORKER_JOB_TYPE,
  SHARED_WORKER_JOB_TYPE,
} from "./constants.js";
import { sharedWorkerJob } from "./handlers.js";

describe("multilanguage demo worker topology", () => {
  it("declares one equal-capacity worker in each runtime", () => {
    expect(DEMO_WORKER_CONCURRENCY).toEqual([3, 3, 3]);
    expect([
      DEMO_QUEUE,
      DEMO_RATE_LIMIT_QUEUE,
      DEMO_PYTHON_QUEUE,
      DEMO_GO_QUEUE,
      DEMO_SHARED_QUEUE,
    ]).toEqual(["demo", "partner-api", "demo-python", "demo-go", "demo-shared"]);
    expect(LANGUAGE_WORKER_JOB_TYPE).toBe("demo.language-worker");
    expect(SHARED_WORKER_JOB_TYPE).toBe("demo.shared-worker");
  });

  it("packages and supervises the Python and Go workers", async () => {
    const [dockerfile, entrypoint, developmentLauncher, pythonWorker, goWorker] = await Promise.all(
      [
        readFile(resolve("Dockerfile"), "utf8"),
        readFile(resolve("typescript/demo/container-entrypoint.mjs"), "utf8"),
        readFile(resolve("scripts/dev.ts"), "utf8"),
        readFile(resolve("python/examples/demo_worker.py"), "utf8"),
        readFile(resolve("go/examples/demo-worker/main.go"), "utf8"),
      ],
    );

    expect(dockerfile).toContain("FROM golang:1.25-alpine AS go-build");
    expect(dockerfile).toContain("FROM python:3.14-alpine AS python-build");
    expect(entrypoint).toContain("workhorse-go-demo-worker");
    expect(entrypoint).toContain("workhorse-python-worker.py");
    expect(developmentLauncher).toContain('"./examples/demo-worker"');
    expect(developmentLauncher).toContain('"python/examples/demo_worker.py"');
    expect(pythonWorker).toContain('SCHEDULE_NAMESPACE = "workhorse-demo"');
    expect(pythonWorker).toContain("schedule_namespaces=(SCHEDULE_NAMESPACE,)");
    expect(goWorker).toContain('scheduleNamespace       = "workhorse-demo"');
    expect(goWorker).toContain("ScheduleNamespaces:  []string{scheduleNamespace}");
  });

  it("enforces the shared handler contract in TypeScript", () => {
    expect(sharedWorkerJob({ source: "schedule" }, 3)).toEqual({
      source: "schedule",
      runtime: "node",
      attempt: 3,
    });
    expect(() => sharedWorkerJob({ source: 123 }, 1)).toThrow("Shared worker requires a source");
  });
});
