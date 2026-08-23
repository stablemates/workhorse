import { expectOneRow } from "../errors.js";
import { logInfo } from "../telemetry.js";
import { QueueModule } from "./module-context.js";

/** Owns queue-wide promotion, pause, and resume operations behind the public clients. */
export class QueueAdministrationModule extends QueueModule {
  async promote(limit = 100): Promise<number> {
    // Promotion is bounded so a large delayed backlog cannot create one long lock transaction.
    const result = await this.context.database.query<{ count: number }>(
      "SELECT workhorse.promote_v1($1::integer) AS count",
      [limit],
    );
    const count = expectOneRow(result, "workhorse.promote_v1").count;
    if (count > 0) {
      logInfo("workhorse.jobs.promoted", "Scheduled jobs promoted", {
        "workhorse.job.count": count,
      });
    }
    return count;
  }

  async pauseQueue(
    queueName: string,
    audit: { actor: string; reason: string; requestId: string },
  ): Promise<void> {
    await this.context.database.query(
      "SELECT workhorse.set_queue_paused_v1($1::text, true, $2::text, $3::text, $4::text)",
      [queueName, audit.actor, audit.reason, audit.requestId],
    );
    logInfo("workhorse.queue.paused", "Queue paused", { "workhorse.queue.name": queueName });
  }

  async resumeQueue(
    queueName: string,
    audit: { actor: string; reason: string; requestId: string },
  ): Promise<void> {
    await this.context.database.query(
      "SELECT workhorse.set_queue_paused_v1($1::text, false, $2::text, $3::text, $4::text)",
      [queueName, audit.actor, audit.reason, audit.requestId],
    );
    logInfo("workhorse.queue.resumed", "Queue resumed", { "workhorse.queue.name": queueName });
  }
}
