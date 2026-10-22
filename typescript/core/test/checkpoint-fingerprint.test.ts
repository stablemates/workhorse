import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkpointInputFingerprint } from "../src/index.js";
import type { Json } from "../src/types.js";

// Each SDK must give the same digest for the same input, so these vectors are the shared target.
// The last vector orders keys by UTF-16 code units: U+1F600 encodes as D83D DE00, before U+FB33.
// 2^53 - 1 is the largest number magnitude that an input can hold.
const vectors: Array<[Json, string]> = [
  [null, "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"],
  [true, "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b"],
  [0, "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"],
  [1.5, "9f29a130438b81170b92a42650f9a94291ecad60bd47af2a3886e75f7f728725"],
  [9_007_199_254_740_991, "f40b423c2dd95ff2b2f027e22208f438cf7242862e5e746860e697308c9add26"],
  [-9_007_199_254_740_991, "4c933a456bb8f2e9894b2d0b26480439cd72d52fb8a27cbf8fd7f323f22c7815"],
  [1e-7, "5b33e02f2c5103a05d32f6ba9cb058294452bfbf393967f68bb30c1bdcbbab22"],
  ["é", "f2886017e9c7abacf804b54d64787dce2b611c9544ba21f3affdd126a6e50086"],
  [[], "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"],
  [{}, "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
  [
    { amountCents: 1000, currency: "EUR" },
    "f5e4dce1a6a38b7186257335fb274c4221391505f139b60596c5f57ce4924471",
  ],
  [
    { b: [1, { d: 2, c: 3 }], a: "x" },
    "4bc2f0faf907fa5fdaedde9cbf7002e3cbf041208b96a4ab4ce6693fbf4bea67",
  ],
  [{ "\u{1F600}": 1, דּ: 2 }, "2aa3f5086e32bb90ce39c508a6f40fd72e792684f130d0f3b896ea191368f1e3"],
];

const boxed = (value: number) => new Number(value) as unknown as Json;

describe("checkpointInputFingerprint", () => {
  it.each(vectors)("hashes the canonical JSON of %j", (input, digest) => {
    expect(checkpointInputFingerprint(input)).toBe(digest);
  });

  it("ignores key order and gives a different digest for a different input", () => {
    const charge = { amountCents: 1000, currency: "EUR" };
    expect(checkpointInputFingerprint({ currency: "EUR", amountCents: 1000 })).toBe(
      checkpointInputFingerprint(charge),
    );
    expect(checkpointInputFingerprint({ ...charge, amountCents: 900 })).not.toBe(
      checkpointInputFingerprint(charge),
    );
    expect(checkpointInputFingerprint(-0)).toBe(checkpointInputFingerprint(0));
  });

  it("rejects an input that is not JSON with finite numbers", () => {
    expect(() => checkpointInputFingerprint({ amount: Number.NaN })).toThrow(/finite numbers/);
    expect(() => checkpointInputFingerprint(undefined as unknown as Json)).toThrow(
      /JSON serializable/,
    );
    expect(() => checkpointInputFingerprint("\uD800")).toThrow(/lone surrogate/);
    expect(() => checkpointInputFingerprint(["\uDE00x"])).toThrow(/lone surrogate/);
    expect(() => checkpointInputFingerprint({ "\uD83D": 1 })).toThrow(/lone surrogate/);
  });

  it("rejects a number larger than 2^53 - 1 in magnitude", () => {
    // A Number cannot show whether a source integer was rounded, so every SDK refuses the range.
    for (const input of [2 ** 53, -(2 ** 53), 2 ** 64, 1e21, Number.MAX_VALUE]) {
      expect(() => checkpointInputFingerprint({ id: input })).toThrow(
        new TypeError("Checkpoint input numbers must be at most 2^53 - 1 in magnitude"),
      );
    }
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
    // JSON.parse in V8 13.6 and 14.6 can read such a key as the earlier backslash key when the
    // object shape expects one next key (nodejs/node#63785). The walk does not parse JSON.
    JSON.parse('{"sm1272Order":7,"\\\\":1}');
    for (const key of ['"', "\n", "\u0001", "/"]) {
      const input = { sm1272Order: 7, [key]: 1 };
      expect(checkpointInputFingerprint(input)).toBe(sha256(canonicalText(key)));
    }
  });
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalText(key: string): string {
  return `{${JSON.stringify(key)}:1,"sm1272Order":7}`;
}
