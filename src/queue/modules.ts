import { CheckpointsProgressWaitsModule } from "./checkpoints-progress-waits.js";
import { ClaimLeaseFenceModule } from "./claim-lease-fence.js";
import { CronSchedulesModule } from "./cron-schedules.js";
import { EnqueueContractsModule } from "./enqueue-contracts.js";
import type { QueueModuleContext } from "./module-context.js";
import { OperatorReadsModule } from "./operator-reads.js";
import { QueueAdministrationModule } from "./queue-administration.js";
import { RetentionMaintenanceModule } from "./retention-maintenance.js";
import { WorkerRegistryModule } from "./worker-registry.js";

export interface QueueModules {
  readonly enqueueContracts: EnqueueContractsModule;
  readonly claimLeaseFence: ClaimLeaseFenceModule;
  readonly checkpointsProgressWaits: CheckpointsProgressWaitsModule;
  readonly queueAdministration: QueueAdministrationModule;
  readonly workerRegistry: WorkerRegistryModule;
  readonly retentionMaintenance: RetentionMaintenanceModule;
  readonly cronSchedules: CronSchedulesModule;
  readonly operatorReads: OperatorReadsModule;
}

export function createQueueModules(context: QueueModuleContext): QueueModules {
  const enqueueContracts = new EnqueueContractsModule(context);
  return Object.freeze({
    enqueueContracts,
    claimLeaseFence: new ClaimLeaseFenceModule(context),
    checkpointsProgressWaits: new CheckpointsProgressWaitsModule(context),
    queueAdministration: new QueueAdministrationModule(context),
    workerRegistry: new WorkerRegistryModule(context),
    retentionMaintenance: new RetentionMaintenanceModule(context),
    cronSchedules: new CronSchedulesModule(context, enqueueContracts),
    operatorReads: new OperatorReadsModule(context),
  });
}
