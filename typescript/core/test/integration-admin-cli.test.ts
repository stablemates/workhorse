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

describe("admin CLI durable-handler reads", () => {
  it("lists one job's checkpoints, and one of them by name", async () => {
    const jobId = await queue.enqueue("checkpointed.import", {});
    const job = await queue.claim("cli-checkpoint-worker");
    await queue.saveCheckpoint(job!, "cli-checkpoint-worker", "extracted", { rows: 120 });
    await queue.saveCheckpoint(job!, "cli-checkpoint-worker", "transformed", { rows: 118 });

    const list = runAdmin(["checkpoints", jobId, "--json"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([
      expect.objectContaining({ jobId, name: "extracted", value: { rows: 120 } }),
      expect.objectContaining({ jobId, name: "transformed", value: { rows: 118 } }),
    ]);

    const one = runAdmin(["checkpoints", jobId, "--name", "transformed", "--json"]);
    expect(one.code).toBe(0);
    expect(JSON.parse(one.stdout)).toMatchObject({
      jobId,
      name: "transformed",
      value: { rows: 118 },
      attempt: 1,
      workerId: "cli-checkpoint-worker",
    });

    const table = runAdmin(["checkpoints", jobId]);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("extracted");
    expect(table.stdout).toContain("transformed");
  });

  it("lists one job's durable timer waits, and one of them by name", async () => {
    const jobId = await queue.enqueue("cooling.off", {});
    const job = await queue.claim("cli-wait-worker", { leaseMs: 10_000 });
    await queue.scheduleWait(job!, "cli-wait-worker", "provider-cooldown", { durationMs: 5_000 });

    const list = runAdmin(["waits", jobId, "--json"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([
      expect.objectContaining({ jobId, name: "provider-cooldown", mode: "relative" }),
    ]);

    const one = runAdmin(["waits", jobId, "--name", "provider-cooldown", "--json"]);
    expect(one.code).toBe(0);
    expect(JSON.parse(one.stdout)).toMatchObject({
      jobId,
      name: "provider-cooldown",
      durationMs: 5_000,
      workerId: "cli-wait-worker",
    });

    const table = runAdmin(["waits", jobId]);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("provider-cooldown");
  });

  it("exits 1 for a checkpoint or wait name the job never recorded", async () => {
    const jobId = await queue.enqueue("nothing.saved", {});
    const checkpoint = runAdmin(["checkpoints", jobId, "--name", "missing"]);
    expect(checkpoint.code).toBe(1);
    expect(checkpoint.stderr).toContain("no checkpoint named missing");

    const wait = runAdmin(["waits", jobId, "--name", "missing"]);
    expect(wait.code).toBe(1);
    expect(wait.stderr).toContain("no wait named missing");
  });

  it("lists pending human decisions and signal waits across the fleet", async () => {
    const humanId = await queue.enqueue("account.review", {});
    const humanJob = await queue.claim("cli-human-worker", { leaseMs: 10_000 });
    await queue.waitForHuman(humanJob!, "cli-human-worker", "approval", {
      prompt: "Approve this account?",
    });
    const signalId = await queue.enqueue("webhook.await", {});
    const signalJob = await queue.claim("cli-signal-worker", { leaseMs: 10_000 });
    await queue.waitForSignal(signalJob!, "cli-signal-worker", "provider-callback");

    const result = runAdmin(["external-waits", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      human: {
        items: [
          expect.objectContaining({
            jobId: humanId,
            name: "approval",
            jobType: "account.review",
            context: { prompt: "Approve this account?" },
          }),
        ],
        nextCursor: null,
      },
      signal: {
        items: [
          expect.objectContaining({
            jobId: signalId,
            name: "provider-callback",
            jobType: "webhook.await",
          }),
        ],
        nextCursor: null,
      },
    });

    const table = runAdmin(["external-waits"]);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("human");
    expect(table.stdout).toContain("approval");
    expect(table.stdout).toContain("signal");
    expect(table.stdout).toContain("provider-callback");
  });

  it("pages external waits with the cursor the dashboard uses", async () => {
    const first = await queue.enqueue("account.review", { order: 1 });
    const firstJob = await queue.claim("cli-page-worker-1", { leaseMs: 10_000 });
    await queue.waitForHuman(firstJob!, "cli-page-worker-1", "approval", { order: 1 });
    const second = await queue.enqueue("account.review", { order: 2 });
    const secondJob = await queue.claim("cli-page-worker-2", { leaseMs: 10_000 });
    await queue.waitForHuman(secondJob!, "cli-page-worker-2", "approval", { order: 2 });

    const page = runAdmin(["external-waits", "--limit", "1", "--json"]);
    expect(page.code).toBe(0);
    const parsed = JSON.parse(page.stdout) as {
      human: { items: Array<{ jobId: string }>; nextCursor: Record<string, string> };
    };
    expect(parsed.human.items.map((item) => item.jobId)).toEqual([first]);
    expect(parsed.human.nextCursor).toMatchObject({ jobId: first, name: "approval" });

    const next = runAdmin([
      "external-waits",
      "--limit",
      "1",
      "--human-cursor",
      JSON.stringify(parsed.human.nextCursor),
      "--json",
    ]);
    expect(next.code).toBe(0);
    const following = JSON.parse(next.stdout) as { human: { items: Array<{ jobId: string }> } };
    expect(following.human.items.map((item) => item.jobId)).toEqual([second]);
  });

  it("rejects a cursor that is not the printed continuation object", () => {
    const result = runAdmin(["external-waits", "--human-cursor", '{"jobId":"only"}']);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("--human-cursor must be a JSON");
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

  it("purges a queue and reports the deleted count", async () => {
    const queueName = "cli-purge";
    const first = await queue.enqueue("purge.me", {}, { queue: queueName });
    const second = await queue.enqueue("purge.me", {}, { queue: queueName });
    const result = runAdmin([
      "purge",
      queueName,
      "--env",
      databaseName,
      "--reason",
      "drain the poisoned backlog",
      "--request-id",
      "cli-purge-request",
      "--yes",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ queue: queueName, deletedCount: 2 });
    expect(await admin.getJob(first)).toBeNull();
    expect(await admin.getJob(second)).toBeNull();
  });

  it("refuses a purge that reuses a request identity with a different reason", async () => {
    const queueName = "cli-purge-conflict";
    await queue.enqueue("purge.me", {}, { queue: queueName });
    const purge = (reason: string) =>
      runAdmin([
        "purge",
        queueName,
        "--env",
        databaseName,
        "--reason",
        reason,
        "--request-id",
        "cli-purge-conflict-request",
        "--yes",
      ]);
    expect(purge("first destructive request")).toMatchObject({ code: 0 });

    const conflict = purge("a different destructive request");
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain(`Refused: Queue purge conflict for ${queueName}`);
  });

  it("requires --reason and confirmation before purging", async () => {
    const queueName = "cli-purge-guarded";
    const jobId = await queue.enqueue("purge.me", {}, { queue: queueName });

    const noReason = runAdmin(["purge", queueName, "--env", databaseName, "--yes"]);
    expect(noReason.code).toBe(64);
    expect(noReason.stderr).toContain("requires --reason");

    const noConfirmation = runAdmin([
      "purge",
      queueName,
      "--env",
      databaseName,
      "--reason",
      "drain the poisoned backlog",
    ]);
    expect(noConfirmation.code).toBe(64);
    expect(noConfirmation.stderr).toContain("requires --yes");
    expect((await admin.getJob(jobId))?.state).toBe("ready");
  });

  it("pauses and resumes one registered worker through the durable registry", async () => {
    const workerId = "cli-pause-worker";
    const instanceId = "0f4c2b18-3f57-4a52-9f0d-2b0b7f2f1a11";
    const register = () =>
      queue.registerWorker({
        workerId,
        instanceId,
        hostname: "host-cli",
        pid: 5150,
        concurrency: 2,
        activeSlots: 0,
        draining: false,
      });
    await register();

    const paused = runAdmin([
      "pause-worker",
      workerId,
      "--env",
      databaseName,
      "--reason",
      "worker is thrashing",
      "--yes",
      "--json",
    ]);
    expect(paused.code).toBe(0);
    expect(JSON.parse(paused.stdout)).toMatchObject({
      workerId,
      paused: true,
      pausedBy: "workhorse-admin",
      reason: "worker is thrashing",
    });

    // The pause is a registry row, not a signal to a connected process: the same worker learns
    // about it on its next registration heartbeat, and the fleet view reports it meanwhile.
    expect(await register()).toEqual({ paused: true });
    const listed = JSON.parse(runAdmin(["workers", "--json"]).stdout) as Array<{
      workerId: string;
      paused: boolean;
    }>;
    expect(listed).toEqual(
      expect.arrayContaining([expect.objectContaining({ workerId, paused: true })]),
    );

    const resumed = runAdmin([
      "resume-worker",
      workerId,
      "--env",
      databaseName,
      "--reason",
      "worker settled",
      "--yes",
    ]);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain(`Resumed worker ${workerId}`);
    expect(await register()).toEqual({ paused: false });
  });

  it("exits 1 when pausing a worker that is not registered", () => {
    const result = runAdmin([
      "pause-worker",
      "worker-that-aged-out",
      "--env",
      databaseName,
      "--reason",
      "wrong worker id",
      "--yes",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is not registered");
  });

  it("requires --reason, --env, and confirmation before pausing a worker", async () => {
    const workerId = "cli-guarded-worker";
    const instanceId = "6a1de0c4-9b25-4f18-8c74-b6a0d5f31c27";
    const registration = {
      workerId,
      instanceId,
      hostname: "host-cli",
      pid: 5151,
      concurrency: 1,
      activeSlots: 0,
      draining: false,
    };
    await queue.registerWorker(registration);

    const noReason = runAdmin(["pause-worker", workerId, "--env", databaseName, "--yes"]);
    expect(noReason.code).toBe(64);
    expect(noReason.stderr).toContain("requires --reason");

    const noEnvironment = runAdmin(["pause-worker", workerId, "--reason", "no target", "--yes"]);
    expect(noEnvironment.code).toBe(64);
    expect(noEnvironment.stderr).toContain("requires --env");

    const noConfirmation = runAdmin([
      "pause-worker",
      workerId,
      "--env",
      databaseName,
      "--reason",
      "no confirmation",
    ]);
    expect(noConfirmation.code).toBe(64);
    expect(noConfirmation.stderr).toContain("requires --yes");

    expect(await queue.registerWorker(registration)).toEqual({ paused: false });
  });
});

describe("tui command", () => {
  it("refuses to start without an interactive terminal", () => {
    const result = runCli(["tui", "--database-url", databaseUrl]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("requires an interactive terminal");
  });
});
