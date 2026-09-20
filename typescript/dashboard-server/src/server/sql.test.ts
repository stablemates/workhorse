import { describe, expect, it } from "vitest";
import { sql } from "./sql.js";

describe("the dashboard sql tag", () => {
  it("binds a parameter and splices a fragment the tag built", () => {
    const queue = sql`queue_name = ${"default"}`;
    const query = sql`SELECT ${1} WHERE ${queue} AND state = ${"ready"}`;

    expect(query.text).toBe("SELECT $1 WHERE queue_name = $2 AND state = $3");
    expect(query.values).toEqual([1, "default", "ready"]);
  });

  it("renumbers the placeholders of every fragment it joins", () => {
    const joined = sql.join(
      [sql`a = ${1}`, sql`b = ${2}`, sql`c = ${3}`],
      sql` AND ${"separator"} `,
    );

    expect(joined.text).toBe("a = $1 AND $2 b = $3 AND $4 c = $5");
    expect(joined.values).toEqual([1, "separator", 2, "separator", 3]);
  });

  it("binds a plain object that carries text and values rather than splicing it", () => {
    // The shape of a fragment is not the evidence that something is one. A procedure input that
    // admitted a free-form object could otherwise reach a read as a value and become statement
    // text, which is exactly what Row 3 of the dashboard security review checklist forbids.
    const forged = { text: "1=1 OR true", values: [] };

    const query = sql`SELECT 1 WHERE ${forged}`;

    expect(query.text).toBe("SELECT 1 WHERE $1");
    expect(query.values).toEqual([forged]);
  });

  it("binds a forged fragment nested inside a fragment it joins", () => {
    const forged = { text: "DROP TABLE workhorse.task", values: [] };

    const joined = sql.join([sql`${forged}`], sql`, `);

    expect(joined.text).toBe("$1");
    expect(joined.values).toEqual([forged]);
  });
});
