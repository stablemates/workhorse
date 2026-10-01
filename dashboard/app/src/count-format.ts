const countFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * Exact counts read with grouped digits. The locale is fixed so a count reads
 * the same in every browser and in tests; estimated row counts use `formatRows`.
 */
export function formatCount(count: number): string {
  return countFormatter.format(count);
}
