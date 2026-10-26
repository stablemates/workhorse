import { createHash } from "node:crypto";
import type { Json } from "./types.js";

/**
 * Return the input fingerprint that a checkpoint stores for one input: the SHA-256 digest of the
 * canonical JSON form of the input (RFC 8785), as 64 lowercase hexadecimal characters.
 *
 * The canonical form sorts the keys of each object by their UTF-16 code units and writes no
 * whitespace. Numbers and strings use the `JSON.stringify` form. Thus two inputs that differ only
 * in key order have the same fingerprint. The input must be JSON, and its strings and keys must be
 * well-formed UTF-16, as RFC 8785 requires. Each number must be finite and at most 2^53 - 1 in
 * magnitude. A larger number can be an integer that was rounded before this call, so every SDK
 * refuses it (ADR 0098). As for a stored value, a `toJSON` method applies first.
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
    const value = unboxedNumber(nested);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError("Checkpoint input must contain only finite numbers");
      }
      // Each double of 2^53 or more in magnitude is an integer, so this refuses no fraction.
      if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        throw new TypeError("Checkpoint input numbers must be at most 2^53 - 1 in magnitude");
      }
    }
    return nested;
  });
  if (encoded === undefined) throw new TypeError("Checkpoint input must be JSON serializable");
  return canonicalText(encoded, wellFormed, (value) => JSON.stringify(value));
}

// JSON.stringify gives a boxed Number to the replacer as an object, then writes its value. The
// valueOf call throws for any other object, in any realm.
function unboxedNumber(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  try {
    return Number.prototype.valueOf.call(value);
  } catch {
    return value;
  }
}

/**
 * Read JSON.stringify output and write its canonical form: the keys of each object in UTF-16 order,
 * and each string in the JSON.stringify form. `checkString` sees each decoded string and key, and
 * can refuse it. `writeNumber` writes each number, which is a token of a JSON.rawJSON value or the
 * JSON.stringify form of a finite double.
 *
 * This does not use JSON.parse, because JSON.parse before Node 24.22.1 and 26.12.1 can read an
 * escaped key as a key that an earlier parse made (nodejs/node#63785). Then one input could have two
 * fingerprints. The text must be JSON.stringify output, so it has no whitespace and no duplicate
 * keys.
 */
export function canonicalText(
  text: string,
  checkString: (text: string) => string,
  writeNumber: (value: number) => string,
): string {
  let index = 0;

  const readString = (): string => {
    let decoded = "";
    let start = ++index;
    for (;;) {
      const char = text[index];
      if (char === '"') break;
      if (char !== "\\") {
        index++;
        continue;
      }
      decoded += text.slice(start, index);
      const escape = text[index + 1] as string;
      if (escape === "u") {
        decoded += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
        index += 6;
      } else {
        decoded += ESCAPED[escape];
        index += 2;
      }
      start = index;
    }
    decoded += text.slice(start, index++);
    return checkString(decoded);
  };

  const readValue = (): string => {
    const char = text[index];
    if (char === "[") {
      const items: string[] = [];
      if (text[++index] === "]") index++;
      else {
        do items.push(readValue());
        while (text[index++] === ",");
      }
      return `[${items.join(",")}]`;
    }
    if (char === "{") {
      const members: Array<[string, string]> = [];
      if (text[++index] === "}") index++;
      else {
        do {
          const key = readString();
          index++;
          members.push([key, readValue()]);
        } while (text[index++] === ",");
      }
      // The < operator compares UTF-16 code units, which is the order RFC 8785 requires.
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
      members.sort(([left], [right]) => (left < right ? -1 : 1));
      return `{${members.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`;
    }
    if (char === '"') return JSON.stringify(readString());
    const start = index;
    while (index < text.length && !",]}".includes(text[index] as string)) index++;
    const token = text.slice(start, index);
    return token === "true" || token === "false" || token === "null"
      ? token
      : writeNumber(Number(token));
  };

  return readValue();
}

const ESCAPED: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
