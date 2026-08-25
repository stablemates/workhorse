import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const demoDirectory = resolve("typescript/demo");

describe("demo telemetry preload", () => {
  it("places the tsx watch subcommand before Node preload options", async () => {
    const manifest = JSON.parse(
      await readFile(resolve("typescript/demo/package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts["dev:server"]).toContain(
      "tsx watch --conditions workhorse-source --require ./telemetry.cjs src/index.ts",
    );
    expect(manifest.scripts["dev:worker"]).toContain(
      "tsx watch --conditions workhorse-source --require ./telemetry.cjs src/worker-main.ts",
    );
  });

  it("keeps telemetry opt-in at the root demo command", async () => {
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts.demo).not.toContain("WORKHORSE_DEMO_TELEMETRY");
    expect(manifest.scripts["demo:otel"]).toBe(
      "pnpm signoz:up && WORKHORSE_DEMO_TELEMETRY=true pnpm demo",
    );
    expect(manifest.scripts["signoz:up"]).toContain("scripts/signoz-portless.ts add");
    expect(manifest.scripts["signoz:down"]).toContain("scripts/signoz-portless.ts remove");
  });

  it("runs database-wide metric observations only in the web process", async () => {
    const [index, app, worker] = await Promise.all([
      readFile(resolve("typescript/demo/src/index.ts"), "utf8"),
      readFile(resolve("typescript/demo/src/app.ts"), "utf8"),
      readFile(resolve("typescript/demo/src/worker.ts"), "utf8"),
    ]);

    expect(index).toContain("startDemoMetricsObserver(pool)");
    expect(index).not.toContain("workhorse.context.queue");
    expect(app).not.toContain("recordMaintenanceTelemetry");
    expect(worker).not.toContain("recordMaintenanceTelemetry");
  });

  it("uses one log pipeline for local files and optional OTLP export", async () => {
    const preload = await readFile(resolve("typescript/demo/telemetry.cjs"), "utf8");
    const [index, worker] = await Promise.all([
      readFile(resolve("typescript/demo/src/index.ts"), "utf8"),
      readFile(resolve("typescript/demo/src/worker.ts"), "utf8"),
    ]);

    expect(preload).toContain("new RotatingFileLogExporter");
    expect(preload).toContain('resolve(__dirname, "..", "..", "logs")');
    expect(preload.match(/new OTLPLogExporter/g)).toHaveLength(1);
    expect(preload).not.toContain("auto-instrumentations-node/register");
    expect(preload).toContain(
      'process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://127.0.0.1:4318"',
    );
    expect(index).toContain("demoLogger.info");
    expect(worker).toContain("demoLogger.error");
  });

  it("writes structured logs locally without enabling OTLP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workhorse-demo-logs-"));
    const script = `
      const { logs, SeverityNumber } = require("@opentelemetry/api-logs");
      logs.getLogger("demo-file-smoke").emit({
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        eventName: "workhorse.demo.file_smoke",
        body: "Demo file smoke test",
        attributes: { "workhorse.demo.test": true }
      });
    `;
    try {
      await execFileAsync(
        process.execPath,
        ["--require", resolve("typescript/demo/telemetry.cjs"), "-e", script],
        {
          cwd: demoDirectory,
          env: {
            ...process.env,
            WORKHORSE_DEMO_TELEMETRY: "false",
            WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-file-smoke",
            WORKHORSE_DEMO_ENV: "test",
            WORKHORSE_DEMO_LOG_DIRECTORY: directory,
            OTEL_TRACES_EXPORTER: "none",
            OTEL_METRICS_EXPORTER: "none",
            OTEL_BLRP_SCHEDULE_DELAY: "10",
          },
        },
      );

      const contents = await readFile(
        join(directory, "test", "workhorse-demo-file-smoke.ndjson"),
        "utf8",
      );
      const record = JSON.parse(contents.trim()) as Record<string, unknown>;
      expect(record).toMatchObject({
        severityText: "INFO",
        eventName: "workhorse.demo.file_smoke",
        body: "Demo file smoke test",
        attributes: { "workhorse.demo.test": true },
        resource: {
          "service.name": "workhorse-demo-file-smoke",
          "deployment.environment.name": "test",
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("flushes records emitted by application shutdown handlers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workhorse-demo-log-shutdown-"));
    const script = `
      const { logs, SeverityNumber } = require("@opentelemetry/api-logs");
      const keepAlive = setInterval(() => {}, 1_000);
      process.once("SIGTERM", () => {
        logs.getLogger("demo-file-shutdown").emit({
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
          eventName: "workhorse.demo.shutdown_completed",
          body: "Demo shutdown completed"
        });
        clearInterval(keepAlive);
      });
      process.stdout.write("ready\\n");
    `;
    const child = spawn(
      process.execPath,
      ["--require", resolve("typescript/demo/telemetry.cjs"), "-e", script],
      {
        cwd: demoDirectory,
        env: {
          ...process.env,
          WORKHORSE_DEMO_TELEMETRY: "false",
          WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-shutdown-smoke",
          WORKHORSE_DEMO_ENV: "test",
          WORKHORSE_DEMO_LOG_DIRECTORY: directory,
          OTEL_TRACES_EXPORTER: "none",
          OTEL_METRICS_EXPORTER: "none",
          OTEL_BLRP_SCHEDULE_DELAY: "10",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        child.once("error", rejectReady);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (chunk.includes("ready")) resolveReady();
        });
      });
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code, signal) => {
          if (code === 0) resolveExit();
          else rejectExit(new Error(`Telemetry child exited with code ${code}, signal ${signal}`));
        });
      });

      const contents = await readFile(
        join(directory, "test", "workhorse-demo-shutdown-smoke.ndjson"),
        "utf8",
      );
      expect(contents).toContain("workhorse.demo.shutdown_completed");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rotates local logs and bounds retained archives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workhorse-demo-log-rotation-"));
    const script = `
      const { logs, SeverityNumber } = require("@opentelemetry/api-logs");
      const logger = logs.getLogger("demo-file-rotation");
      for (let sequence = 0; sequence < 20; sequence += 1) {
        logger.emit({
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
          eventName: "workhorse.demo.rotation_smoke",
          body: "x".repeat(100),
          attributes: { sequence }
        });
      }
    `;
    try {
      await execFileAsync(
        process.execPath,
        ["--require", resolve("typescript/demo/telemetry.cjs"), "-e", script],
        {
          cwd: demoDirectory,
          env: {
            ...process.env,
            WORKHORSE_DEMO_TELEMETRY: "false",
            WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-rotation-smoke",
            WORKHORSE_DEMO_ENV: "test",
            WORKHORSE_DEMO_LOG_DIRECTORY: directory,
            WORKHORSE_DEMO_LOG_MAX_BYTES: "800",
            WORKHORSE_DEMO_LOG_ARCHIVES: "2",
            OTEL_TRACES_EXPORTER: "none",
            OTEL_METRICS_EXPORTER: "none",
            OTEL_BLRP_SCHEDULE_DELAY: "10",
          },
        },
      );

      const files = await readdir(join(directory, "test"));
      expect(files).toHaveLength(3);
      expect(files).toEqual(
        expect.arrayContaining([
          "workhorse-demo-rotation-smoke.ndjson",
          "workhorse-demo-rotation-smoke.ndjson.1",
          "workhorse-demo-rotation-smoke.ndjson.2",
        ]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exports OTLP logs with service metadata and active trace correlation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workhorse-demo-otlp-logs-"));
    let resolvePayload!: (payload: Record<string, unknown>) => void;
    const payload = new Promise<Record<string, unknown>>((resolvePayloadPromise) => {
      resolvePayload = resolvePayloadPromise;
    });
    const collector = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        resolvePayload(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolveListening) => {
      collector.listen(0, "127.0.0.1", resolveListening);
    });
    const address = collector.address();
    if (!address || typeof address === "string")
      throw new Error("OTLP test collector did not listen");
    const script = `
      const { trace } = require("@opentelemetry/api");
      const { logs, SeverityNumber } = require("@opentelemetry/api-logs");
      trace.getTracer("demo-log-smoke").startActiveSpan("demo-log-smoke", (span) => {
        logs.getLogger("demo-log-smoke").emit({
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
          eventName: "workhorse.demo.log_smoke",
          body: "Demo log smoke test"
        });
        span.end();
      });
    `;
    try {
      await execFileAsync(
        process.execPath,
        ["--require", resolve("typescript/demo/telemetry.cjs"), "-e", script],
        {
          cwd: demoDirectory,
          env: {
            ...process.env,
            WORKHORSE_DEMO_TELEMETRY: "true",
            WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-log-smoke",
            WORKHORSE_DEMO_LOG_DIRECTORY: directory,
            WORKHORSE_DEMO_ENV: "test",
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
            OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
            OTEL_TRACES_EXPORTER: "console",
            OTEL_METRICS_EXPORTER: "none",
            OTEL_NODE_RESOURCE_DETECTORS: "env",
            OTEL_BLRP_SCHEDULE_DELAY: "10",
          },
        },
      );
      const exported = JSON.stringify(await payload);
      expect(exported).toContain('"service.name"');
      expect(exported).toContain("workhorse-demo-log-smoke");
      expect(exported).toContain("workhorse.demo.log_smoke");
      expect(exported).toMatch(/"traceId":"[0-9a-f]{32}"/);
      const local = await readFile(
        join(directory, "test", "workhorse-demo-log-smoke.ndjson"),
        "utf8",
      );
      expect(local).toContain("workhorse.demo.log_smoke");
      expect(local).toMatch(/"traceId":"[0-9a-f]{32}"/);
    } finally {
      await new Promise<void>((resolveClosed, rejectClosed) => {
        collector.close((error) => (error ? rejectClosed(error) : resolveClosed()));
      });
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
