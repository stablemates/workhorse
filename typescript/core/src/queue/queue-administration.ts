import { SQL_STATEMENTS } from "./sql-catalogue.generated.js";
import { expectOneRow } from "../errors.js";
import { logInfo } from "../telemetry.js";
import { QueueModule } from "./module-context.js";

/** A queue's storage tier. See ADR 0077. */
export type QueueTier = "fast" | "full";

/** The opt-in history a fast-tier queue writes. */
export interface QueueHistorySettings {
  /** Write one attempt history row for every closed attempt. */
  recordAttempts: boolean;
  /** Write one claimed event for every claim. */
  recordClaims: boolean;
}

/** Owns queue-wide promotion, pause, resume, and tier operations behind the public clients. */
export class QueueAdministrationModule extends QueueModule {
  async promote(limit = 100): Promise<number> {
    // Promotion is bounded so a large delayed backlog cannot create one long lock transaction.
    const result = await this.context.database.query<{ count: number }>(
      SQL_STATEMENTS["promote_v1__queue_administration"],
      [limit],
    );
    const count = expectOneRow(result, "workhorse.promote_v1").count;
    if (count > 0) {
      logInfo("workhorse.tasks.promoted", "Scheduled tasks promoted", {
        "workhorse.task.count": count,
      });
    }
    return count;
  }

  async pauseQueue(
    queueName: string,
    audit: { actor: string; reason: string; requestId: string },
  ): Promise<void> {
    await this.context.database.query(SQL_STATEMENTS["set_queue_paused_v1"], [
      queueName,
      audit.actor,
      audit.reason,
      audit.requestId,
    ]);
    logInfo("workhorse.queue.paused", "Queue paused", { "workhorse.queue.name": queueName });
  }

  async resumeQueue(
    queueName: string,
    audit: { actor: string; reason: string; requestId: string },
  ): Promise<void> {
    await this.context.database.query(SQL_STATEMENTS["set_queue_paused_v1__queue_administration"], [
      queueName,
      audit.actor,
      audit.reason,
      audit.requestId,
    ]);
    logInfo("workhorse.queue.resumed", "Queue resumed", { "workhorse.queue.name": queueName });
  }

  async setQueueTier(
    queueName: string,
    tier: QueueTier,
    audit: { actor: string; reason: string },
  ): Promise<QueueTier> {
    const result = await this.context.database.query<{ tier: QueueTier }>(
      SQL_STATEMENTS["set_queue_tier_v1"],
      [queueName, tier, audit.actor, audit.reason],
    );
    const changed = expectOneRow(result, "workhorse.set_queue_tier_v1").tier;
    logInfo("workhorse.queue.tier_set", "Queue tier set", {
      "workhorse.queue.name": queueName,
      "workhorse.queue.tier": changed,
    });
    return changed;
  }

  async setQueueHistory(
    queueName: string,
    settings: Partial<QueueHistorySettings>,
  ): Promise<QueueHistorySettings> {
    const result = await this.context.database.query<{
      record_attempts: boolean;
      record_claims: boolean;
    }>(SQL_STATEMENTS["set_queue_history_v1"], [
      queueName,
      settings.recordAttempts ?? null,
      settings.recordClaims ?? null,
    ]);
    const row = expectOneRow(result, "workhorse.set_queue_history_v1");
    return { recordAttempts: row.record_attempts, recordClaims: row.record_claims };
  }
}
