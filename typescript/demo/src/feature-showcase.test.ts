import { describe, expect, it } from "vitest";
import {
  DEMO_FEATURE_MENU_EXAMPLES,
  DEMO_FEATURE_SHOWCASE_EXAMPLE_COUNT,
  DEMO_FEATURE_SHOWCASE_FAMILIES,
  demoFeatureRecurringVariant,
} from "./feature-showcase.js";

describe("demo feature showcase catalog", () => {
  it("declares exactly three examples and staggers one recurring definition per family", () => {
    expect(DEMO_FEATURE_SHOWCASE_FAMILIES).toHaveLength(17);
    expect(DEMO_FEATURE_SHOWCASE_EXAMPLE_COUNT).toBe(DEMO_FEATURE_SHOWCASE_FAMILIES.length * 3);
    expect(new Set(DEMO_FEATURE_SHOWCASE_FAMILIES.map((family) => family.scheduleName)).size).toBe(
      DEMO_FEATURE_SHOWCASE_FAMILIES.length,
    );
    expect(new Set(DEMO_FEATURE_SHOWCASE_FAMILIES.map((family) => family.jobType)).size).toBe(
      DEMO_FEATURE_SHOWCASE_FAMILIES.length,
    );
    for (const [index, family] of DEMO_FEATURE_SHOWCASE_FAMILIES.entries()) {
      expect(family.examples).toHaveLength(3);
      expect(new Set(family.examples.map((example) => example.scenario)).size).toBe(3);
      expect(family.schedule).toBe(`${index}-59/17 * * * *`);
    }
  });

  it("declares one repeat-safe menu example for every family", () => {
    expect(Object.keys(DEMO_FEATURE_MENU_EXAMPLES).toSorted()).toEqual(
      DEMO_FEATURE_SHOWCASE_FAMILIES.map((family) => family.key).toSorted(),
    );
    for (const example of Object.values(DEMO_FEATURE_MENU_EXAMPLES)) {
      // The operator enqueue path only performs plain acceptances (plus enqueueMany for the batch
      // group). Seed-only mechanics would either throw on a repeat click or need claim/fail calls
      // the operator path deliberately does not make.
      expect(example.seedTransition).toBeUndefined();
      expect(example.seedDependency).toBeUndefined();
      expect(example.seedDebounce).toBeUndefined();
      expect(example.seedThrottle).toBeUndefined();
      expect(example.afterEnqueue).toBeUndefined();
      expect(example.idempotencyKey).toBeUndefined();
      expect(example.failLastMember).toBeUndefined();
    }
  });

  it("omits redundant showcase and numeric priority tags", () => {
    const examples = [
      ...DEMO_FEATURE_SHOWCASE_FAMILIES.flatMap((family) => family.examples),
      ...Object.values(DEMO_FEATURE_MENU_EXAMPLES),
    ];

    for (const example of examples) {
      expect(example.tags).not.toContain("showcase");
      expect(example.tags).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^priority-\d+$/)]),
      );
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
