import { describe, expect, it, vi } from "vitest";
import { createIntegrationTestContext } from "../../core/test/support/integration.js";
import { startDashboardServer } from "../src/server/standalone.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

async function withMutableListener(
  run: (rpc: (procedure: string, input: unknown) => Promise<Response>) => Promise<void>,
  { workspace = null }: { workspace?: string | null } = {},
): Promise<void> {
  const target =
    workspace === null ? pool : { workspaces: { [workspace]: pool }, defaultWorkspace: workspace };
  const running = await startDashboardServer(target, {
    hostname: "127.0.0.1",
    port: 0,
    allowMutations: true,
    actor: "ops@example.com",
  });
  try {
    await run((procedure, input) =>
      fetch(
        `${running.url}${workspace === null ? "" : `/${workspace}`}/rpc/dashboard/${procedure}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: running.url },
          body: JSON.stringify({ json: input }),
        },
      ),
    );
  } finally {
    await running.close();
  }
}

/** The JSON lines that the listener wrote to standard output while `run` ran. */
async function auditLines(run: () => Promise<void>): Promise<unknown[]> {
  const lines: unknown[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    const text = String(chunk);
    if (text.includes('"workhorse.dashboard.policy_changed"')) lines.push(JSON.parse(text));
    return true;
  });
  try {
    await run();
  } finally {
    write.mockRestore();
  }
  return lines;
}

describe("standalone dashboard audit", () => {
  it("records the actor and the reason of each policy change", async () => {
    const lines = await auditLines(() =>
      withMutableListener(async (rpc) => {
        const override = await rpc("overrideMaintenancePolicy", {
          definition: { terminalCleanupIntervalMs: 120_000 },
          audit: {
            actor: "browser",
            reason: "Clean up finished tasks less often",
            requestId: "0198f0d2-6c35-7aa1-9a6e-1b4f6d0f3c21",
          },
        });
        expect(override.status).toBe(200);
        await override.body?.cancel();
        const revert = await rpc("revertMaintenancePolicy", {
          settings: ["terminalCleanupIntervalMs"],
          audit: { actor: "browser", reason: "Restore the default", requestId: "r-2" },
        });
        expect(revert.status).toBe(200);
        await revert.body?.cancel();
        // PostgreSQL refuses this value, so the change fails and records nothing.
        const refused = await rpc("overrideMaintenancePolicy", {
          definition: { timezone: "Not/AZone" },
          audit: { actor: "browser", reason: "Use a bad zone", requestId: "r-3" },
        });
        expect(refused.ok).toBe(false);
        await refused.body?.cancel();
      }),
    );

    expect(lines).toEqual([
      {
        event: "workhorse.dashboard.policy_changed",
        action: "overrideMaintenancePolicy",
        change: { terminalCleanupIntervalMs: 120_000 },
        // The listener's actor replaces the actor that the browser sent.
        actor: "ops@example.com",
        reason: "Clean up finished tasks less often",
        requestIdPreview: "0198f0d2…3c21",
        requestIdDigest: expect.stringMatching(/^[0-9a-f]{12}$/),
        requestIdLength: 36,
        occurredAt: expect.any(String),
      },
      {
        event: "workhorse.dashboard.policy_changed",
        action: "revertMaintenancePolicy",
        change: ["terminalCleanupIntervalMs"],
        actor: "ops@example.com",
        reason: "Restore the default",
        requestIdPreview: "•••",
        requestIdDigest: expect.stringMatching(/^[0-9a-f]{12}$/),
        requestIdLength: 3,
        occurredAt: expect.any(String),
      },
    ]);
    // The raw request ID stays out of the log, as `queue_control` keeps it out of the table.
    expect(JSON.stringify(lines)).not.toContain("0198f0d2-6c35");
  });

  it("names the workspace of a change when the process serves several workspaces", async () => {
    const lines = await auditLines(() =>
      withMutableListener(
        async (rpc) => {
          const revert = await rpc("revertMaintenancePolicy", {
            settings: ["terminalCleanupIntervalMs"],
            audit: { actor: "browser", reason: "Restore the default", requestId: "r-5" },
          });
          expect(revert.status).toBe(200);
          await revert.body?.cancel();
        },
        { workspace: "billing" },
      ),
    );
    expect(lines).toEqual([expect.objectContaining({ workspace: "billing" })]);
  });

  it("records the actor and the reason of a schedule pause in the schedule", async () => {
    await queue.syncSchedules("audit", [
      { name: "nightly", schedule: "0 3 * * *", task: { type: "audit-nightly", payload: {} } },
    ]);
    await withMutableListener(async (rpc) => {
      const paused = await rpc("setSchedulePaused", {
        kind: "user",
        namespace: "audit",
        name: "nightly",
        paused: true,
        audit: { actor: "browser", reason: "Stop the nightly export", requestId: "r-4" },
      });
      expect(paused.status).toBe(200);
      await paused.body?.cancel();
    });
    const { rows } = await pool.query<{ paused_by: string; paused_reason: string }>(
      "SELECT paused_by, paused_reason FROM workhorse.schedule_definition WHERE namespace = 'audit'",
    );
    expect(rows).toEqual([
      { paused_by: "ops@example.com", paused_reason: "Stop the nightly export" },
    ]);
  });
});
