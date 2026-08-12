import { QueueModule } from "./module-context.js";

/** Receives claim, lease, and fence behavior as it leaves the Queue facade. */
export class ClaimLeaseFenceModule extends QueueModule {}
