import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadProvisionedDashboards, type SigNozDashboard } from "./signoz-dashboard-manifest.js";

type SigNozResponse<T> = { status: "success"; data: T };
type ListedDashboard = SigNozDashboard & { id: string };

const dashboardDirectory = resolve("ops/signoz/dashboards");
const importedDashboardFiles = [resolve("docs/signoz/workhorse-business-metrics-v1.json")];
const baseUrl = (process.env.SIGNOZ_URL ?? "http://127.0.0.1:3301").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = (await response.json()) as { error?: string; message?: string } | SigNozResponse<T>;
  if (!response.ok || !("status" in body) || body.status !== "success") {
    const detail =
      "error" in body ? body.error : "message" in body ? body.message : JSON.stringify(body);
    throw new Error(
      `SigNoz ${init?.method ?? "GET"} ${path} failed (${response.status}): ${detail}`,
    );
  }
  return body.data;
}

async function waitUntilReady(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await request<{ dashboards: ListedDashboard[] }>("/api/v2/dashboards");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => {
        setTimeout(resolveDelay, 1_000);
      });
    }
  }
  throw lastError;
}

function comparable(dashboard: SigNozDashboard): object {
  return {
    image: dashboard.image,
    name: dashboard.name,
    schemaVersion: dashboard.schemaVersion,
    spec: dashboard.spec,
    tags: dashboard.tags,
  };
}

async function main(): Promise<void> {
  const desiredDashboards = await loadProvisionedDashboards(
    dashboardDirectory,
    importedDashboardFiles,
  );
  await waitUntilReady();
  const listed = await request<{ dashboards: ListedDashboard[] }>("/api/v2/dashboards");
  for (const desired of desiredDashboards) {
    const title =
      typeof desired.spec.display === "object" &&
      desired.spec.display !== null &&
      "name" in desired.spec.display &&
      typeof desired.spec.display.name === "string"
        ? desired.spec.display.name
        : desired.name;
    const matches = listed.dashboards.filter((dashboard) => dashboard.name === desired.name);
    if (matches.length > 1) {
      throw new Error(`SigNoz contains duplicate dashboards named ${desired.name}`);
    }
    const existing = matches[0];
    if (!existing) {
      const created = await request<ListedDashboard>("/api/v2/dashboards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(desired),
      });
      console.log(`Created SigNoz dashboard ${title} (${created.id})`);
      continue;
    }

    if (!existing.tags.some((tag) => tag.key === "managed-by" && tag.value === "workhorse")) {
      throw new Error(`Refusing to replace unmanaged SigNoz dashboard ${desired.name}`);
    }
    const current = await request<ListedDashboard>(`/api/v2/dashboards/${existing.id}`);
    if (isDeepStrictEqual(comparable(current), comparable(desired))) {
      console.log(`SigNoz dashboard ${title} is current (${existing.id})`);
      continue;
    }
    await request<ListedDashboard>(`/api/v2/dashboards/${existing.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(desired),
    });
    console.log(`Updated SigNoz dashboard ${title} (${existing.id})`);
  }
}

await main();
