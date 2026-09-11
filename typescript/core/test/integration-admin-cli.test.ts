import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createIntegrationTestContext } from "./support/integration.js";

const repository = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(repository, "typescript/core/src/cli/workhorse.ts");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const { createFailedTask, databaseUrl, queue, admin } = createIntegrationTestContext(
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
  it("lists tasks with lifecycle filters as JSON", async () => {
    const taskId = await queue.enqueue("report.build", { day: "2026-08-18" });
    const result = runAdmin(["tasks", "--json", "--state", "ready", "--queue", "default"]);
    expect(result.code).toBe(0);
    const page = JSON.parse(result.stdout) as {
      items: Array<{ id: string; state: string; type: string }>;
    };
    expect(page.items.map((item) => item.id)).toContain(taskId);
    expect(runAdmin(["tasks", "--json", "--state", "succeeded"]).stdout).not.toContain(taskId);
  });

  it("shows one task snapshot and its timeline", async () => {
    const taskId = await queue.enqueue("email.send", { to: "operator@example.com" });
    const detail = runAdmin(["task", taskId, "--json"]);
    expect(detail.code).toBe(0);
    expect(JSON.parse(detail.stdout)).toMatchObject({
      id: taskId,
      state: "ready",
      type: "email.send",
    });
    const human = runAdmin(["task", taskId]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("email.send");

    const timeline = runAdmin(["timeline", taskId, "--json"]);
    expect(timeline.code).toBe(0);
    expect(
      (JSON.parse(timeline.stdout) as { items: Array<{ kind: string }> }).items.length,
    ).toBeGreaterThan(0);
  });

  it("exits 1 for a missing task", () => {
    const result = runAdmin(["task", "00000000-0000-0000-0000-000000000000"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("lists dead letters, queues, schedules, workers, and maintenance state", async () => {
    const failedId = await createFailedTask({ type: "import.run", errorName: "ImportError" });
    await queue.syncSchedules("reports", [
      {
        name: "nightly",
        schedule: "0 3 * * *",
        task: { type: "report.build", payload: {} },
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
      taskId: failedId,
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
      retentionPolicy: { taskIdentityRetentionDays: 14 },
    });
  });
});

describe("admin CLI durable-handler reads", () => {
  it("lists one task's checkpoints, and one of them by name", async () => {
    const taskId = await queue.enqueue("checkpointed.import", {});
    const task = await queue.claim("cli-checkpoint-worker");
    await queue.saveCheckpoint(task!, "cli-checkpoint-worker", "extracted", { rows: 120 });
    await queue.saveCheckpoint(task!, "cli-checkpoint-worker", "transformed", { rows: 118 });

    const list = runAdmin(["checkpoints", taskId, "--json"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([
      expect.objectContaining({ taskId, name: "extracted", value: { rows: 120 } }),
      expect.objectContaining({ taskId, name: "transformed", value: { rows: 118 } }),
    ]);

    const one = runAdmin(["checkpoints", taskId, "--name", "transformed", "--json"]);
    expect(one.code).toBe(0);
    expect(JSON.parse(one.stdout)).toMatchObject({
      taskId,
      name: "transformed",
      value: { rows: 118 },
      attempt: 1,
      workerId: "cli-checkpoint-worker",
    });

    const table = runAdmin(["checkpoints", taskId]);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("extracted");
    expect(table.stdout).toContain("transformed");
  });

  it("lists one task's durable timer waits, and one of them by name", async () => {
    const taskId = await queue.enqueue("cooling.off", {});
    const task = await queue.claim("cli-wait-worker", { leaseMs: 10_000 });
    await queue.scheduleWait(task!, "cli-wait-worker", "provider-cooldown", { durationMs: 5_000 });

    const list = runAdmin(["waits", taskId, "--json"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([
      expect.objectContaining({ taskId, name: "provider-cooldown", mode: "relative" }),
    ]);

    const one = runAdmin(["waits", taskId, "--name", "provider-cooldown", "--json"]);
    expect(one.code).toBe(0);
    expect(JSON.parse(one.stdout)).toMatchObject({
      taskId,
      name: "provider-cooldown",
      durationMs: 5_000,
      workerId: "cli-wait-worker",
    });

    const table = runAdmin(["waits", taskId]);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("provider-cooldown");
  });

  it("exits 1 for a checkpoint or wait name the task never recorded", async () => {
    const taskId = await queue.enqueue("nothing.saved", {});
    const checkpoint = runAdmin(["checkpoints", taskId, "--name", "missing"]);
    expect(checkpoint.code).toBe(1);
    expect(checkpoint.stderr).toContain("no checkpoint named missing");

    const wait = runAdmin(["waits", taskId, "--name", "missing"]);
    expect(wait.code).toBe(1);
    expect(wait.stderr).toContain("no wait named missing");
  });

  it("lists pending human decisions and signal waits across the fleet", async () => {
    const humanId = await queue.enqueue("account.review", {});
    const humanTask = await queue.claim("cli-human-worker", { leaseMs: 10_000 });
    await queue.waitForHuman(humanTask!, "cli-human-worker", "approval", {
      prompt: "Approve this account?",
    });
    const signalId = await queue.enqueue("webhook.await", {});
    const signalTask = await queue.claim("cli-signal-worker", { leaseMs: 10_000 });
    await queue.waitForSignal(signalTask!, "cli-signal-worker", "provider-callback");

    const result = runAdmin(["external-waits", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      human: {
        items: [
          expect.objectContaining({
            taskId: humanId,
            name: "approval",
            taskType: "account.review",
            context: { prompt: "Approve this account?" },
          }),
        ],
        nextCursor: null,
      },
      signal: {
        items: [
          expect.objectContaining({
            taskId: signalId,
            name: "provider-callback",
            taskType: "webhook.await",
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
    const firstTask = await queue.claim("cli-page-worker-1", { leaseMs: 10_000 });
    await queue.waitForHuman(firstTask!, "cli-page-worker-1", "approval", { order: 1 });
    const second = await queue.enqueue("account.review", { order: 2 });
    const secondTask = await queue.claim("cli-page-worker-2", { leaseMs: 10_000 });
    await queue.waitForHuman(secondTask!, "cli-page-worker-2", "approval", { order: 2 });

    const page = runAdmin(["external-waits", "--limit", "1", "--json"]);
    expect(page.code).toBe(0);
    const parsed = JSON.parse(page.stdout) as {
      human: { items: Array<{ taskId: string }>; nextCursor: Record<string, string> };
    };
    expect(parsed.human.items.map((item) => item.taskId)).toEqual([first]);
    expect(parsed.human.nextCursor).toMatchObject({ taskId: first, name: "approval" });

    const next = runAdmin([
      "external-waits",
      "--limit",
      "1",
      "--human-cursor",
      JSON.stringify(parsed.human.nextCursor),
      "--json",
    ]);
    expect(next.code).toBe(0);
    const following = JSON.parse(next.stdout) as { human: { items: Array<{ taskId: string }> } };
    expect(following.human.items.map((item) => item.taskId)).toEqual([second]);
  });

  it("rejects a cursor that is not the printed continuation object", () => {
    const result = runAdmin(["external-waits", "--human-cursor", '{"taskId":"only"}']);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("--human-cursor must be a JSON");
  });
});

describe("admin CLI guarded operations", () => {
  it("requires an explicit --env for every mutation", async () => {
    const taskId = await queue.enqueue("cancel.me", {});
    const result = runAdmin(["cancel", taskId, "--yes"]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("requires --env");
    expect((await admin.getTask(taskId))?.state).toBe("ready");
  });

  it("refuses an --env that does not name the connected database", async () => {
    const taskId = await queue.enqueue("cancel.me", {});
    const result = runAdmin(["cancel", taskId, "--env", "workhorse_production", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`does not match the connected database "${databaseName}"`);
    expect((await admin.getTask(taskId))?.state).toBe("ready");
  });

  it("requires --yes when no interactive confirmation is possible", async () => {
    const taskId = await queue.enqueue("cancel.me", {});
    const result = runAdmin(["cancel", taskId, "--env", databaseName]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("requires --yes");
    expect((await admin.getTask(taskId))?.state).toBe("ready");
  });

  it("cancels a task with attribution once confirmed", async () => {
    const taskId = await queue.enqueue("cancel.me", {});
    const result = runAdmin([
      "cancel",
      taskId,
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
      taskId,
      requestedBy: "oncall",
      reason: "bad payload",
    });
    expect((await admin.getTask(taskId))?.state).toBe("canceled");
  });

  it("redrives a terminal failure into a new task", async () => {
    const failedId = await createFailedTask({ type: "import.run" });
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
    const redrive = JSON.parse(result.stdout) as { status: string; targetTaskId: string };
    expect(redrive.status).toBe("redriven");
    expect((await admin.getTask(redrive.targetTaskId))?.state).toBe("ready");
  });

  it("exits 1 when redriving a task that is not a terminal failure", async () => {
    const taskId = await queue.enqueue("still.ready", {});
    const result = runAdmin([
      "redrive",
      taskId,
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
    expect(await admin.getTask(first)).toBeNull();
    expect(await admin.getTask(second)).toBeNull();
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
    const taskId = await queue.enqueue("purge.me", {}, { queue: queueName });

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
    expect((await admin.getTask(taskId))?.state).toBe("ready");
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

describe("admin CLI paged investigations", () => {
  it("walks tasks without skipping identities and rejects a cursor with changed filters", async () => {
    const ids = await queue.enqueueMany([
      { type: "page.me", payload: {} },
      { type: "page.me", payload: {} },
      { type: "page.me", payload: {} },
    ]);
    const args = ["tasks", "--type", "page.me", "--limit", "1", "--json"];
    const seen: string[] = [];
    let cursor: object | null = null;
    let firstCursor: object | null = null;
    do {
      const result = runAdmin([...args, ...(cursor ? ["--cursor", JSON.stringify(cursor)] : [])]);
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
      const page = JSON.parse(result.stdout);
      seen.push(...page.items.map((item: { id: string }) => item.id));
      cursor = page.nextCursor;
      firstCursor ??= cursor;
      expect(seen.length).toBeLessThanOrEqual(ids.length);
    } while (cursor);
    const wrong = runAdmin([
      "tasks",
      "--type",
      "different",
      "--cursor",
      JSON.stringify(firstCursor),
      "--json",
    ]);
    expect(wrong.code).toBe(1);
    expect(seen.toSorted()).toEqual(ids.toSorted());
    expect(runAdmin(["tasks", "--limit", "1"]).stdout).toContain("Next cursor");
    const snapshot = await admin.getTask(ids[0]!);
    expect(
      JSON.parse(
        runAdmin(["tasks", "--created-before", snapshot!.createdAt.toISOString(), "--json"]).stdout,
      ).items,
    ).toEqual([]);
  });

  it("continues a merged timeline to its final page", async () => {
    const taskId = await createFailedTask({ type: "timeline.page" });
    const expected = await admin.getTaskTimeline(taskId);
    const seen: object[] = [];
    let cursor: object | null = null;
    do {
      const result = runAdmin([
        "timeline",
        taskId,
        "--limit",
        "1",
        "--json",
        ...(cursor ? ["--cursor", JSON.stringify(cursor)] : []),
      ]);
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
      const page = JSON.parse(result.stdout);
      seen.push(...page.items);
      cursor = page.nextCursor;
      expect(seen.length).toBeLessThanOrEqual(expected.items.length);
    } while (cursor);
    // Compare the CLI's JSON representation, including stringified fence tokens and timestamps.
    expect(seen).toEqual(
      JSON.parse(
        JSON.stringify(expected.items, (_key, value) =>
          typeof value === "bigint" ? String(value) : value,
        ),
      ),
    );
  });

  it("filters and pages failures with tags, error names, and finish-time bounds", async () => {
    const lower = new Date().toISOString();
    const first = await createFailedTask({
      type: "failed.page",
      tags: ["incident", "billing"],
      errorName: "ProviderError",
    });
    const second = await createFailedTask({
      type: "failed.page",
      tags: ["incident", "billing"],
      errorName: "ProviderError",
    });
    await createFailedTask({ type: "failed.page", tags: ["incident"], errorName: "ProviderError" });
    await createFailedTask({
      type: "failed.page",
      tags: ["incident", "billing"],
      errorName: "OtherError",
    });
    const args = [
      "failures",
      "--type",
      "failed.page",
      "--tag",
      "incident",
      "--tag",
      "billing",
      "--error-name",
      "ProviderError",
      "--finished-after",
      lower,
      "--finished-before",
      new Date(Date.now() + 1000).toISOString(),
      "--limit",
      "1",
      "--json",
    ];
    const firstResult = runAdmin(args);
    expect({ code: firstResult.code, stderr: firstResult.stderr }).toEqual({ code: 0, stderr: "" });
    const page = JSON.parse(firstResult.stdout);
    expect(page.items.map((item: { taskId: string }) => item.taskId)).toEqual([second]);
    const next = runAdmin([...args, "--cursor", JSON.stringify(page.nextCursor)]);
    expect({ code: next.code, stderr: next.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(next.stdout)).toMatchObject({ items: [{ taskId: first }], nextCursor: null });
  });

  it.each([
    ["tasks", "--cursor", "null"],
    ["tasks", "--cursor", '{"createdAt":"date","taskId":"id"}'],
    ["failures", "--cursor", "[]"],
    ["tasks", "--created-after", "yesterday"],
    ["tasks", "--created-after", "2026-09-07T12:00:00"],
    [
      "failures",
      "--finished-after",
      "2026-09-08T00:00:00Z",
      "--finished-before",
      "2026-09-07T00:00:00Z",
    ],
    ["tasks", "--limit", "1001"],
    ["redrive", "unused", "--dry-run"],
    ["redrive-many", "--state", "failed"],
    ["tasks", "unexpected"],
  ])("rejects malformed or inapplicable options: %j", (...args) => {
    expect(runAdmin(args).code).toBe(64);
  });
});

describe("admin CLI bulk recovery", () => {
  it("previews without writes, executes oldest-first, replays, and continues", async () => {
    const first = await createFailedTask({
      type: "bulk.recover",
      tags: ["incident"],
      errorName: "ProviderError",
    });
    const second = await createFailedTask({
      type: "bulk.recover",
      tags: ["incident"],
      errorName: "ProviderError",
    });
    const excluded = await createFailedTask({ type: "bulk.recover", errorName: "OtherError" });
    const args = [
      "redrive-many",
      "--queue",
      "default",
      "--type",
      "bulk.recover",
      "--tag",
      "incident",
      "--error-name",
      "ProviderError",
      "--limit",
      "1",
      "--reason",
      "provider restored",
      "--request-id",
      "bulk-cli-recovery",
      "--json",
    ];
    const before = await admin.getTaskTimeline(first);
    const preview = runAdmin([...args, "--dry-run"]);
    expect({ code: preview.code, stderr: preview.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(preview.stdout)).toMatchObject({
      results: [{ sourceTaskId: first, targetTaskId: null, status: "eligible" }],
    });
    expect((await admin.getRedriveLineage(first)).records).toEqual([]);
    expect(await admin.getTaskTimeline(first)).toEqual(before);
    const execute = [...args, "--env", databaseName, "--yes"];
    const result = runAdmin(execute);
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    const page = JSON.parse(result.stdout);
    expect(page.results).toEqual([
      expect.objectContaining({ sourceTaskId: first, status: "redriven" }),
    ]);
    expect((await admin.getTask(page.results[0].targetTaskId))?.state).toBe("ready");
    const replay = runAdmin(execute);
    expect({ code: replay.code, stderr: replay.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(replay.stdout).results).toEqual([
      expect.objectContaining({ targetTaskId: page.results[0].targetTaskId, status: "replayed" }),
    ]);
    const next = runAdmin([...execute, "--cursor", JSON.stringify(page.nextCursor)]);
    expect({ code: next.code, stderr: next.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(next.stdout)).toMatchObject({
      results: [{ sourceTaskId: second, status: "redriven" }],
      nextCursor: null,
    });
    expect((await admin.getRedriveLineage(excluded)).records).toEqual([]);
    expect((await admin.getTask(first))?.state).toBe("failed");
    const changed = runAdmin(
      execute.map((arg) => (arg === "provider restored" ? "changed reason" : arg)),
    );
    expect(changed.code).toBe(1);
    expect((await admin.getRedriveLineage(first)).records).toHaveLength(1);
  });

  it("requires a replay identity, environment, and confirmation before bulk writes", async () => {
    const taskId = await createFailedTask({ type: "guarded.bulk" });
    const args = ["redrive-many", "--reason", "recovery"];
    expect(runAdmin([...args, "--env", databaseName, "--yes"]).code).toBe(64);
    expect(runAdmin([...args, "--request-id", "bulk-guard", "--yes"]).code).toBe(64);
    expect(runAdmin([...args, "--request-id", "bulk-guard", "--env", databaseName]).code).toBe(64);
    expect(
      runAdmin([...args, "--request-id", "bulk-guard", "--env", "wrong-database", "--yes"]).code,
    ).toBe(1);
    expect((await admin.getRedriveLineage(taskId)).records).toEqual([]);
  });
});

describe("admin CLI external-wait delivery", () => {
  it("completes a human decision from a JSON file", async () => {
    const taskId = await queue.enqueue("file.decision", {});
    const task = await queue.claim("file-worker", { leaseMs: 30_000 });
    await queue.waitForHuman(task!, "file-worker", "approval", {});
    const directory = await mkdtemp(path.join(tmpdir(), "workhorse-cli-decision-"));
    const file = path.join(directory, "answer.json");
    try {
      await writeFile(file, '{"approved":true,"comment":"reviewed"}');
      const result = runAdmin([
        "complete-human",
        taskId,
        "--name",
        "approval",
        "--payload-file",
        file,
        "--request-id",
        "file-answer",
        "--env",
        databaseName,
        "--yes",
        "--json",
      ]);
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "completed",
        payload: { approved: true, comment: "reviewed" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["signal", "complete-human"] as const)(
    "delivers and replays %s with attribution",
    async (command) => {
      const taskId = await queue.enqueue("await.delivery", {});
      const task = await queue.claim("delivery-worker", { leaseMs: 30_000 });
      if (command === "signal") await queue.waitForSignal(task!, "delivery-worker", "answer");
      else await queue.waitForHuman(task!, "delivery-worker", "answer", { prompt: "Approve?" });
      const args = [
        command,
        taskId,
        "--name",
        "answer",
        "--payload-json",
        "false",
        "--request-id",
        "delivery-request",
        "--actor",
        "oncall",
        "--env",
        databaseName,
        "--yes",
        "--json",
      ];
      const result = runAdmin(args);
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        taskId,
        name: "answer",
        payload: false,
        status: command === "signal" ? "delivered" : "completed",
        [command === "signal" ? "deliveredBy" : "completedBy"]: "oncall",
      });
      const replay = runAdmin(args);
      expect({ code: replay.code, stderr: replay.stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(replay.stdout)).toMatchObject({ status: "duplicate", payload: false });
      const conflict = runAdmin(args.map((arg) => (arg === "false" ? "true" : arg)));
      expect(conflict.code).toBe(1);
      const different = runAdmin(
        args.map((arg) => (arg === "delivery-request" ? "another-request" : arg)),
      );
      expect(different.code).toBe(1);
      const resumed = await queue.claim("resumed-worker");
      expect(resumed?.id).toBe(taskId);
      const answer =
        command === "signal"
          ? await queue.waitForSignal(resumed!, "resumed-worker", "answer")
          : await queue.waitForHuman(resumed!, "resumed-worker", "answer", { prompt: "Approve?" });
      expect(answer).toEqual({
        status: command === "signal" ? "delivered" : "completed",
        payload: false,
      });
    },
  );

  it.each(["signal", "complete-human"])(
    "refuses invalid %s delivery without changing the wait",
    async (command) => {
      const taskId = await queue.enqueue("guard.delivery", {});
      const task = await queue.claim("guard-worker", { leaseMs: 30_000 });
      if (command === "signal") await queue.waitForSignal(task!, "guard-worker", "answer");
      else await queue.waitForHuman(task!, "guard-worker", "answer", {});
      const base = [
        command,
        taskId,
        "--name",
        "answer",
        "--payload-json",
        "null",
        "--request-id",
        "guard-request",
      ];
      expect(runAdmin([...base, "--yes"]).code).toBe(64);
      expect(runAdmin([...base, "--env", "wrong", "--yes"]).code).toBe(1);
      expect(runAdmin([...base, "--env", databaseName]).code).toBe(64);
      expect(
        runAdmin([
          ...base.map((arg) => (arg === "null" ? "invalid json" : arg)),
          "--env",
          databaseName,
          "--yes",
        ]).code,
      ).toBe(64);
      expect(
        runAdmin([...base, "--payload-file", "unused", "--env", databaseName, "--yes"]).code,
      ).toBe(64);
      const pending =
        command === "signal" ? await admin.listSignalWaits() : await admin.listHumanWaits();
      expect(pending.items.map((wait) => wait.taskId)).toEqual([taskId]);
      const missing = runAdmin([
        ...base.map((arg) => (arg === taskId ? "00000000-0000-0000-0000-000000000000" : arg)),
        "--env",
        databaseName,
        "--yes",
        "--json",
      ]);
      expect(missing.code).toBe(1);
      expect(JSON.parse(missing.stdout).status).toBe("not_found");
    },
  );
});
