import { describe, expect, it } from "vitest";
import { requireDevelopmentApiPort } from "./development-port.js";

describe("requireDevelopmentApiPort", () => {
  it.each([undefined, "", "0", "-1", "3000.5", "65536", "not-a-port"])(
    "rejects an absent or invalid launcher-assigned port (%s)",
    (value) => {
      expect(() => requireDevelopmentApiPort(value)).toThrow("Run `pnpm demo`");
    },
  );

  it("accepts a valid launcher-assigned port", () => {
    expect(requireDevelopmentApiPort("43123")).toBe(43_123);
  });
});
