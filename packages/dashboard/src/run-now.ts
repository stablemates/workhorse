import type { DashboardClient } from "./client.js";
import { describeRunNowOutcome } from "./presentation.js";
import type { DashboardRunNowStatus } from "./wire.js";

/**
 * What one run-now request reported, held so the list can state it and offer the released task.
 *
 * A transport failure and a server refusal are both outcomes worth showing, so this carries either
 * a described status or a failure sentence rather than modelling failure as absence.
 */
export interface RunNowFeedback {
  jobId: string;
  /** Exactly what the server reported, kept beside the wording so a reader can act on either. */
  status: DashboardRunNowStatus | null;
  described: ReturnType<typeof describeRunNowOutcome> | null;
  failure: string | null;
}

/**
 * Ask the connected host to release one scheduled task, and describe what it reported.
 *
 * The mutation is invoked as a method on the client rather than through a reference lifted off it.
 * The packaged browser client is an oRPC proxy that turns *every* property read into another
 * procedure path, so `client.runTaskNow.call(client, …)` and `client.runTaskNow.bind(client)` both
 * address a procedure named `runTaskNow.call` or `runTaskNow.bind`. No router has one, and the
 * server answers with a 404 the operator sees as "Not found" while the task stays scheduled.
 */
export async function requestRunNow(
  client: DashboardClient,
  input: { id: string; auditActor: string; requestId: string },
): Promise<RunNowFeedback> {
  const { id, auditActor, requestId } = input;
  if (!client.runTaskNow) {
    return {
      jobId: id,
      status: null,
      described: null,
      failure: "This host cannot run a scheduled task now",
    };
  }
  try {
    const result = await client.runTaskNow({
      id,
      audit: {
        actor: auditActor,
        reason: `Run scheduled task ${id} now from the dashboard`,
        requestId,
      },
    });
    return {
      jobId: id,
      status: result.status,
      described: describeRunNowOutcome(result.status, { state: result.state }),
      failure: null,
    };
  } catch (cause) {
    return {
      jobId: id,
      status: null,
      described: null,
      failure: cause instanceof Error ? cause.message : "Workhorse could not release the task",
    };
  }
}
