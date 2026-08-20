import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardJobDetail } from "@workhorse-js/dashboard-server/wire";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

async function renderDependency(
  identity: Partial<DashboardJobDetail["identity"]>,
  dependencyLineage: DashboardJobDetail["dependencyLineage"] = {
    records: [],
    truncated: false,
  },
  childLineage: DashboardJobDetail["childLineage"] = { records: [], truncated: false },
): Promise<string> {
  const { DependencyLine } = await import("./dashboard.js");
  const job = {
    identity: {
      id: "selected-job",
      prerequisiteJobId: null,
      prerequisiteJobIds: [],
      dependencyPolicy: null,
      dependencyReleasedAt: null,
      blockedReason: null,
      ...identity,
    },
    dependencyLineage,
    childLineage,
  } as DashboardJobDetail;
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(DependencyLine, { job, taskLinkHref: (id: string) => `/tasks?task=${id}` }),
    ),
  );
}

async function renderRedrive(
  redriveLineage: DashboardJobDetail["redriveLineage"],
  id = "selected-job",
): Promise<string> {
  const { RedriveLine } = await import("./dashboard.js");
  const job = { identity: { id }, redriveLineage } as DashboardJobDetail;
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(RedriveLine, {
        job,
        taskLinkHref: (taskId: string) => `/tasks?task=${taskId}`,
      }),
    ),
  );
}

async function renderChild(childLineage: DashboardJobDetail["childLineage"]): Promise<string> {
  const { ChildLine } = await import("./dashboard.js");
  const job = { identity: { id: "parent-job" }, childLineage } as DashboardJobDetail;
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(ChildLine, {
        job,
        taskLinkHref: (taskId: string) => `/tasks?task=${taskId}`,
      }),
    ),
  );
}

describe("task dependency detail", () => {
  it("shows the prerequisite identity and blocked reason", async () => {
    const html = await renderDependency({
      prerequisiteJobId: "prerequisite-job",
      prerequisiteJobIds: ["prerequisite-job"],
      blockedReason: "prerequisite_pending",
    });
    expect(html).toContain("prerequisite-job");
    expect(html).toContain("blocked");
    expect(html).toContain("Blocked until every prerequisite satisfies the dependency policy");
    expect(html).toContain('href="/tasks?task=prerequisite-job"');
  });

  it("shows when PostgreSQL released the dependency", async () => {
    const html = await renderDependency({
      prerequisiteJobId: "prerequisite-job",
      prerequisiteJobIds: ["prerequisite-job"],
      dependencyReleasedAt: "2026-08-14T12:00:00.000Z",
    });
    expect(html).toContain("released");
    expect(html).toContain("Released");
  });

  it("shows reverse dependents, terminal policies, and per-edge release evidence", async () => {
    const html = await renderDependency(
      {},
      {
        records: [
          {
            dependentJobId: "dependent-job",
            prerequisiteJobId: "selected-job",
            onSuccess: "release",
            onFailure: "fail",
            onCancellation: "cancel",
            createdAt: "2026-08-14T11:00:00.000Z",
            releasedAt: "2026-08-14T12:00:00.000Z",
            resolution: "release",
          },
          {
            dependentJobId: "other-dependent-job",
            prerequisiteJobId: "selected-job",
            onSuccess: "cancel",
            onFailure: "release",
            onCancellation: "fail",
            createdAt: "2026-08-14T11:30:00.000Z",
            releasedAt: null,
            resolution: null,
          },
        ],
        truncated: false,
      },
    );
    expect(html).toContain("Dependent");
    expect(html).toContain("dependent-job");
    expect(html).toContain(
      "If this task succeeds, it can run; if this task fails, it fails; " +
        "if this task is canceled, it is canceled.",
    );
    expect(html).toContain("This task released it");
    expect(html).toContain("other-dependent-job");
    expect(html).toContain(
      "If this task succeeds, it is canceled; if this task fails, it can run; " +
        "if this task is canceled, it fails.",
    );
    expect(html).toContain("Still waiting on this task");
    expect(html).not.toContain("success: release");
    expect(html).toContain('href="/tasks?task=dependent-job"');
    expect(html).toContain('href="/tasks?task=other-dependent-job"');
  });

  it("explains the prerequisite policy as a sentence without repeating the identity", async () => {
    const html = await renderDependency(
      {
        prerequisiteJobId: "prerequisite-job",
        prerequisiteJobIds: ["prerequisite-job"],
        blockedReason: "prerequisite_pending",
      },
      {
        records: [
          {
            dependentJobId: "selected-job",
            prerequisiteJobId: "prerequisite-job",
            onSuccess: "release",
            onFailure: "fail",
            onCancellation: "cancel",
            createdAt: "2026-08-14T11:00:00.000Z",
            releasedAt: null,
            resolution: null,
          },
        ],
        truncated: false,
      },
    );
    expect(html).toContain(
      "If it succeeds, this task can run; if it fails, this task fails; " +
        "if it is canceled, this task is canceled.",
    );
    expect(html).not.toContain("success: release");
    // The identity appears exactly once, as the link: its href plus its full-id hover title.
    // The visible text is the shortened eight-character form.
    expect(html.split("prerequisite-job").length - 1).toBe(2);
    expect(html).toContain(">prerequi<");
  });

  it("renders nothing for an independent task", async () => {
    await expect(renderDependency({})).resolves.not.toContain("Prerequisite");
  });

  it("hides dependency edges that mirror a parent-child edge", async () => {
    // Spawning a child inserts both a job_child edge and a job_dependency edge for the same
    // pair, so without filtering the child's drawer names its parent twice: once as
    // "Dependent" here and once as "Parent" in ChildLine.
    const html = await renderDependency(
      {},
      {
        records: [
          {
            dependentJobId: "parent-job",
            prerequisiteJobId: "selected-job",
            onSuccess: "release",
            onFailure: "fail",
            onCancellation: "cancel",
            createdAt: "2026-08-14T11:00:00.000Z",
            releasedAt: "2026-08-14T12:00:00.000Z",
            resolution: "release",
          },
        ],
        truncated: false,
      },
      {
        records: [
          {
            parentJobId: "parent-job",
            childJobId: "selected-job",
            name: "shard-1",
            type: "demo.child-step",
            createdAt: "2026-08-14T11:00:00.000Z",
            joinedAt: "2026-08-14T12:00:00.000Z",
            outcomeState: "succeeded",
            error: null,
          },
        ],
        truncated: false,
      },
    );
    expect(html).not.toContain("Dependent");
    expect(html).not.toContain("parent-job");
  });

  it("hides the parent's implicit child prerequisites but keeps explicit ones", async () => {
    const html = await renderDependency(
      { prerequisiteJobIds: ["child-job", "explicit-prerequisite"] },
      {
        records: [
          {
            dependentJobId: "selected-job",
            prerequisiteJobId: "child-job",
            onSuccess: "release",
            onFailure: "fail",
            onCancellation: "cancel",
            createdAt: "2026-08-14T11:00:00.000Z",
            releasedAt: null,
            resolution: null,
          },
          {
            dependentJobId: "selected-job",
            prerequisiteJobId: "explicit-prerequisite",
            onSuccess: "release",
            onFailure: "fail",
            onCancellation: "cancel",
            createdAt: "2026-08-14T11:00:00.000Z",
            releasedAt: null,
            resolution: null,
          },
        ],
        truncated: false,
      },
      {
        records: [
          {
            parentJobId: "selected-job",
            childJobId: "child-job",
            name: "shard-1",
            type: "demo.child-step",
            createdAt: "2026-08-14T11:00:00.000Z",
            joinedAt: null,
            outcomeState: null,
            error: null,
          },
        ],
        truncated: false,
      },
    );
    expect(html).toContain("explicit-prerequisite");
    expect(html).not.toContain("child-job");
    expect(html).toContain("Prerequisite");
    expect(html).not.toContain("Prerequisites");
  });
});

describe("task redrive detail", () => {
  const lineage: DashboardJobDetail["redriveLineage"] = {
    records: [
      {
        sourceJobId: "selected-job",
        targetJobId: "fresh-job",
        requestedBy: "operator",
        reason: "dependency repaired",
        requestIdPreview: "request",
        requestIdDigest: "0123456789ab",
        requestIdLength: 7,
        sourceState: "failed",
        targetInitialState: "ready",
        requestedAt: "2026-08-15T12:00:00.000Z",
      },
    ],
    truncated: false,
  };

  it("shows the fresh identity and operator attribution from the failed source", async () => {
    const html = await renderRedrive(lineage);
    expect(html).toContain("Redrive");
    expect(html).toContain("fresh-job");
    expect(html).toContain("operator");
    expect(html).toContain("dependency repaired");
    expect(html).toContain('href="/tasks?task=fresh-job"');
  });

  it("shows the immutable source from the fresh target", async () => {
    const html = await renderRedrive(lineage, "fresh-job");
    expect(html).toContain("Redriven from");
    expect(html).toContain("selected-job");
    expect(html).toContain('href="/tasks?task=selected-job"');
  });
});

describe("task child detail", () => {
  it("shows terminal child failure evidence instead of calling it waiting", async () => {
    const html = await renderChild({
      records: [
        {
          parentJobId: "parent-job",
          childJobId: "failed-child",
          name: "charge",
          type: "payments.charge",
          createdAt: "2026-08-15T12:00:00.000Z",
          joinedAt: null,
          outcomeState: "failed",
          error: { name: "PaymentDeclined", message: "card declined" },
        },
      ],
      truncated: false,
    });
    expect(html).toContain("failed-child");
    expect(html).toContain("failed");
    expect(html).toContain("PaymentDeclined");
    expect(html).not.toContain("waiting");
    expect(html).toContain('href="/tasks?task=failed-child"');
  });

  it("summarizes join progress across a parent's child set", async () => {
    const html = await renderChild({
      records: [
        {
          parentJobId: "parent-job",
          childJobId: "joined-child",
          name: "research",
          type: "agent.tool",
          createdAt: "2026-08-15T12:00:00.000Z",
          joinedAt: "2026-08-15T12:01:00.000Z",
          outcomeState: "succeeded",
          error: null,
        },
        {
          parentJobId: "parent-job",
          childJobId: "waiting-child",
          name: "calculate",
          type: "agent.tool",
          createdAt: "2026-08-15T12:00:00.000Z",
          joinedAt: null,
          outcomeState: null,
          error: null,
        },
      ],
      truncated: false,
    });
    expect(html).toContain("1 of 2 children joined");
  });
});
