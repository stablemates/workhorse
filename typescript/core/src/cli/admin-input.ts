import { readFile } from "node:fs/promises";
import type { Json } from "../types.js";
import { CliUsageError } from "./arguments.js";

/** Preserve PostgreSQL timestamp precision by treating cursor fields as opaque strings. */
export function parseCursor<const K extends string>(
  value: string | undefined,
  fields: readonly K[],
): Record<K, string> | undefined {
  if (value === undefined) return undefined;
  const malformed = new CliUsageError(
    `--cursor must be a JSON nextCursor object with non-empty string fields: ${fields.join(", ")}`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw malformed;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw malformed;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length) throw malformed;
  for (const field of fields) {
    if (typeof record[field] !== "string" || record[field] === "") throw malformed;
  }
  return record as Record<K, string>;
}

/** Reject ambiguous local timestamps so scripts select the same interval on every host. */
export function parseDateRange(
  after: string | undefined,
  before: string | undefined,
  prefix: "created" | "finished",
): [Date | undefined, Date | undefined] {
  const parse = (value: string | undefined, suffix: string): Date | undefined => {
    if (value === undefined) return undefined;
    const date = new Date(value);
    if (
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
      !Number.isFinite(date.getTime())
    ) {
      throw new CliUsageError(`--${prefix}-${suffix} must be an ISO timestamp with a timezone`);
    }
    return date;
  };
  const lower = parse(after, "after");
  const upper = parse(before, "before");
  if (lower !== undefined && upper !== undefined && lower >= upper) {
    throw new CliUsageError(`--${prefix}-after must be earlier than --${prefix}-before`);
  }
  return [lower, upper];
}

export async function readDeliveryPayload(
  json: string | undefined,
  file: string | undefined,
): Promise<Json> {
  if ((json === undefined) === (file === undefined)) {
    throw new CliUsageError("Supply exactly one of --payload-json <json> or --payload-file <path>");
  }
  let source = json;
  if (file !== undefined) {
    try {
      source = await readFile(file, "utf8");
    } catch {
      throw new CliUsageError("Could not read --payload-file");
    }
  }
  try {
    return JSON.parse(source!, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError("Non-finite JSON number");
      }
      return value;
    }) as Json;
  } catch {
    throw new CliUsageError("Delivery payload must be valid JSON");
  }
}

export function continuationHint(cursor: object | null): string {
  return cursor === null
    ? ""
    : `Next cursor (pass as --cursor with the same filters): ${JSON.stringify(cursor)}\n`;
}
