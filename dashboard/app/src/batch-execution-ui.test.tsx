import { MantineProvider } from "@mantine/core";
import type { DashboardJobDetail } from "@stablemates/workhorse-dashboard-server/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

async function renderBatchExecution(batch: DashboardJobDetail["batchExecutions"][number]) {
  const { BatchExecutionLine } = await import("./dashboard.js");
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(BatchExecutionLine, {
        batch,
        selectedJobId: "selected-job",
        taskLinkHref: (id: string) => `/tasks?task=${id}`,
      }),
    ),
  );
}

describe("batch execution detail", () => {
  it("shows batch size and peer task links", async () => {
    const html = await renderBatchExecution({
      id: "batch-id",
      attempt: 2,
      dispatchedAt: "2026-08-16T12:00:00.000Z",
      batchWideFailure: false,
      members: [
        {
          id: "selected-job",
          attempt: 2,
          type: "email.send",
          outcome: "succeeded",
          error: null,
        },
        {
          id: "peer-job",
          attempt: 1,
          type: "email.send",
          outcome: "succeeded",
          error: null,
        },
      ],
    });

    expect(html).toContain("Processed in a batch of 2");
    expect(html).toContain("peer-job");
    expect(html).toContain('href="/tasks?task=peer-job"');
  });

  it("labels one shared handler error as a batch-wide failure", async () => {
    const error = { name: "Error", message: "provider batch failed" };
    const html = await renderBatchExecution({
      id: "batch-id",
      attempt: 1,
      dispatchedAt: "2026-08-16T12:00:00.000Z",
      batchWideFailure: true,
      members: [
        { id: "selected-job", attempt: 1, type: "email.send", outcome: "failed", error },
        { id: "peer-job", attempt: 1, type: "email.send", outcome: "retry", error },
      ],
    });

    expect(html).toContain("Batch-wide failure");
    expect(html).toContain("provider batch failed");
  });

  it("does not infer a shared callback failure from equal per-member errors", async () => {
    const error = { name: "Error", message: "provider rejected delivery" };
    const html = await renderBatchExecution({
      id: "batch-id",
      attempt: 1,
      dispatchedAt: "2026-08-16T12:00:00.000Z",
      batchWideFailure: false,
      members: [
        { id: "selected-job", attempt: 1, type: "email.send", outcome: "failed", error },
        { id: "peer-job", attempt: 1, type: "email.send", outcome: "failed", error },
      ],
    });

    expect(html).not.toContain("Batch-wide failure");
  });
});
