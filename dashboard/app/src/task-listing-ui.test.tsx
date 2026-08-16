import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

function render(component: unknown, props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(component as never, props)),
  );
}

describe("task listing identity", () => {
  it("keeps the display name on one line and exposes the full name as its title", async () => {
    const { TaskName } = await import("./dashboard.js");
    const html = render(TaskName, {
      type: "billing.customer.invoice.reconciliation.requested",
      queue: "billing",
    });

    expect(html).toContain('title="customer.invoice.reconciliation.requested"');
    expect(html).toContain("width:180px");
    expect(html).toContain("white-space:nowrap");
    expect(html).toContain("text-overflow:ellipsis");
  });

  it("renders tags as separate badges and exposes the full list on hover", async () => {
    const { TaskTags, TaskTagsTooltipContent } = await import("./dashboard.js");
    const tags = ["billing", "weekly", "durable-checkpoint"];
    const html = render(TaskTags, {
      tags,
    });
    const tooltipHtml = render(TaskTagsTooltipContent, { tags });

    expect(html.match(/mantine-Badge-root/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Tags: billing, weekly, durable-checkpoint"');
    expect(tooltipHtml).toContain("<ul");
    expect(tooltipHtml.match(/<li/g)).toHaveLength(3);
    expect(html).toContain("white-space:nowrap");
    expect(html).toContain("overflow:hidden");
    expect(html).toContain("durable-checkpoint");
  });

  it("uses a named button to open task details from the table", async () => {
    const { TaskOpenButton } = await import("./task-table-ui.js");
    const html = render(TaskOpenButton, {
      jobId: "job-123",
      taskType: "billing.invoice",
      onOpen: () => undefined,
      children: "Invoice",
    });

    expect(html).toContain("<button");
    expect(html).toContain('id="task-open-job-123"');
    expect(html).toContain('aria-label="View task billing.invoice, job-123"');
  });

  it("places ordering after task type and omits the priority filter", async () => {
    const { TaskListingFilters } = await import("./dashboard.js");
    const html = render(TaskListingFilters, {
      data: {
        tags: [],
        sort: "updated",
        queue: null,
        worker: null,
        jobType: null,
      },
      searchInput: "",
      setSearchInput: () => undefined,
      taskFacets: {
        facets: { queues: [], workers: [], jobTypes: [], tags: [] },
        loading: false,
        error: null,
        load: () => undefined,
      },
      updateLocation: () => undefined,
    });

    expect(html).not.toContain('aria-label="Filter tasks by exact priority"');
    expect(html.indexOf('aria-label="Filter tasks by task type"')).toBeLessThan(
      html.indexOf('aria-label="Sort tasks"'),
    );
  });

  it("announces task state without relying on badge color", async () => {
    const { StatusBadge } = await import("./status-badge.js");
    const html = render(StatusBadge, { state: "failed" });

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Status: failed"');
  });
});
