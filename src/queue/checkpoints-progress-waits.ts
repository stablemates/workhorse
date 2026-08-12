import { QueueModule } from "./module-context.js";

/** Receives checkpoint, progress, and durable-wait behavior as it leaves the Queue facade. */
export class CheckpointsProgressWaitsModule extends QueueModule {}
