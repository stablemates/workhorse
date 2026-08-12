import { runIsolationCanary } from "./support/isolation-canary.js";

// One half of the deliberate state-leak canary; the other half is isolation-canary-a.test.ts.
// See test/support/isolation-canary.ts for what a failure here means.
runIsolationCanary(import.meta.url, "canary.b", "canary.a");
