# `@stablemates/workhorse-otel`

The free OpenTelemetry adapter for the Workhorse TypeScript package.

> **Public beta:** Workhorse is usable for evaluation and early production adoption. A 0.x minor
> release may change behaviour, so read the changelog before you upgrade. It will not ask you to
> recreate your database: migrations are ordered, and inside a major line a migration only adds, so
> a running deployment upgrades in place.

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

## Package boundary

The adapter reads telemetry providers and installs no database object. [Workhorse core](https://workhorse.run/docs/installation)
owns schema installation and changes.

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
