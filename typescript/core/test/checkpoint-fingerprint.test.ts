import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { checkpointInputFingerprint } from "../src/index.js";
import type { Json } from "../src/types.js";

// `protocol/v1/checkpoint-fingerprints.json` holds the vectors that every SDK must give.
interface Vector {
  id: string;
  input: string;
  canonical?: string;
  digest?: string;
  refusal?: "loneSurrogate" | "nonFinite" | "unsafeNumber";
}

const { vectors } = JSON.parse(
  await readFile(
    new URL("../../../protocol/v1/checkpoint-fingerprints.json", import.meta.url),
    "utf8",
  ),
) as { vectors: Vector[] };

const refusals = {
  loneSurrogate: new TypeError("Checkpoint input strings must not contain a lone surrogate"),
  nonFinite: new TypeError("Checkpoint input must contain only finite numbers"),
  unsafeNumber: new TypeError("Checkpoint input numbers must be at most 2^53 - 1 in magnitude"),
};

// Each input is decoded in a new realm. JSON.parse in V8 13.6 and 14.6 (Node 24 and 26) can read
// an escaped key as a key that an earlier parse in the same realm made (nodejs/node#63785).
function decode({ input }: Vector): Json {
  return runInNewContext("JSON.parse(text)", { text: input }) as Json;
}

const digests = vectors.filter(({ refusal }) => refusal === undefined);
const refused = vectors.filter(({ refusal }) => refusal !== undefined);

function byId(id: string): Vector {
  const found = vectors.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`No vector ${id}`);
  return found;
}

const boxed = (value: number) => new Number(value) as unknown as Json;

describe("checkpointInputFingerprint", () => {
  it("states one outcome and the digest of the canonical text for each vector", () => {
    expect(vectors.length).toBeGreaterThan(0);
    expect(new Set(vectors.map(({ id }) => id)).size).toBe(vectors.length);
    expect(digests.map(({ id, digest }) => [id, digest])).toEqual(
      digests.map(({ id, canonical }) => [id, sha256(canonical ?? "")]),
    );
    expect(
      refused.filter(
        ({ canonical, digest, refusal }) =>
          canonical !== undefined || digest !== undefined || !((refusal ?? "") in refusals),
      ),
    ).toEqual([]);
  });

  it.each(digests.map((found) => [found.id, found] as const))(
    "gives the digest of the vector %s",
    (_id, found) => {
      expect(checkpointInputFingerprint(decode(found))).toBe(found.digest);
    },
  );

  it.each(refused.map((found) => [found.id, found] as const))(
    "refuses the vector %s",
    (_id, found) => {
      expect(() => checkpointInputFingerprint(decode(found))).toThrow(
        refusals[found.refusal as keyof typeof refusals],
      );
    },
  );

  it("rejects an input that is not JSON", () => {
    expect(() => checkpointInputFingerprint({ amount: Number.NaN })).toThrow(refusals.nonFinite);
    expect(() => checkpointInputFingerprint(undefined as unknown as Json)).toThrow(
      /JSON serializable/,
    );
  });

  it("checks a boxed Number as it checks the primitive", () => {
    // As in JSON.stringify, a boxed Number gives its value, so the same checks apply to it.
    expect(() => checkpointInputFingerprint([boxed(2 ** 53)])).toThrow(/at most 2\^53 - 1/);
    expect(() =>
      checkpointInputFingerprint({ toJSON: () => boxed(2 ** 53) } as unknown as Json),
    ).toThrow(/at most 2\^53 - 1/);
    expect(() => checkpointInputFingerprint({ amount: boxed(Number.NaN) })).toThrow(
      /finite numbers/,
    );
    expect(checkpointInputFingerprint([boxed(9_007_199_254_740_991)])).toBe(
      checkpointInputFingerprint([9_007_199_254_740_991]),
    );
  });

  it("applies the JSON.stringify rules for toJSON, boxed values, and dropped members", () => {
    const input = {
      at: new Date(Date.UTC(2026, 9, 22)),
      flags: [new Boolean(false), new String("x"), undefined, () => 1, Symbol("s")],
      skipped: undefined,
      handler: () => 1,
      money: { toJSON: (key: string) => ({ key, cents: 5 }) },
    } as unknown as Json;
    expect(checkpointInputFingerprint(input)).toBe(
      sha256(
        '{"at":"2026-10-22T00:00:00.000Z","flags":[false,"x",null,null,null],' +
          '"money":{"cents":5,"key":"money"}}',
      ),
    );
  });

  it("reads each member once, in the order of JSON.stringify", () => {
    let reads = 0;
    const input = {
      get b() {
        return ++reads;
      },
      get a() {
        return ++reads;
      },
    } as unknown as Json;
    expect(checkpointInputFingerprint(input)).toBe(sha256('{"a":2,"b":1}'));
    const callable = Object.assign(() => 0, { toJSON: () => 7 });
    expect(checkpointInputFingerprint({ a: callable } as unknown as Json)).toBe(sha256('{"a":7}'));
  });

  it("rejects a cycle and a BigInt", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => checkpointInputFingerprint(cycle as Json)).toThrow(TypeError);
    expect(() => checkpointInputFingerprint({ id: 1n } as unknown as Json)).toThrow(TypeError);
    // The same object can occur twice when it does not contain itself.
    const shared = { a: 1 };
    expect(checkpointInputFingerprint([shared, shared])).toBe(
      checkpointInputFingerprint([{ a: 1 }, { a: 1 }]),
    );
  });

  it("reads each escaped key after a key that ends in a backslash", () => {
    // JSON.parse in this realm makes the backslash key first. Then V8 13.6 and 14.6 can read the
    // other keys as that key (nodejs/node#63785). The fingerprint does not parse JSON.
    JSON.parse(byId("sm1272-backslash-key").input);
    const ids = ["sm1272-quote-key", "sm1272-newline-key", "sm1272-control-key"];
    expect(ids.map((id) => checkpointInputFingerprint(decode(byId(id))))).toEqual(
      ids.map((id) => byId(id).digest),
    );
  });
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
