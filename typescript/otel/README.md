# `@stablemates/workhorse-otel`

The free OpenTelemetry adapter for the Workhorse TypeScript package.

> **Public beta:** Workhorse is usable for evaluation and early production adoption, but 0.x minor
> releases may break compatibility, including the schema. There is no upgrade path between 0.x
> releases; ordered migrations begin at 1.0.0.

## Install

```bash
npm install @stablemates/workhorse @stablemates/workhorse-otel @opentelemetry/api @opentelemetry/api-logs
```

## Register OpenTelemetry

Configure the OpenTelemetry global providers first, then register the adapter once during process
startup. Importing this package has no side effects.

```ts
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";

const unregister = registerOpenTelemetry();

// Stop workers and observers before unregistering during process shutdown.
unregister();
```

Workhorse uses the host application's global tracer, meter, logger, context, and propagation
providers. A second active Workhorse telemetry provider is rejected instead of silently replacing
the first one.

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
