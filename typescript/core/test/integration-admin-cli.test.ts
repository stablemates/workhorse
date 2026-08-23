import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createIntegrationTestContext } from "./support/integration.js";

const repository = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(repository, "typescript/core/src/cli/workhorse.ts");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const { createFailedJob, databaseUrl, queue, admin } = createIntegrationTestContext(
  import.meta.url,
);
const databaseName = new URL(databaseUrl).pathname.slice(1);

function runCli(args: readonly string[]) {
  const result = spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd: repository,
    env: process.env,
    encoding: "utf8",
    input: "",
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAdmin(args: readonly string[]) {
  return runCli(["admin", ...args, "--database-url", databaseUrl]);
}

describe("admin CLI inspection", () => {
  it("lists jobs with lifecycle filters as JSON", async () => {
    const jobId = await queue.enqueue("report.build", { day: "2026-08-18" });
    const result = runAdmin(["jobs", "--json", "--state", "ready", "--queue", "default"]);
    expect(result.code).toBe(0);
    const page = JSON.parse(result.stdout) as {
      items: Array<{ id: string; state: string; type: string }>;
    };
    expect(page.items.map((item) => item.id)).toContain(jobId);
    expect(runAdmin(["jobs", "--json", "--state", "succeeded"]).stdout).not.toContain(jobId);
  });

  it("shows one job snapshot and its timeline", async () => {
    const jobId = await queue.enqueue("email.send", { to: "operator@example.com" });
    const detail = runAdmin(["job", jobId, "--json"]);
    expect(detail.code).toBe(0);
    expect(JSON.parse(detail.stdout)).toMatchObject({
      id: jobId,
      state: "ready",
      type: "email.send",
    });
    const human = runAdmin(["job", jobId]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("email.send");

    const timeline = runAdmin(["timeline", jobId, "--json"]);
    expect(timeline.code).toBe(0);
    expect(
      (JSON.parse(timeline.stdout) as { items: Array<{ kind: string }> }).items.length,
    ).toBeGreaterThan(0);
  });

  it("exits 1 for a missing job", () => {
    const result = runAdmin(["job", "00000000-0000-0000-0000-000000000000"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("lists dead letters, queues, schedules, workers, and maintenance state", async () => {
    const failedId = await createFailedJob({ type: "import.run", errorName: "ImportError" });
    await queue.syncSchedules("reports", [
      {
        name: "nightly",
        schedule: "0 3 * * *",
        job: { type: "report.build", payload: {} },
      },
    ]);
    await queue.registerWorker({
      workerId: "worker-1",
      instanceId: "5b160e29-4dd8-4c31-a25c-40be727a4bb9",
      hostname: "host-a",
      pid: 4242,
      concurrency: 4,
      activeSlots: 1,
      draining: false,
    });

    const failures = runAdmin(["failures", "--json"]);
    expect(failures.code).toBe(0);
    expect(JSON.parse(failures.stdout).items[0]).toMatchObject({
      jobId: failedId,
      type: "import.run",
    });

    const queues = runAdmin(["queues", "--json"]);
    expect(queues.code).toBe(0);
    expect(JSON.parse(queues.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ queue: "default", paused: false })]),
    );

    const schedules = runAdmin(["schedules", "--json"]);
    expect(schedules.code).toBe(0);
    expect(JSON.parse(schedules.stdout)).toEqual([
      expect.objectContaining({ namespace: "reports", name: "nightly", schedule: "0 3 * * *" }),
    ]);

    const workers = runAdmin(["workers"]);
    expect(workers.code).toBe(0);
    expect(workers.stdout).toContain("worker-1");
    expect(workers.stdout).toContain("host-a");

    const maintenance = runAdmin(["maintenance", "--json"]);
    expect(maintenance.code).toBe(0);
    expect(JSON.parse(maintenance.stdout)).toMatchObject({
      maintenancePolicy: { timezone: "UTC" },
      retentionPolicy: { jobIdentityRetentionDays: 14 },
    });
  });
});

describe("admin CLI guarded operations", () => {
  it("requires an explicit --env for every mutation", async () => {
    const jobId = await queue.enqueue("cancel.me", {});
    const result = runAdmin(["cancel", jobId, "--yes"]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("requires --env");
    expect((await admin.getJob(jobId))?.state).toBe("ready");
  });

  it("refuses an --env that does not name the connected database", async () => {
    const jobId = await queue.enqueue("cancel.me", {});
    const result = runAdmin(["cancel", jobId, "--env", "workhorse_production", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`does not match the connected database "${databaseName}"`);
    expect((await admin.getJob(jobId))?.state).toBe("ready");
  });

  it("requires --yes when no interactive confirmation is possible", async () => {
    const jobId = await queue.enqueue("cancel.me", {});
    const result = runAdmin(["cancel", jobId, "--env", databaseName]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("requires --yes");
    expect((await admin.getJob(jobId))?.state).toBe("ready");
  });

  it("cancels a job with attribution once confirmed", async () => {
    const jobId = await queue.enqueue("cancel.me", {});
    const result = runAdmin([
      "cancel",
      jobId,
      "--env",
      databaseName,
      "--yes",
      "--actor",
      "oncall",
      "--reason",
      "bad payload",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "canceled",
      jobId,
      requestedBy: "oncall",
      reason: "bad payload",
    });
    expect((await admin.getJob(jobId))?.state).toBe("canceled");
  });

  it("redrives a terminal failure into a new job", async () => {
    const failedId = await createFailedJob({ type: "import.run" });
    const result = runAdmin([
      "redrive",
      failedId,
      "--env",
      databaseName,
      "--yes",
      "--reason",
      "upstream fixed",
      "--json",
    ]);
    expect(result.code).toBe(0);
    const redrive = JSON.parse(result.stdout) as { status: string; targetJobId: string };
    expect(redrive.status).toBe("redriven");
    expect((await admin.getJob(redrive.targetJobId))?.state).toBe("ready");
  });

  it("exits 1 when redriving a job that is not a terminal failure", async () => {
    const jobId = await queue.enqueue("still.ready", {});
    const result = runAdmin([
      "redrive",
      jobId,
      "--env",
      databaseName,
      "--yes",
      "--reason",
      "mistake",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not a terminal failure");
  });

  it("pauses and resumes a queue durably", async () => {
    const paused = runAdmin([
      "pause",
      "default",
      "--env",
      databaseName,
      "--reason",
      "incident response",
      "--yes",
    ]);
    expect(paused).toMatchObject({ code: 0 });
    expect(paused.stdout).toContain("Paused queue default");
    expect(JSON.parse(runAdmin(["queues", "--json"]).stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ queue: "default", paused: true })]),
    );

    const resumed = runAdmin([
      "resume",
      "default",
      "--env",
      databaseName,
      "--reason",
      "incident resolved",
      "--yes",
    ]);
    expect(resumed.code).toBe(0);
    expect(JSON.parse(runAdmin(["queues", "--json"]).stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ queue: "default", paused: false })]),
    );
  });
});

describe("tui command", () => {
  it("refuses to start without an interactive terminal", () => {
    const result = runCli(["tui", "--database-url", databaseUrl]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("requires an interactive terminal");
  });
});
