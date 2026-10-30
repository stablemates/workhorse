import type { Queryable } from "@stablemates/workhorse";
import { describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server/standalone.js";
import { PROTOCOL_VERSION, WORKHORSE_SCHEMA_VERSION } from "@stablemates/workhorse";

/** A database that records each statement and answers the schema probe and the two calls. */
function recordingDatabase() {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const database = {
    query: async (text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("set_schedule_paused_v1")) {
        // An unknown schedule updates no row, so the function returns null.
        return { rows: [{ paused: values[1] === "missing" ? null : values[2] }] };
      }
      if (text.includes("dashboard_settings_v1")) return { rows: [{ result: {} }] };
      if (text.includes("queue_health_v1")) return { rows: [{ document: {} }] };
      return {
        rows: [
          { kind: "protocol", version: PROTOCOL_VERSION },
          { kind: "schema", version: WORKHORSE_SCHEMA_VERSION },
        ],
      };
    },
  } as unknown as Queryable;
  return { database, calls };
}

async function withListener(
  database: Queryable,
  allowMutations: boolean,
  run: (rpc: (procedure: string, input: unknown) => Promise<Response>) => Promise<void>,
): Promise<void> {
  const running = await startDashboardServer(database, {
    hostname: "127.0.0.1",
    port: 0,
    allowMutations,
    actor: "operator",
  });
  try {
    await run((procedure, input) =>
      fetch(`${running.url}/rpc/dashboard/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({ json: input }),
      }),
    );
  } finally {
    await running.close();
  }
}

const audit = { actor: "operator", reason: "Pause app/nightly", requestId: "request" };

describe("standalone dashboard mutations", () => {
  it("pauses a schedule and offers settings changes when mutations are allowed", async () => {
    const recording = recordingDatabase();
    await withListener(recording.database, true, async (rpc) => {
      const paused = await rpc("setSchedulePaused", {
        kind: "user",
        namespace: "app",
        name: "nightly",
        paused: true,
        audit,
      });
      expect(paused.status).toBe(200);
      expect(await paused.json()).toEqual({ json: { paused: true } });

      const missing = await rpc("setSchedulePaused", {
        kind: "user",
        namespace: "app",
        name: "missing",
        paused: true,
        audit,
      });
      expect(missing.status).toBe(500);
      await missing.body?.cancel();

      const settings = await rpc("settings", {});
      expect(settings.status).toBe(200);
      await settings.body?.cancel();
    });

    const pause = recording.calls.find((call) => call.text.includes("set_schedule_paused_v1"));
    // The pause records who asked and why.
    expect(pause?.values).toEqual(["app", "nightly", true, "operator", "Pause app/nightly"]);
    const settingsRead = recording.calls.find((call) =>
      call.text.includes("dashboard_settings_v1"),
    );
    expect(JSON.parse(String(settingsRead?.values[0]))).toMatchObject({
      writable: true,
      settingsController: true,
    });
  });

  it("keeps a read-only listener without schedule and settings changes", async () => {
    const recording = recordingDatabase();
    await withListener(recording.database, false, async (rpc) => {
      const paused = await rpc("setSchedulePaused", {
        kind: "user",
        namespace: "app",
        name: "nightly",
        paused: true,
        audit,
      });
      expect(paused.status).toBe(403);
      await paused.body?.cancel();
      const settings = await rpc("settings", {});
      await settings.body?.cancel();
    });
    expect(recording.calls.some((call) => call.text.includes("set_schedule_paused_v1"))).toBe(
      false,
    );
    const settingsRead = recording.calls.find((call) =>
      call.text.includes("dashboard_settings_v1"),
    );
    expect(JSON.parse(String(settingsRead?.values[0]))).toMatchObject({
      writable: false,
      settingsController: false,
    });
  });
});
