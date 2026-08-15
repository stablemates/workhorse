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
): Promise<string> {
  const { DependencyLine } = await import("./dashboard.js");
  const job = {
    identity: {
      prerequisiteJobId: null,
      prerequisiteJobIds: [],
      dependencyPolicy: null,
      dependencyReleasedAt: null,
      blockedReason: null,
      ...identity,
    },
  } as DashboardJobDetail;
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(DependencyLine, { job })),
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

  it("renders nothing for an independent task", async () => {
    await expect(renderDependency({})).resolves.not.toContain("Prerequisite");
  });
});
