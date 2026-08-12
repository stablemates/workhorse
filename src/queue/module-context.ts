import type { Queryable, QueueOptions } from "../types.js";

/**
 * Dependencies shared by the internal Queue modules.
 *
 * The stable Queue facade owns this context. Eight internal concerns receive it as their
 * implementations move out of queue.ts: enqueue and contracts; claim, lease, and fence;
 * checkpoints, progress, and waits; queue administration; worker registry; retention and
 * maintenance; cron schedules; and operator reads. Keeping the context internal prevents those
 * relocations from changing public exports or inventing a second configuration surface.
 */
export interface QueueModuleContext {
  readonly database: Queryable;
  readonly defaultQueue: string;
  readonly options: QueueOptions;
}

export abstract class QueueModule {
  constructor(protected readonly context: QueueModuleContext) {}
}

export function createQueueModuleContext(
  database: Queryable,
  defaultQueue: string,
  options: QueueOptions,
): QueueModuleContext {
  return Object.freeze({ database, defaultQueue, options });
}
