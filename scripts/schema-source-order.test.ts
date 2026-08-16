import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSchemaSourceOrder } from "./schema-source-order.js";

const repository = path.resolve(import.meta.dirname, "..");

describe("clean schema source order", () => {
  it("keeps relation declarations before operational functions", async () => {
    const source = await readFile(path.join(repository, "sql/schema/current.sql"), "utf8");

    expect(() => assertSchemaSourceOrder(source)).not.toThrow();
  });
});
