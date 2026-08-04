import { describe, expect, it } from "vitest";
import {
  DEMO_FEATURE_SHOWCASE_EXAMPLE_COUNT,
  DEMO_FEATURE_SHOWCASE_FAMILIES,
  demoFeatureRecurringVariant,
} from "./feature-showcase.js";

describe("demo feature showcase catalog", () => {
  it("declares exactly three examples and one unique recurring definition per family", () => {
    expect(DEMO_FEATURE_SHOWCASE_FAMILIES).toHaveLength(8);
    expect(DEMO_FEATURE_SHOWCASE_EXAMPLE_COUNT).toBe(DEMO_FEATURE_SHOWCASE_FAMILIES.length * 3);
    expect(new Set(DEMO_FEATURE_SHOWCASE_FAMILIES.map((family) => family.scheduleName)).size).toBe(
      DEMO_FEATURE_SHOWCASE_FAMILIES.length,
    );
    for (const family of DEMO_FEATURE_SHOWCASE_FAMILIES) {
      expect(family.examples).toHaveLength(3);
      expect(new Set(family.examples.map((example) => example.scenario)).size).toBe(3);
      expect(family.schedule).toBe("* * * * *");
    }
  });

  it("keeps one occurrence stable while distributing later identities across all variants", () => {
    const identity = "00000000-0000-4000-8000-000000000001";
    expect(demoFeatureRecurringVariant(identity)).toBe(demoFeatureRecurringVariant(identity));
    expect(
      new Set(
        Array.from({ length: 100 }, (_, index) =>
          demoFeatureRecurringVariant(
            `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
          ),
        ),
      ),
    ).toEqual(new Set([0, 1, 2]));
  });
});
