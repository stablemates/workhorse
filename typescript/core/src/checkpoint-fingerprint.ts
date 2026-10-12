import { createHash } from "node:crypto";
import type { Json } from "./types.js";

/**
 * Return the input fingerprint that a checkpoint stores for one input: the SHA-256 digest of the
 * canonical JSON form of the input (RFC 8785), as 64 lowercase hexadecimal characters.
 *
 * The canonical form sorts the keys of each object by their UTF-16 code units and writes no
 * whitespace. Numbers and strings use the `JSON.stringify` form. Thus two inputs that differ only
 * in key order have the same fingerprint. The input must be JSON with finite numbers, and its
 * strings and keys must be well-formed UTF-16, as RFC 8785 requires. As for a stored value, a
 * `toJSON` method applies first.
 */
export function checkpointInputFingerprint(input: Json): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

/** A valid input fingerprint, as `save_checkpoint_v2` accepts it. */
export const CHECKPOINT_INPUT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

// With the u flag, a surrogate range matches only a surrogate that is not part of a pair.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function wellFormed(text: string): string {
  if (LONE_SURROGATE.test(text)) {
    throw new TypeError("Checkpoint input strings must not contain a lone surrogate");
  }
  return text;
}

function canonicalJson(input: Json): string {
  // A round trip applies toJSON and drops undefined object members, as a stored value does.
  const encoded = JSON.stringify(input, (_key, nested: unknown) => {
    if (typeof nested === "number" && !Number.isFinite(nested)) {
      throw new TypeError("Checkpoint input must contain only finite numbers");
    }
    return nested;
  });
  if (encoded === undefined) throw new TypeError("Checkpoint input must be JSON serializable");
  return canonical(JSON.parse(encoded) as unknown);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // The default sort compares UTF-16 code units, which is the order RFC 8785 requires.
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    const keys = Object.keys(record).sort();
    const members = keys.map(
      (key) => `${JSON.stringify(wellFormed(key))}:${canonical(record[key])}`,
    );
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(typeof value === "string" ? wellFormed(value) : value);
}
