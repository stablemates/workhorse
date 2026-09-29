import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEMO_FAST_TIER_SCHEDULE_NAMESPACE,
  DEMO_GO_FAST_QUEUE,
  DEMO_GO_QUEUE,
  DEMO_PYTHON_FAST_QUEUE,
  DEMO_PYTHON_QUEUE,
  DEMO_QUEUE,
  DEMO_RATE_LIMIT_QUEUE,
  DEMO_RUST_FAST_QUEUE,
  DEMO_RUST_QUEUE,
  DEMO_SHARED_QUEUE,
  DEMO_WORKER_CONCURRENCY,
  LANGUAGE_WORKER_TASK_TYPE,
  SHARED_WORKER_TASK_TYPE,
} from "./constants.js";
import { sharedWorkerTask } from "./handlers.js";

describe("multilanguage demo worker topology", () => {
  it("declares one equal-capacity worker in each runtime", () => {
    expect(DEMO_WORKER_CONCURRENCY).toEqual([3, 3, 3, 3]);
    expect([
      DEMO_QUEUE,
      DEMO_RATE_LIMIT_QUEUE,
      DEMO_PYTHON_QUEUE,
      DEMO_GO_QUEUE,
      DEMO_RUST_QUEUE,
      DEMO_SHARED_QUEUE,
    ]).toEqual(["demo", "partner-api", "demo-python", "demo-go", "demo-rust", "demo-shared"]);
    expect(LANGUAGE_WORKER_TASK_TYPE).toBe("demo.language-worker");
    expect(SHARED_WORKER_TASK_TYPE).toBe("demo.shared-worker");
  });

  it("packages and supervises the Python, Go, and Rust workers", async () => {
    const [dockerfile, entrypoint, developmentLauncher, pythonWorker, goWorker, rustWorker] =
      await Promise.all([
        readFile(resolve("Dockerfile"), "utf8"),
        readFile(resolve("typescript/demo/container-entrypoint.mjs"), "utf8"),
        readFile(resolve("scripts/dev.ts"), "utf8"),
        readFile(resolve("python/examples/demo_worker.py"), "utf8"),
        readFile(resolve("go/examples/demo-worker/main.go"), "utf8"),
        readFile(resolve("rust/demo-worker/src/lib.rs"), "utf8"),
      ]);

    expect(dockerfile).toContain("FROM golang:1.25-alpine@sha256:");
    expect(dockerfile).toContain("FROM python:3.14-alpine@sha256:");
    expect(dockerfile).toMatch(
      /^FROM rust:\d+\.\d+(\.\d+)?-alpine@sha256:[0-9a-f]{64} AS rust-build$/m,
    );
    expect(dockerfile).toContain("cargo build --locked --release -p workhorse-demo-worker");
    expect(dockerfile).toMatch(
      /^FROM ghcr\.io\/astral-sh\/uv:\d+\.\d+\.\d+@sha256:[0-9a-f]{64} AS uv$/m,
    );
    expect(dockerfile).toContain("COPY python/pyproject.toml python/uv.lock ./python/");
    expect(dockerfile).toContain("--locked");
    expect(dockerfile).toContain("--require-hashes");
    expect(entrypoint).toContain("workhorse-go-demo-worker");
    expect(entrypoint).toContain("workhorse-python-worker.py");
    expect(entrypoint).toContain('"/usr/local/bin/workhorse-rust-demo-worker"');
    expect(entrypoint).toContain('"workhorse-demo-worker-rust"');
    expect(developmentLauncher).toContain('"./examples/demo-worker"');
    expect(developmentLauncher).toContain('"python/examples/demo_worker.py"');
    expect(developmentLauncher).toContain('"-p", "workhorse-demo-worker"');
    expect(pythonWorker).toContain('SCHEDULE_NAMESPACE = "workhorse-demo"');
    expect(pythonWorker).toContain(
      `FAST_TIER_SCHEDULE_NAMESPACE = "${DEMO_FAST_TIER_SCHEDULE_NAMESPACE}"`,
    );
    expect(pythonWorker).toContain(`PYTHON_FAST_QUEUE = "${DEMO_PYTHON_FAST_QUEUE}"`);
    expect(pythonWorker).toContain("queues=(PYTHON_QUEUE, SHARED_QUEUE, PYTHON_FAST_QUEUE)");
    expect(pythonWorker).toContain(
      "schedule_namespaces=(SCHEDULE_NAMESPACE, FAST_TIER_SCHEDULE_NAMESPACE)",
    );
    expect(goWorker).toContain('scheduleNamespace         = "workhorse-demo"');
    expect(goWorker).toContain(
      `fastTierScheduleNamespace = "${DEMO_FAST_TIER_SCHEDULE_NAMESPACE}"`,
    );
    expect(goWorker).toContain(`goFastQueue               = "${DEMO_GO_FAST_QUEUE}"`);
    expect(goWorker).toContain("[]string{goQueue, sharedQueue, goFastQueue}");
    expect(goWorker).toContain(
      "ScheduleNamespaces:  []string{scheduleNamespace, fastTierScheduleNamespace}",
    );
    expect(rustWorker).toContain('pub const SCHEDULE_NAMESPACE: &str = "workhorse-demo";');
    expect(rustWorker).toContain(
      `pub const FAST_TIER_SCHEDULE_NAMESPACE: &str = "${DEMO_FAST_TIER_SCHEDULE_NAMESPACE}";`,
    );
    expect(rustWorker).toContain(`pub const RUST_QUEUE: &str = "${DEMO_RUST_QUEUE}";`);
    expect(rustWorker).toContain(`pub const RUST_FAST_QUEUE: &str = "${DEMO_RUST_FAST_QUEUE}";`);
    expect(rustWorker).toContain(`pub const SHARED_QUEUE: &str = "${DEMO_SHARED_QUEUE}";`);
    expect(rustWorker).toContain(
      "queues: vec![RUST_QUEUE.into(), SHARED_QUEUE.into(), RUST_FAST_QUEUE.into()]",
    );
    expect(rustWorker).toContain(
      "SCHEDULE_NAMESPACE.into(),\n                FAST_TIER_SCHEDULE_NAMESPACE.into(),",
    );
    // In development each worker waits out a missing schema instead of failing before the server
    // installs it. Production keeps a read-only startup and refuses at once.
    expect(rustWorker).toContain("CompatibilityCode::SchemaNotInstalled");
    expect(rustWorker).toContain('Some("development") => Ok(true)');
    expect(pythonWorker).toContain('error.code != "schema-not-installed"');
    expect(pythonWorker).toContain('return mode == "development"');
    expect(goWorker).toContain("compatibility.Code != workhorse.SchemaNotInstalled");
    expect(goWorker).toContain('case "development":');
  });

  it("enforces the shared handler contract in TypeScript", () => {
    expect(sharedWorkerTask({ source: "schedule" }, 3)).toEqual({
      source: "schedule",
      runtime: "node",
      attempt: 3,
    });
    expect(() => sharedWorkerTask({ source: 123 }, 1)).toThrow("Shared worker requires a source");
  });
});
