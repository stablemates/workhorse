import { expectOneRow } from "../errors.js";
import { logInfo } from "../telemetry.js";
import { QueueModule } from "./module-context.js";

/** Owns queue-wide promotion, pause, resume, and purge operations behind the Queue facade. */
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

  async pauseQueue(queueName = this.context.defaultQueue): Promise<void> {
    await this.context.database.query("SELECT workhorse.pause_queue_v1($1::text)", [queueName]);
    logInfo("workhorse.queue.paused", "Queue paused", { "workhorse.queue.name": queueName });
  }

  async resumeQueue(queueName = this.context.defaultQueue): Promise<void> {
    await this.context.database.query("SELECT workhorse.resume_queue_v1($1::text)", [queueName]);
    logInfo("workhorse.queue.resumed", "Queue resumed", { "workhorse.queue.name": queueName });
  }

  async purgeQueue(queueName = this.context.defaultQueue): Promise<number> {
    const result = await this.context.database.query<{ count: number }>(
      "SELECT workhorse.purge_queue_v1($1::text) AS count",
      [queueName],
    );
    const count = expectOneRow(result, "workhorse.purge_queue_v1").count;
    logInfo("workhorse.queue.purged", "Queue purged", {
      "workhorse.queue.name": queueName,
      "workhorse.job.count": count,
    });
    return count;
  }
}
