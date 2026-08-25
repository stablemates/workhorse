/**
 * Measures the two competing metric instrument lifecycles that core currently ships.
 *
 * `src/metrics.ts` creates every instrument once at module evaluation and calls it directly
 * (the eager lifecycle). `src/telemetry.ts` creates each instrument on first emission and
 * re-creates it whenever the global MeterProvider changes (the lazy lifecycle).
 *
 * The benchmark reports per-emission cost for both lifecycles with telemetry off (no provider
 * registered) and telemetry on (an SDK MeterProvider aggregating into memory), plus a
 * registration-order check that records whether each lifecycle still reaches a provider
 * registered after the instrumentation module loaded.
 *
 * This is a deliberate microbenchmark. Emission cost is nanoseconds per call and disappears
 * under PostgreSQL round trips, so a throughput scenario cannot separate the two lifecycles;
 * see ADR 0024.
 */
import { performance } from "node:perf_hooks";
import { metrics, type Attributes, type Counter, type MetricOptions } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { summarizeNumbers, type NumericSummary } from "./statistics.js";

const INSTRUMENTATION_NAME = "@stablemates/workhorse-benchmark.metrics-lifecycle";

type MetricsLifecycleName = "eager" | "lazy";
type MetricsProviderState = "off" | "on";

export interface MetricsLifecycleOptions {
  /** Emissions per repetition. */
  emissionsPerRepetition?: number;
  /** Measured repetitions per lifecycle and provider state. */
  repetitions?: number;
  /** Discarded warmup repetitions per lifecycle and provider state. */
  warmupRepetitions?: number;
}

export interface ResolvedMetricsLifecycleOptions {
  emissionsPerRepetition: number;
  repetitions: number;
  warmupRepetitions: number;
}

interface MetricsLifecycleMeasurement {
  lifecycle: MetricsLifecycleName;
  provider: MetricsProviderState;
  /** Per-emission cost in nanoseconds, one sample per repetition. */
  nanosecondsPerEmission: NumericSummary;
}

interface MetricsLifecycleRegistrationCheck {
  lifecycle: MetricsLifecycleName;
  /** Emissions made before any provider was registered. */
  emissionsBeforeRegistration: number;
  /** Emissions made after a provider was registered. */
  emissionsAfterRegistration: number;
  /** Sum the registered provider actually collected. */
  collectedAfterRegistration: number | null;
  /** Whether post-registration emissions reached the late-registered provider. */
  reachesLateProvider: boolean;
}

export interface MetricsLifecycleReport {
  options: ResolvedMetricsLifecycleOptions;
  measurements: MetricsLifecycleMeasurement[];
  registration: MetricsLifecycleRegistrationCheck[];
}

const defaultOptions: ResolvedMetricsLifecycleOptions = {
  emissionsPerRepetition: 1_000_000,
  repetitions: 12,
  warmupRepetitions: 3,
};

export function resolveMetricsLifecycleOptions(
  options: MetricsLifecycleOptions = {},
): ResolvedMetricsLifecycleOptions {
  const resolved = {
    emissionsPerRepetition: options.emissionsPerRepetition ?? defaultOptions.emissionsPerRepetition,
    repetitions: options.repetitions ?? defaultOptions.repetitions,
    warmupRepetitions: options.warmupRepetitions ?? defaultOptions.warmupRepetitions,
  };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${key} must be a non-negative safe integer`);
    }
  }
  if (resolved.emissionsPerRepetition < 1) {
    throw new RangeError("emissionsPerRepetition must be at least 1");
  }
  if (resolved.repetitions < 1) throw new RangeError("repetitions must be at least 1");
  return resolved;
}

/** The eager lifecycle: one instrument resolved at construction, then called directly. */
function eagerCounter(name: string, options: MetricOptions): Pick<Counter, "add"> {
  return metrics.getMeter(INSTRUMENTATION_NAME).createCounter(name, options);
}

/**
 * The lazy lifecycle, replicating `lazyCounter` in `src/telemetry.ts`: the global provider is
 * read on every emission and the instrument is rebuilt whenever that provider changes.
 */
function lazyCounter(name: string, options: MetricOptions): Pick<Counter, "add"> {
  let instrument: Counter | undefined;
  let provider = metrics.getMeterProvider();
  return {
    add(value, attributes) {
      const activeProvider = metrics.getMeterProvider();
      if (instrument === undefined || activeProvider !== provider) {
        provider = activeProvider;
        instrument = metrics.getMeter(INSTRUMENTATION_NAME).createCounter(name, options);
      }
      instrument.add(value, attributes);
    },
  };
}

const counterOptions: MetricOptions = {
  description: "Metric lifecycle benchmark emissions",
  unit: "{emission}",
};

/**
 * Attributes matching a real core emission: `recordClaimedJob` and `telemetryMetrics.claimed`
 * both carry a queue name and a job type.
 */
function emissionAttributes(iteration: number): Attributes {
  return {
    "workhorse.queue.name": iteration % 2 === 0 ? "default" : "priority",
    "workhorse.job.type": "benchmark.emit",
  };
}

function createProvider(): { provider: MeterProvider; exporter: InMemoryMetricExporter } {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        // Long enough that no periodic collection runs mid-measurement.
        exportIntervalMillis: 600_000,
        exportTimeoutMillis: 30_000,
      }),
    ],
  });
  return { provider, exporter };
}

function timeEmissions(instrument: Pick<Counter, "add">, emissions: number): number {
  const start = performance.now();
  for (let iteration = 0; iteration < emissions; iteration += 1) {
    instrument.add(1, emissionAttributes(iteration));
  }
  return performance.now() - start;
}

function buildInstrument(lifecycle: MetricsLifecycleName, name: string): Pick<Counter, "add"> {
  return lifecycle === "eager"
    ? eagerCounter(name, counterOptions)
    : lazyCounter(name, counterOptions);
}

async function measure(
  lifecycle: MetricsLifecycleName,
  provider: MetricsProviderState,
  options: ResolvedMetricsLifecycleOptions,
): Promise<MetricsLifecycleMeasurement> {
  metrics.disable();
  let registered: MeterProvider | undefined;
  if (provider === "on") {
    const created = createProvider();
    registered = created.provider;
    metrics.setGlobalMeterProvider(created.provider);
  }

  const samples: number[] = [];
  const totalRepetitions = options.warmupRepetitions + options.repetitions;
  for (let repetition = 0; repetition < totalRepetitions; repetition += 1) {
    // A fresh instrument per repetition keeps the lazy first-emission construction in the
    // measured window, which is where the two lifecycles genuinely differ.
    const instrument = buildInstrument(
      lifecycle,
      `workhorse.benchmark.${lifecycle}.${provider}.${repetition}`,
    );
    const elapsedMs = timeEmissions(instrument, options.emissionsPerRepetition);
    if (repetition >= options.warmupRepetitions) {
      samples.push((elapsedMs * 1_000_000) / options.emissionsPerRepetition);
    }
  }

  if (registered !== undefined) await registered.shutdown();
  metrics.disable();

  return { lifecycle, provider, nanosecondsPerEmission: summarizeNumbers(samples) };
}

/**
 * Emits through an instrument built before any provider exists, registers a provider, emits
 * again, and reports what the late provider actually collected.
 */
async function checkRegistrationOrder(
  lifecycle: MetricsLifecycleName,
): Promise<MetricsLifecycleRegistrationCheck> {
  metrics.disable();
  const emissionsBeforeRegistration = 3;
  const emissionsAfterRegistration = 5;
  const name = `workhorse.benchmark.registration.${lifecycle}`;
  const instrument = buildInstrument(lifecycle, name);
  for (let emission = 0; emission < emissionsBeforeRegistration; emission += 1) {
    instrument.add(1, emissionAttributes(emission));
  }

  const { provider, exporter } = createProvider();
  metrics.setGlobalMeterProvider(provider);
  for (let emission = 0; emission < emissionsAfterRegistration; emission += 1) {
    instrument.add(1, emissionAttributes(emission));
  }

  await provider.forceFlush();
  let collectedAfterRegistration: number | null = null;
  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        if (metric.descriptor.name !== name) continue;
        collectedAfterRegistration = metric.dataPoints.reduce(
          (total, point) => total + Number(point.value),
          0,
        );
      }
    }
  }
  await provider.shutdown();
  metrics.disable();

  return {
    lifecycle,
    emissionsBeforeRegistration,
    emissionsAfterRegistration,
    collectedAfterRegistration,
    reachesLateProvider: collectedAfterRegistration === emissionsAfterRegistration,
  };
}

export async function runMetricsLifecycleBenchmark(
  options: MetricsLifecycleOptions = {},
): Promise<MetricsLifecycleReport> {
  const resolved = resolveMetricsLifecycleOptions(options);
  const measurements: MetricsLifecycleMeasurement[] = [];
  // Interleave lifecycles within each provider state so machine drift hits both equally.
  for (const provider of ["off", "on"] as const) {
    for (const lifecycle of ["eager", "lazy"] as const) {
      measurements.push(await measure(lifecycle, provider, resolved));
    }
  }

  const registration: MetricsLifecycleRegistrationCheck[] = [];
  for (const lifecycle of ["eager", "lazy"] as const) {
    registration.push(await checkRegistrationOrder(lifecycle));
  }

  return { options: resolved, measurements, registration };
}
