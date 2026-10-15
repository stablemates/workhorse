import { adminGuard, adminGuardNarrow, adminWaits, adminWaitsNarrow } from "./admin-cli-diagram.js";
import { integrationParts, integrationPartsNarrow } from "./agent-integration-diagram.js";
import { installationOrder, installationOrderNarrow } from "./installation-diagram.js";
import { migrateTaskType, migrateTaskTypeNarrow } from "./migrate-diagram.js";
import { progressWrite, progressWriteNarrow } from "./progress-diagram.js";
import { queryReads, queryReadsNarrow } from "./queries-diagram.js";
import { languageParts, languagePartsNarrow } from "./limitations-diagram.js";
import { agentLoop, agentLoopNarrow } from "./agentic-flow-diagram.js";
import {
  batchOutcomes,
  batchOutcomesNarrow,
  batchTiming,
  batchTimingNarrow,
} from "./batch-handlers-diagram.js";
import { cancellationStop, cancellationStopNarrow } from "./cancellation-diagram.js";
import { childJoin, childJoinNarrow, childModes, childModesNarrow } from "./child-tasks-diagram.js";
import {
  policyBudget,
  policyBudgetNarrow,
  policyKeys,
  policyKeysNarrow,
} from "./concurrency-policies-diagram.js";
import {
  dashboardAuthorize,
  dashboardAuthorizeNarrow,
} from "./dashboard-authentication-diagram.js";
import {
  debouncePreserve,
  debouncePreserveNarrow,
  debounceReset,
  debounceResetNarrow,
} from "./debounce-diagram.js";
import { coldExportDay, coldExportDayNarrow } from "./cold-export-diagram.js";
import {
  poolerBudget,
  poolerBudgetNarrow,
  poolerPaths,
  poolerPathsNarrow,
} from "./connection-pooling-diagram.js";
import {
  deliveryCheckpoints,
  deliveryCheckpointsNarrow,
  deliveryCrash,
  deliveryCrashNarrow,
} from "./delivery-guarantees-diagram.js";
import {
  deadlineEnds,
  deadlineEndsNarrow,
  timeoutEnds,
  timeoutEndsNarrow,
} from "./deadlines-diagram.js";
import { durableWaits, durableWaitsNarrow } from "./durable-waits-diagram.js";
import { externalWaits, externalWaitsNarrow } from "./external-waits-diagram.js";
import { tierWrites, tierWritesNarrow } from "./fast-tier-diagram.js";
import {
  humanEnds,
  humanEndsNarrow,
  humanWait,
  humanWaitNarrow,
} from "./human-decisions-diagram.js";
import {
  idempotencyLifetime,
  idempotencyLifetimeNarrow,
  idempotencyOutcomes,
  idempotencyOutcomesNarrow,
} from "./idempotency-diagram.js";
import { leasesAndFences, leasesAndFencesNarrow } from "./leases-and-fences-diagram.js";
import {
  priorityAdmission,
  priorityAdmissionNarrow,
  priorityOrder,
  priorityOrderNarrow,
} from "./priority-diagram.js";
import {
  tenantModels,
  tenantModelsNarrow,
  tenantOptions,
  tenantOptionsNarrow,
} from "./multi-tenancy-diagram.js";
import { metricSources, metricSourcesNarrow } from "./observability-diagram.js";
import { contractChecks, contractChecksNarrow } from "./payload-contracts-diagram.js";
import { traceAcrossQueue, traceAcrossQueueNarrow } from "./production-telemetry-diagram.js";
import { readmeOverview, readmeOverviewNarrow } from "./readme-overview-diagram.js";
import {
  healthSnapshot,
  healthSnapshotNarrow,
  healthVerdict,
  healthVerdictNarrow,
} from "./queue-health-diagram.js";
import { quickstartCrash, quickstartCrashNarrow } from "./quickstart-diagram.js";
import { rateBucket, rateBucketNarrow, rateKeys, rateKeysNarrow } from "./rate-limits-diagram.js";
import {
  redriveCopy,
  redriveCopyNarrow,
  redriveLineage,
  redriveLineageNarrow,
} from "./redrive-diagram.js";
import { retentionWindow, retentionWindowNarrow } from "./retention-diagram.js";
import {
  retryAttempts,
  retryAttemptsNarrow,
  retrySpread,
  retrySpreadNarrow,
} from "./retries-diagram.js";
import { scheduleCatchup, scheduleCatchupNarrow } from "./schedules-diagram.js";
import {
  serverlessRuntimes,
  serverlessRuntimesNarrow,
  serverlessTiers,
  serverlessTiersNarrow,
} from "./serverless-diagram.js";
import {
  signalsOnce,
  signalsOnceNarrow,
  signalsWait,
  signalsWaitNarrow,
} from "./signals-diagram.js";
import {
  dependenciesFail,
  dependenciesFailNarrow,
  dependenciesRelease,
  dependenciesReleaseNarrow,
} from "./task-dependencies-diagram.js";
import {
  groupFinish,
  groupFinishNarrow,
  groupStates,
  groupStatesNarrow,
} from "./task-groups-diagram.js";
import {
  statisticsTiers,
  statisticsTiersNarrow,
  statisticsWindow,
  statisticsWindowNarrow,
} from "./statistics-diagram.js";
import { tasksAndState, tasksAndStateNarrow } from "./tasks-and-state-diagram.js";
import { workerSlots, workerSlotsNarrow } from "./workers-diagram.js";
import { throttleWindow, throttleWindowNarrow } from "./throttle-diagram.js";
import { enqueueOutcomes, enqueueOutcomesNarrow } from "./transactional-enqueue-diagram.js";

/** Every diagram that `pnpm diagrams:generate` writes to `site/public/diagrams/`. */
export const diagrams = [
  readmeOverview,
  readmeOverviewNarrow,
  durableWaits,
  durableWaitsNarrow,
  tasksAndState,
  tasksAndStateNarrow,
  leasesAndFences,
  leasesAndFencesNarrow,
  deliveryCrash,
  deliveryCrashNarrow,
  deliveryCheckpoints,
  deliveryCheckpointsNarrow,
  retryAttempts,
  retryAttemptsNarrow,
  retrySpread,
  retrySpreadNarrow,
  cancellationStop,
  cancellationStopNarrow,
  externalWaits,
  externalWaitsNarrow,
  signalsWait,
  signalsWaitNarrow,
  signalsOnce,
  signalsOnceNarrow,
  deadlineEnds,
  deadlineEndsNarrow,
  timeoutEnds,
  timeoutEndsNarrow,
  humanWait,
  humanWaitNarrow,
  humanEnds,
  humanEndsNarrow,
  priorityOrder,
  priorityOrderNarrow,
  priorityAdmission,
  priorityAdmissionNarrow,
  childJoin,
  childJoinNarrow,
  childModes,
  childModesNarrow,
  dependenciesRelease,
  dependenciesReleaseNarrow,
  dependenciesFail,
  dependenciesFailNarrow,
  groupFinish,
  groupFinishNarrow,
  groupStates,
  groupStatesNarrow,
  agentLoop,
  agentLoopNarrow,
  enqueueOutcomes,
  enqueueOutcomesNarrow,
  idempotencyOutcomes,
  idempotencyOutcomesNarrow,
  idempotencyLifetime,
  idempotencyLifetimeNarrow,
  debounceReset,
  debounceResetNarrow,
  debouncePreserve,
  debouncePreserveNarrow,
  throttleWindow,
  throttleWindowNarrow,
  scheduleCatchup,
  scheduleCatchupNarrow,
  contractChecks,
  contractChecksNarrow,
  policyKeys,
  policyKeysNarrow,
  policyBudget,
  policyBudgetNarrow,
  rateBucket,
  rateBucketNarrow,
  rateKeys,
  rateKeysNarrow,
  tenantOptions,
  tenantOptionsNarrow,
  tenantModels,
  tenantModelsNarrow,
  tierWrites,
  tierWritesNarrow,
  workerSlots,
  workerSlotsNarrow,
  batchTiming,
  batchTimingNarrow,
  batchOutcomes,
  batchOutcomesNarrow,
  statisticsTiers,
  statisticsTiersNarrow,
  statisticsWindow,
  statisticsWindowNarrow,
  retentionWindow,
  retentionWindowNarrow,
  coldExportDay,
  coldExportDayNarrow,
  redriveCopy,
  redriveCopyNarrow,
  redriveLineage,
  redriveLineageNarrow,
  traceAcrossQueue,
  traceAcrossQueueNarrow,
  metricSources,
  metricSourcesNarrow,
  healthSnapshot,
  healthSnapshotNarrow,
  healthVerdict,
  healthVerdictNarrow,
  dashboardAuthorize,
  dashboardAuthorizeNarrow,
  adminWaits,
  adminWaitsNarrow,
  adminGuard,
  adminGuardNarrow,
  integrationParts,
  integrationPartsNarrow,
  poolerPaths,
  poolerPathsNarrow,
  poolerBudget,
  poolerBudgetNarrow,
  serverlessRuntimes,
  serverlessRuntimesNarrow,
  serverlessTiers,
  serverlessTiersNarrow,
  quickstartCrash,
  quickstartCrashNarrow,
  installationOrder,
  installationOrderNarrow,
  migrateTaskType,
  migrateTaskTypeNarrow,
  progressWrite,
  progressWriteNarrow,
  queryReads,
  queryReadsNarrow,
  languageParts,
  languagePartsNarrow,
];
