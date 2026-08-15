import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardJobDetail } from "./wire.js";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

async function renderDependency(
  identity: Partial<DashboardJobDetail["identity"]>,
  dependencyLineage: DashboardJobDetail["dependencyLineage"] = {
    records: [],
    truncated: false,
  },
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
  } as DashboardJobDetail;
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(DependencyLine, { job })),
  );
}

async function renderRedrive(
  redriveLineage: DashboardJobDetail["redriveLineage"],
  id = "selected-job",
): Promise<string> {
  const { RedriveLine } = await import("./dashboard.js");
  const job = { identity: { id }, redriveLineage } as DashboardJobDetail;
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(RedriveLine, { job })),
  );
}

async function renderChild(childLineage: DashboardJobDetail["childLineage"]): Promise<string> {
  const { ChildLine } = await import("./dashboard.js");
  const job = { identity: { id: "parent-job" }, childLineage } as DashboardJobDetail;
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(ChildLine, { job })),
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
    expect(html).toContain("success: release");
    expect(html).toContain("failure: fail");
    expect(html).toContain("cancellation: cancel");
    expect(html).toContain("resolved as release");
    expect(html).toContain("other-dependent-job");
    expect(html).toContain("success: cancel");
    expect(html).toContain("failure: release");
  });

  it("renders nothing for an independent task", async () => {
    await expect(renderDependency({})).resolves.not.toContain("Prerequisite");
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
  });

  it("shows the immutable source from the fresh target", async () => {
    const html = await renderRedrive(lineage, "fresh-job");
    expect(html).toContain("Redriven from");
    expect(html).toContain("selected-job");
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
  });
});
