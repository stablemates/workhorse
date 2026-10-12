import { describe, expect, it } from "vitest";
import { checkpointInputFingerprint } from "../src/index.js";
import type { Json } from "../src/types.js";

// Each SDK must give the same digest for the same input, so these vectors are the shared target.
// The last vector orders keys by UTF-16 code units: U+1F600 encodes as D83D DE00, before U+FB33.
const vectors: Array<[Json, string]> = [
  [null, "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"],
  [true, "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b"],
  [0, "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"],
  [1.5, "9f29a130438b81170b92a42650f9a94291ecad60bd47af2a3886e75f7f728725"],
  [1e21, "241c4643fa70b1dcde1205b71be4e3bebb17e9f880c8e1a33d0ead6c27271d3c"],
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
});
