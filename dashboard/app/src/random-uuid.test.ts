import { describe, expect, it } from "vitest";
import { randomUuid } from "./random-uuid.js";

const version4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUuid", () => {
  it("uses crypto.randomUUID when the context is secure", () => {
    const source = {
      randomUUID: () => "00000000-0000-4000-8000-000000000000" as const,
      getRandomValues: () => {
        throw new Error("not used");
      },
    };
    expect(randomUuid(source)).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("builds a version 4 UUID from getRandomValues when randomUUID is missing", () => {
    const insecure = {
      getRandomValues: <T extends ArrayBufferView | null>(array: T) =>
        crypto.getRandomValues(array),
    };
    const values = new Set(Array.from({ length: 64 }, () => randomUuid(insecure)));
    expect(values.size).toBe(64);
    for (const value of values) expect(value).toMatch(version4);
  });

  it("sets the version and variant bits for every byte value", () => {
    for (const fill of [0x00, 0xff]) {
      const fixed = {
        getRandomValues: <T extends ArrayBufferView | null>(array: T) => {
          (array as unknown as Uint8Array).fill(fill);
          return array;
        },
      };
      expect(randomUuid(fixed)).toMatch(version4);
    }
  });
});
