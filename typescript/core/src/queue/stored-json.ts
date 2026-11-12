import { types } from "node:util";

import type { Json } from "../types.js";

/**
 * The JSON text of a value that Workhorse stores, as {@link encodeStoredJson} gave it.
 *
 * Each entry point that stores a value encodes it before its first statement, also before the
 * schema compatibility query and a contract read. Then each later step uses this text, and a
 * contract validates the value that this text holds. Thus a `toJSON` method runs one time, and the
 * statement carries the value that passed the checks.
 */
export interface EncodedJson {
  /** The JSON text that the statement sends. */
  readonly text: string;
}

/** Encode `value` with {@link encodeStoredJson}. */
export function encodeJson(value: Json, subject: string): EncodedJson {
  return { text: encodeStoredJson(value, subject) };
}

const rawJson: unknown = Reflect.get(JSON, "rawJSON");

// A number whose text a double would change stays a raw token of its source text.
const keepNumberText = (_key: string, parsed: unknown, context?: { source?: string }): unknown =>
  typeof parsed === "number" &&
  typeof rawJson === "function" &&
  context?.source !== undefined &&
  String(parsed) !== context.source
    ? rawJson(context.source)
    : parsed;

/**
 * Encode `value` with {@link encodeStoredJson}, and give back a plain JSON copy of the encoded text.
 *
 * A step that checks a value before a statement, and then gives the value to an API that takes a
 * value and not a text, gives it this copy. The copy has no `toJSON` method and no shared object,
 * so its encoding gives the same text, and a later change of the original does not reach it. A
 * number whose text a double would change, such as a `JSON.rawJSON` token, stays a raw token.
 */
export function checkedCopy<TValue>(value: TValue, subject: string): TValue {
  // The reviver reads only numbers, so the parsed value has the shape of the text that the
  // encoder checked.
  return parseExactJson(encodeStoredJson(value, subject)) as TValue;
}

/** Parse JSON text, and keep each number token whose text a double would change as a raw token. */
function parseExactJson(text: string): unknown {
  return JSON.parse(text, keepNumberText);
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

// The decimal value of a JSON number token, in one form for each value: `1.0`, `1`, and `1e0` give
// the same key. A token that is not a decimal gives itself.
function decimalKey(token: string): string {
  const match = DECIMAL.exec(token);
  if (match === null) return token;
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match;
  const digits = `${whole}${fraction}`.replace(/^0+/, "");
  const significant = digits.replace(/0+$/, "");
  if (significant === "") return "0";
  const scale = Number(exponent) - fraction.length + (digits.length - significant.length);
  return `${sign}${significant}e${scale}`;
}

// Marks a number token that a double cannot hold exactly.
class InexactNumber extends Error {}

const exactNumber = (_key: string, parsed: unknown, context?: { source?: string }): unknown => {
  if (typeof parsed !== "number" || context?.source === undefined) return parsed;
  if (decimalKey(String(parsed)) !== decimalKey(context.source)) throw new InexactNumber();
  return parsed;
};

/**
 * Parse JSON text for a contract check. Each number token reaches the check as a number with the
 * same decimal value, so `1.0` reads as `1`. If a double cannot hold the decimal value of a token
 * exactly, the result is `undefined`, because a check of the rounded number would not check the
 * stored number.
 */
export function parseContractJson(text: string): unknown {
  try {
    return JSON.parse(text, exactNumber);
  } catch (error) {
    if (error instanceof InexactNumber) return undefined;
    throw error;
  }
}

/**
 * Encode a value that Workhorse stores as JSON, and refuse a value that would not read back as the
 * caller gave it.
 *
 * `JSON.stringify` writes NaN and the infinities as `null`, and it writes a `Map` or a `Set` as
 * `{}`. Thus a stored value could differ from the value of the caller with no error. This encoder
 * throws a `TypeError` for such a value at any depth, before the statement that writes it. The
 * message starts with `subject` and names the path of the value, such as `$.items[2]`.
 *
 * The other JSON rules do not change: a `toJSON` method applies first, an `undefined` property
 * of an object is left out, and an `undefined` member of an array becomes `null`. A value that has
 * no JSON text at the top level, such as `undefined`, throws a `TypeError`.
 */
export function encodeStoredJson(value: unknown, subject: string): string {
  const paths = new Map<unknown, string>();
  const encoded: string | undefined = JSON.stringify(
    value,
    function (this: unknown, key: string, nested: unknown): unknown {
      const holderPath = paths.get(this);
      const path = holderPath === undefined ? "$" : memberPath(holderPath, this, key);
      // JSON.stringify converts a boxed number with ToNumber, which can run user code. The encoder
      // converts it one time here and writes that primitive, so the check reads the number that
      // is stored. Unary plus is ToNumber, so a bigint from valueOf throws, as in JSON.stringify.
      const number = types.isNumberObject(nested) ? +nested : nested;
      if (typeof number === "number" && !Number.isFinite(number)) {
        throw new TypeError(
          `${subject} must contain only finite numbers, but ${path} is ${String(number)}`,
        );
      }
      if (number !== nested) return number;
      if (types.isMap(nested) || types.isSet(nested)) {
        const kind = types.isMap(nested) ? "Map" : "Set";
        throw new TypeError(
          `${subject} must contain only JSON values, but ${path} is a ${kind}, which JSON writes as {}`,
        );
      }
      if (typeof nested === "object" && nested !== null) paths.set(nested, path);
      return nested;
    },
  );
  if (encoded === undefined) throw new TypeError(`${subject} must be JSON serializable`);
  return encoded;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function memberPath(holderPath: string, holder: unknown, key: string): string {
  if (Array.isArray(holder)) return `${holderPath}[${key}]`;
  return IDENTIFIER.test(key) ? `${holderPath}.${key}` : `${holderPath}[${JSON.stringify(key)}]`;
}
