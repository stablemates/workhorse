interface ConfidenceInterval {
  confidenceLevel: 0.95;
  lower: number | null;
  upper: number | null;
  marginOfError: number | null;
}

export interface NumericSummary {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  sampleStandardDeviation: number | null;
  confidenceInterval95: ConfidenceInterval;
}

export interface LatencySummary {
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

const studentTCritical95ByDegreesOfFreedom = new Map<number, number>([
  [1, 12.706],
  [2, 4.303],
  [3, 3.182],
  [4, 2.776],
  [5, 2.571],
  [6, 2.447],
  [7, 2.365],
  [8, 2.306],
  [9, 2.262],
  [10, 2.228],
  [11, 2.201],
  [12, 2.179],
  [13, 2.16],
  [14, 2.145],
  [15, 2.131],
  [16, 2.12],
  [17, 2.11],
  [18, 2.101],
  [19, 2.093],
  [20, 2.086],
  [21, 2.08],
  [22, 2.074],
  [23, 2.069],
  [24, 2.064],
  [25, 2.06],
  [26, 2.056],
  [27, 2.052],
  [28, 2.048],
  [29, 2.045],
  [30, 2.042],
  [40, 2.021],
  [60, 2.0],
  [80, 1.99],
  [100, 1.984],
  [1_000, 1.962],
]);

function sortedFiniteNumbers(values: readonly number[]): number[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  return [...values].filter(Number.isFinite).sort((left, right) => left - right);
}

function studentTCritical95(sampleCount: number): number {
  const degreesOfFreedom = sampleCount - 1;
  const exact = studentTCritical95ByDegreesOfFreedom.get(degreesOfFreedom);
  if (exact !== undefined) return exact;

  for (const [threshold, criticalValue] of studentTCritical95ByDegreesOfFreedom) {
    if (degreesOfFreedom <= threshold) return criticalValue;
  }

  return 1.96;
}

export function nearestRankPercentile(
  values: readonly number[],
  percentile: number,
): number | null {
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) {
    throw new RangeError("Percentile must be a finite number between 0 and 1.");
  }

  const sorted = sortedFiniteNumbers(values);
  if (sorted.length === 0) return null;
  if (percentile === 0) return sorted[0] ?? null;

  const index = Math.ceil(percentile * sorted.length) - 1;
  return sorted[Math.min(index, sorted.length - 1)] ?? null;
}

export function summarizeNumbers(values: readonly number[]): NumericSummary {
  const finiteValues = values.filter(Number.isFinite);
  const count = finiteValues.length;

  if (count === 0) {
    return {
      count,
      min: null,
      max: null,
      mean: null,
      sampleStandardDeviation: null,
      confidenceInterval95: {
        confidenceLevel: 0.95,
        lower: null,
        upper: null,
        marginOfError: null,
      },
    };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;

  for (const value of finiteValues) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }

  const mean = sum / count;
  const sumSquaredDifferences = finiteValues.reduce(
    (total, value) => total + (value - mean) ** 2,
    0,
  );
  const sampleStandardDeviation = count > 1 ? Math.sqrt(sumSquaredDifferences / (count - 1)) : 0;
  const marginOfError =
    count > 1 ? studentTCritical95(count) * (sampleStandardDeviation / Math.sqrt(count)) : 0;

  return {
    count,
    min,
    max,
    mean,
    sampleStandardDeviation,
    confidenceInterval95: {
      confidenceLevel: 0.95,
      lower: mean - marginOfError,
      upper: mean + marginOfError,
      marginOfError,
    },
  };
}

export function summarizeLatencies(values: readonly number[]): LatencySummary {
  return {
    p50: nearestRankPercentile(values, 0.5),
    p95: nearestRankPercentile(values, 0.95),
    p99: nearestRankPercentile(values, 0.99),
  };
}
