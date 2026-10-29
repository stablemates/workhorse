import { describe, expect, it } from "vitest";
import { createIntegrationTestContext } from "../../core/test/support/integration.js";
import { readDashboardTaskDetail } from "../src/server/read-model.js";
import { dashboardDatabase } from "../src/server/sql.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

describe("dashboard task detail group", () => {
  it("returns the group, the position, and the group state of a member task", async () => {
    const { group, tasks } = await queue.taskGroup({}, (builder) =>
      builder.add([
        { type: "detail-group.member", payload: { member: 1 } },
        { type: "detail-group.member", payload: { member: 2 } },
      ]),
    );
    const second = tasks[1]!.taskId;

    const detail = await readDashboardTaskDetail(dashboardDatabase(pool), second);

    expect(detail?.group).toEqual({ id: group.id, position: 2, state: "sealed" });
  });

  it("follows the group state when the group finishes", async () => {
    const { group, tasks } = await queue.taskGroup({}, (builder) =>
      builder.add([{ type: "detail-group.finish", payload: {} }]),
    );
    const member = tasks[0]!.taskId;
    await queue.cancel(member, { requestedBy: "detail-group-test", reason: "finish the group" });

    const detail = await readDashboardTaskDetail(dashboardDatabase(pool), member);

    expect(detail?.group).toEqual({ id: group.id, position: 1, state: "finished" });
  });

  it("returns a null group for a task that is not a member", async () => {
    const id = await queue.enqueue("detail-group.alone", {});

    const detail = await readDashboardTaskDetail(dashboardDatabase(pool), id);

    expect(detail).not.toBeNull();
    expect(detail?.group).toBeNull();
  });
});
