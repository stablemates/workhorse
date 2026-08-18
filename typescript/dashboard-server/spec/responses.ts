import type { InferRouterOutputs } from "@orpc/server";
import type { dashboardRouter } from "../src/server/router.js";

/**
 * The response type of every dashboard procedure, inferred from the router.
 *
 * The spec generator resolves this alias with the TypeScript checker and emits one JSON Schema
 * per property, so a router change that alters any response shape changes the generated
 * `dashboard/v1` artifacts and fails the parity check until the artifacts are regenerated.
 */
export type DashboardV1Responses = InferRouterOutputs<typeof dashboardRouter>["dashboard"];
