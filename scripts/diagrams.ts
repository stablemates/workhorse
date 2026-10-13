import { durableWaits, durableWaitsNarrow } from "./durable-waits-diagram.js";
import { readmeOverview, readmeOverviewNarrow } from "./readme-overview-diagram.js";

/** Every diagram that `pnpm diagrams:generate` writes to `site/public/diagrams/`. */
export const diagrams = [readmeOverview, readmeOverviewNarrow, durableWaits, durableWaitsNarrow];
