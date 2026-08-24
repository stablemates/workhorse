import type {
  DashboardCommandOptions,
  DashboardStandaloneModule,
  DashboardStandaloneTarget,
  RunningDashboard,
} from "@workhorse-js/dashboard-contract";
import type { Pool } from "pg";

const dashboardModuleSpecifier: string = "@workhorse-js/dashboard/standalone";

function isDashboardStandaloneModule<Database>(
  value: unknown,
): value is DashboardStandaloneModule<Database> {
  return (
    typeof value === "object" &&
    value !== null &&
    "startDashboardServer" in value &&
    typeof value.startDashboardServer === "function"
  );
}

/** Load the optional dashboard implementation through its shared package contract. */
async function loadDashboard(): Promise<DashboardStandaloneModule<Pool>> {
  try {
    const module: unknown = await import(dashboardModuleSpecifier);
    if (!isDashboardStandaloneModule<Pool>(module)) {
      throw new TypeError(`${dashboardModuleSpecifier} does not implement the standalone contract`);
    }
    return module;
  } catch (error) {
    throw new Error(
      "The dashboard command requires @workhorse-js/dashboard. Install it alongside @stablemates/workhorse.",
      { cause: error },
    );
  }
}

/** Serve the optional dashboard package while leaving the database connection owned by the CLI. */
export async function startDashboardServer(
  database: DashboardStandaloneTarget<Pool>,
  options: DashboardCommandOptions,
): Promise<RunningDashboard> {
  const dashboard = await loadDashboard();
  return dashboard.startDashboardServer(database, options);
}
