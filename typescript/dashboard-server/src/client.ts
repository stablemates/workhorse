import type { InferRouterInputs, RouterClient } from "@orpc/server";
import type { DashboardRouter } from "./server/router.js";

/**
 * The boundary the React dashboard consumes, inferred from the router that serves it.
 *
 * The router is the one definition of this API. Every method name, argument shape, and result
 * shape below is read back out of it by type inference, so adding a procedure is an edit to
 * `server/router.ts` alone — there is no second list here to forget. The types are erased at
 * build time, so the browser bundle still imports no server code.
 *
 * A host is free to implement this with something other than oRPC — fetch, an Electron bridge,
 * an in-process object — as long as it answers the same shapes. What it may no longer do is
 * answer a *different* shape and have that agree with the type-checker.
 */
type DashboardProcedures = RouterClient<DashboardRouter>["dashboard"];

type DashboardProcedureInputs = InferRouterInputs<DashboardRouter>["dashboard"];

/**
 * Procedures a host may leave unimplemented.
 *
 * Both mutate state a read-only host has no business changing, and the dashboard treats an absent
 * method as a capability limit it states rather than as an error: the run-now action stays visible
 * and disabled, and the demo controls are not offered at all. Every other procedure is required,
 * because a dashboard that cannot read its own pages has nothing to show.
 */
type OptionalDashboardProcedure = "runTaskNow" | "enqueueTest";

export type DashboardClient = Omit<DashboardProcedures, OptionalDashboardProcedure> &
  Partial<Pick<DashboardProcedures, OptionalDashboardProcedure>>;

/** Optional demo-only actions. Production hosts can omit this capability entirely. */
export type DashboardDemoTools = Required<Pick<DashboardProcedures, "enqueueTest">>;

/** Bounded audit attribution every operator mutation carries. */
export type DashboardAuditInput = DashboardProcedureInputs["setQueuePaused"]["audit"];

/** Cancellation attribution, whose reason is optional because a cancel may state none. */
export type DashboardCancellationAuditInput = DashboardProcedureInputs["cancelTask"]["audit"];

// The demo vocabulary is owned by wire.ts, which the router reads to build its own input schema.
// Re-exported here so a host still has one import for the whole client-facing contract.
export type { DashboardDemoJobKind, DashboardDemoScenario } from "./wire.js";
