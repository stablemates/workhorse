import { cancellationStop, cancellationStopNarrow } from "./cancellation-diagram.js";
import {
  deliveryCheckpoints,
  deliveryCheckpointsNarrow,
  deliveryCrash,
  deliveryCrashNarrow,
} from "./delivery-guarantees-diagram.js";
import { durableWaits, durableWaitsNarrow } from "./durable-waits-diagram.js";
import { externalWaits, externalWaitsNarrow } from "./external-waits-diagram.js";
import { leasesAndFences, leasesAndFencesNarrow } from "./leases-and-fences-diagram.js";
import { readmeOverview, readmeOverviewNarrow } from "./readme-overview-diagram.js";
import {
  retryAttempts,
  retryAttemptsNarrow,
  retrySpread,
  retrySpreadNarrow,
} from "./retries-diagram.js";
import {
  signalsOnce,
  signalsOnceNarrow,
  signalsWait,
  signalsWaitNarrow,
} from "./signals-diagram.js";
import { tasksAndState, tasksAndStateNarrow } from "./tasks-and-state-diagram.js";

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
];
