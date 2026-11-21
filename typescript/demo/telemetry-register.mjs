// Registers the Workhorse OpenTelemetry provider. It loads after `telemetry.cjs`, with `--import`.
//
// The provider is process-wide state of `@stablemates/workhorse`, so it must go to the module
// instance that the application imports. A `require` from the CommonJS preload does not give that
// instance under the `tsx` loader of the development demo: it loads the TypeScript sources a second
// time as CommonJS, so no SDK record of the server or the worker reached the log file. An ESM
// preload resolves the same module as the application in both modes.
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";

const unregister = registerOpenTelemetry();
// `telemetry.cjs` calls this before it shuts the OpenTelemetry SDK down.
globalThis[Symbol.for("workhorse.demo.unregisterOpenTelemetry")] = unregister;
