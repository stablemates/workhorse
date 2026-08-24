import { CheckpointsProgressWaitsModule } from "./checkpoints-progress-waits.js";
import { ChildJobsModule } from "./child-jobs.js";
import { ClaimLeaseFenceModule } from "./claim-lease-fence.js";
import { CronSchedulesModule } from "./cron-schedules.js";
import { EnqueueContractsModule } from "./enqueue-contracts.js";
import type { QueueModuleContext } from "./module-context.js";
import { OperatorReadsModule } from "./operator-reads.js";
import { QueueAdministrationModule } from "./queue-administration.js";
import { RetentionMaintenanceModule } from "./retention-maintenance.js";
import { SignalsModule } from "./signals.js";
import { HumanWaitsModule } from "./human-waits.js";
import { WorkerRegistryModule } from "./worker-registry.js";

export interface CachedContractDefinition {
  readonly version: string;
  readonly contract: import("../types.js").JobContractVersion;
}

/** @internal */
export interface QueueModuleState {
  readonly currentDatabaseContracts: Map<string, CachedContractDefinition>;
  readonly retainedDatabaseContracts: Map<string, Map<string, CachedContractDefinition>>;
  contractsSynchronized: boolean;
}

/** @internal */
export function createQueueModuleState(): QueueModuleState {
  return {
    currentDatabaseContracts: new Map(),
    retainedDatabaseContracts: new Map(),
    contractsSynchronized: false,
  };
}

export interface QueueModules {
  readonly enqueueContracts: EnqueueContractsModule;
  readonly claimLeaseFence: ClaimLeaseFenceModule;
  readonly checkpointsProgressWaits: CheckpointsProgressWaitsModule;
  readonly childJobs: ChildJobsModule;
  readonly signals: SignalsModule;
  readonly humanWaits: HumanWaitsModule;
  readonly queueAdministration: QueueAdministrationModule;
  readonly workerRegistry: WorkerRegistryModule;
  readonly retentionMaintenance: RetentionMaintenanceModule;
  readonly cronSchedules: CronSchedulesModule;
  readonly operatorReads: OperatorReadsModule;
}

export function createQueueModules(
  context: QueueModuleContext,
  state: QueueModuleState = createQueueModuleState(),
): QueueModules {
  const enqueueContracts = new EnqueueContractsModule(context, state);
  return Object.freeze({
    enqueueContracts,
    claimLeaseFence: new ClaimLeaseFenceModule(context),
    checkpointsProgressWaits: new CheckpointsProgressWaitsModule(context),
    childJobs: new ChildJobsModule(context, enqueueContracts),
    signals: new SignalsModule(context),
    humanWaits: new HumanWaitsModule(context),
    queueAdministration: new QueueAdministrationModule(context),
    workerRegistry: new WorkerRegistryModule(context),
    retentionMaintenance: new RetentionMaintenanceModule(context),
    cronSchedules: new CronSchedulesModule(context, enqueueContracts),
    operatorReads: new OperatorReadsModule(context),
  });
}
