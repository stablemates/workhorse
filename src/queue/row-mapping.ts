/** Convert a PostgreSQL timestamp while rejecting an invalid driver or adapter value. */
export function rowTimestamp(value: Date | string, field: string): Date {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError(`Claim returned an invalid ${field} timestamp`);
  }
  return timestamp;
}

export function nullableRowTimestamp(value: Date | string | null, field: string): Date | null {
  return value === null ? null : rowTimestamp(value, field);
}
