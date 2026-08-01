import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute directory containing the dashboard's framework-servable browser bundle. */
export function dashboardAssetsDirectory(): string {
  const installed = new URL("../app/", import.meta.url);
  return fileURLToPath(
    existsSync(installed) ? installed : new URL("../../dist/app/", import.meta.url),
  );
}
