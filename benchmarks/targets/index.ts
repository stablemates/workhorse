import type { Pool } from "pg";
import { GraphileWorkerTarget } from "./graphile-worker.js";
import { IronshiftTarget } from "./ironshift.js";
import { PgBossTarget } from "./pg-boss.js";
export type { CompetitorTarget, TargetCapabilities, TargetMetadata, WorkItem } from "./types.js";
export { GraphileWorkerTarget, IronshiftTarget, PgBossTarget };
export async function createCompetitorTargets(
  pool: Pool,
  options: { pgBossBatchSize?: number } = {},
) {
  return [
    new IronshiftTarget(pool),
    new PgBossTarget(pool, undefined, options.pgBossBatchSize ?? 1),
    new GraphileWorkerTarget(pool),
  ] as const;
}
