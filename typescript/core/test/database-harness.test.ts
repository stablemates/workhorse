import { describe, expect, it } from "vitest";
import { schemaTemplateName } from "./support/schema-template.js";

describe("the database test harness", () => {
  it("rotates schema templates at the UTC day boundary", () => {
    const schema = Buffer.from("schema contents");

    expect(schemaTemplateName(schema, new Date("2026-08-27T23:59:59.999Z"))).not.toBe(
      schemaTemplateName(schema, new Date("2026-08-28T00:00:00.000Z")),
    );
  });
});
