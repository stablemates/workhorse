import { types } from "node:util";

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
