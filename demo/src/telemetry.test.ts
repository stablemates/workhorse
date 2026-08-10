import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("demo telemetry preload", () => {
  it("places the tsx watch subcommand before Node preload options", async () => {
    const manifest = JSON.parse(await readFile(resolve("demo/package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts["dev:server"]).toContain(
      "tsx watch --require ./telemetry.cjs src/index.ts",
    );
    expect(manifest.scripts["dev:worker"]).toContain(
      "tsx watch --require ./telemetry.cjs src/worker-main.ts",
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
      readFile(resolve("demo/src/index.ts"), "utf8"),
      readFile(resolve("demo/src/app.ts"), "utf8"),
      readFile(resolve("demo/src/worker.ts"), "utf8"),
    ]);

    expect(index).toContain("startDemoMetricsObserver(pool)");
    expect(index).not.toContain("workhorse.context.queue");
    expect(app).not.toContain("recordMaintenanceTelemetry");
    expect(worker).not.toContain("recordMaintenanceTelemetry");
  });

  it("exports structured logs to the same OTLP collector", async () => {
    const preload = await readFile(resolve("demo/telemetry.cjs"), "utf8");
    const [index, worker] = await Promise.all([
      readFile(resolve("demo/src/index.ts"), "utf8"),
      readFile(resolve("demo/src/worker.ts"), "utf8"),
    ]);

    expect(preload).toContain('process.env.OTEL_LOGS_EXPORTER ??= "otlp"');
    expect(preload).toContain(
      'process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://127.0.0.1:4318"',
    );
    expect(index).toContain("demoLogger.info");
    expect(worker).toContain("demoLogger.error");
  });

  it("exports OTLP logs with service metadata and active trace correlation", async () => {
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
    await new Promise<void>((resolveListening) =>
      collector.listen(0, "127.0.0.1", resolveListening),
    );
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
        ["--require", resolve("demo/telemetry.cjs"), "-e", script],
        {
          env: {
            ...process.env,
            WORKHORSE_DEMO_TELEMETRY: "true",
            WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-log-smoke",
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
            OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
            OTEL_LOGS_EXPORTER: "otlp",
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
    } finally {
      await new Promise<void>((resolveClosed, rejectClosed) =>
        collector.close((error) => (error ? rejectClosed(error) : resolveClosed())),
      );
    }
  }, 10_000);
});
