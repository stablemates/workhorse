import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyDashboardSurface,
  describeDashboardSurface,
  mergeDashboardSurface,
  type DashboardSurface,
  type SurfaceFinding,
} from "../spec/compatibility.js";
import { routerCustomValidation } from "../spec/generate.js";

const artifactDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "dashboard",
  "v1",
);

function surface(procedures: DashboardSurface["procedures"]): DashboardSurface {
  return { formatVersion: 1, procedures };
}

describe("describing the dashboard/v1 wire surface", () => {
  const described = describeDashboardSurface({
    procedures: {
      tasks: {
        mutation: false,
        input: {
          type: "object",
          properties: {
            page: { type: "integer" },
            filter: { enum: ["all", "queued"] },
            queue: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["page"],
        },
        output: { $ref: "#/$defs/Page" },
      },
    },
    $defs: {
      Page: {
        type: "object",
        properties: { rows: { type: "array", items: { $ref: "#/$defs/Row" } } },
        required: ["rows"],
      },
      Row: {
        type: "object",
        properties: { id: { type: "string" }, next: { $ref: "#/$defs/Row" } },
        required: ["id"],
      },
    },
  });

  it("names a nested response field by its path through objects and arrays", () => {
    expect(described.procedures.tasks?.response["rows[].id"]).toEqual({ type: "string" });
  });

  it("records which request fields validation requires", () => {
    expect(described.procedures.tasks?.request.page).toEqual({ type: "integer", required: true });
    expect(described.procedures.tasks?.request.queue).toEqual({
      type: "null|string",
      required: false,
    });
  });

  it("records the values an enum accepts", () => {
    expect(described.procedures.tasks?.request.filter).toEqual({
      type: "enum",
      enum: ["all", "queued"],
      required: false,
    });
  });

  it("stops at a type that refers to itself", () => {
    expect(described.procedures.tasks?.response["rows[].next"]).toEqual({ type: "recursive" });
  });
});

describe("classifying a dashboard/v1 change", () => {
  const promised = surface({
    tasks: {
      mutation: false,
      request: {
        filter: { type: "enum", enum: ["all", "queued"], required: false },
        page: { type: "integer", required: false },
      },
      response: { capturedAt: { type: "string" }, "rows[].id": { type: "string" } },
    },
  });

  it("passes an addition", () => {
    const current = surface({
      ...promised.procedures,
      tasks: {
        mutation: false,
        request: {
          ...promised.procedures.tasks?.request,
          search: { type: "string", required: false },
        },
        response: {
          ...promised.procedures.tasks?.response,
          "rows[].priority": { type: "number" },
        },
      },
      workers: { mutation: false, request: {}, response: {} },
    });
    expect(classifyDashboardSurface(promised, current)).toEqual([]);
  });

  it("names a removed procedure", () => {
    expect(classifyDashboardSurface(promised, surface({}))).toEqual([
      { classification: "breaking", subject: "procedure tasks", change: "removed" },
    ]);
  });

  it("names a removed and a retyped response field", () => {
    const current = surface({
      tasks: {
        mutation: false,
        request: promised.procedures.tasks?.request ?? {},
        response: { "rows[].id": { type: "number" } },
      },
    });
    expect(classifyDashboardSurface(promised, current)).toEqual([
      { classification: "breaking", subject: "response field tasks.capturedAt", change: "removed" },
      {
        classification: "breaking",
        subject: "response field tasks.rows[].id",
        change: "type string became number",
      },
    ]);
  });

  it("names tightened request validation", () => {
    const current = surface({
      tasks: {
        mutation: false,
        request: {
          filter: { type: "enum", enum: ["all"], required: false },
          page: { type: "integer", required: true },
          queue: { type: "string", required: true },
        },
        response: promised.procedures.tasks?.response ?? {},
      },
    });
    expect(classifyDashboardSurface(promised, current).map((finding) => finding.change)).toEqual([
      "no longer accepts queued",
      "became required",
      "is a new required field",
    ]);
  });

  it("names a query that became a mutation, because a caller now needs a matching Origin", () => {
    const current = surface({
      tasks: { ...(promised.procedures.tasks ?? surface({}).procedures.tasks!), mutation: true },
    });
    expect(classifyDashboardSurface(promised, current)).toContainEqual({
      classification: "breaking",
      subject: "procedure tasks",
      change: "became a mutation, so a caller now needs a matching Origin",
    });
  });

  it("keeps a promise the router dropped, so the next check still reports it", () => {
    expect(mergeDashboardSurface(promised, surface({})).procedures.tasks).toEqual(
      promised.procedures.tasks,
    );
  });
});

it("promises every procedure the committed dashboard/v1 contract serves", async () => {
  const contract = JSON.parse(
    await readFile(join(artifactDirectory, "procedures.json"), "utf8"),
  ) as Parameters<typeof describeDashboardSurface>[0];
  const promised = JSON.parse(
    await readFile(join(artifactDirectory, "governed-surface.json"), "utf8"),
  ) as DashboardSurface;
  const current = describeDashboardSurface(contract, routerCustomValidation());
  expect(classifyDashboardSurface(promised, current)).toEqual([]);
  expect(
    mergeDashboardSurface(promised, current),
    "dashboard/v1/governed-surface.json is stale; run pnpm dashboard-spec:generate",
  ).toEqual(promised);
});

describe("a validation bound that a request field changes (SM-2047)", () => {
  type Contract = Parameters<typeof describeDashboardSurface>[0];
  interface PropertySchema {
    type?: string;
    minimum?: number;
    maximum?: number;
    maxLength?: number;
    pattern?: string;
  }

  async function committed(): Promise<{ contract: Contract; promised: DashboardSurface }> {
    return {
      contract: JSON.parse(
        await readFile(join(artifactDirectory, "procedures.json"), "utf8"),
      ) as Contract,
      promised: JSON.parse(
        await readFile(join(artifactDirectory, "governed-surface.json"), "utf8"),
      ) as DashboardSurface,
    };
  }

  /** The request properties of the `tasks` procedure in a copy of the committed contract. */
  function taskProperties(contract: Contract): Record<string, PropertySchema> {
    const properties = contract.procedures.tasks?.input?.properties;
    if (properties === undefined) throw new Error("procedures.json has no tasks input");
    return properties as Record<string, PropertySchema>;
  }

  async function classifyEdited(edit: (properties: Record<string, PropertySchema>) => void) {
    const { contract, promised } = await committed();
    edit(taskProperties(contract));
    return classifyDashboardSurface(
      promised,
      describeDashboardSurface(contract, routerCustomValidation()),
    ).map((finding) => `${finding.subject} ${finding.change}`);
  }

  it("records the bounds of a request field", async () => {
    const { promised } = await committed();
    expect(promised.recordsValidationBounds).toBe(true);
    expect(promised.procedures.tasks?.request.page).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 100,
      required: false,
    });
  });

  it("names a lower maximum, a higher minimum, and a new or changed pattern", async () => {
    expect(
      await classifyEdited((properties) => {
        properties.page = { ...properties.page, minimum: 2, maximum: 50 };
        properties.search = { ...properties.search, maxLength: 100, pattern: "^[a-z]+$" };
      }),
    ).toEqual([
      "request field tasks.page minimum changed from 1 to 2",
      "request field tasks.page maximum changed from 100 to 50",
      "request field tasks.search maxLength changed from 200 to 100",
      "request field tasks.search gained pattern ^[a-z]+$",
    ]);
  });

  it("accepts a looser bound and a new optional field with bounds", async () => {
    expect(
      await classifyEdited((properties) => {
        properties.page = { ...properties.page, maximum: 200 };
        delete properties.search?.maxLength;
        properties.added = { type: "string", maxLength: 10 };
      }),
    ).toEqual([]);
  });

  it("reads a promise without bounds as one that did not record them", async () => {
    const { contract, promised } = await committed();
    const { recordsValidationBounds: _recorded, ...older } = promised;
    const unbounded: DashboardSurface = {
      ...older,
      procedures: Object.fromEntries(
        Object.entries(older.procedures).map(
          ([name, { customValidation: _checks, ...procedure }]) => [
            name,
            {
              ...procedure,
              request: Object.fromEntries(
                Object.entries(procedure.request).map(([path, field]) => [
                  path,
                  field.enum === undefined
                    ? { type: field.type, required: field.required }
                    : { type: field.type, enum: field.enum, required: field.required },
                ]),
              ),
            },
          ],
        ),
      ),
    };
    expect(
      classifyDashboardSurface(
        unbounded,
        describeDashboardSurface(contract, routerCustomValidation()),
      ),
    ).toEqual([]);
  });

  it("does not govern the range of a response value", () => {
    const described = describeDashboardSurface({
      procedures: {
        count: {
          mutation: false,
          input: null,
          output: { type: "object", properties: { total: { type: "integer", maximum: 10 } } },
        },
      },
    });
    expect(described.procedures.count?.response.total).toEqual({ type: "integer" });
  });
});

function integerUnion(...ranges: [number, number][]): DashboardSurface {
  return describeDashboardSurface({
    procedures: {
      page: {
        mutation: false,
        input: {
          type: "object",
          properties: {
            at: {
              anyOf: ranges.map(([minimum, maximum]) => ({ type: "integer", minimum, maximum })),
            },
            label: {
              anyOf: [{ type: "string", maxLength: ranges.length * 5 }, { type: "string" }],
            },
          },
        },
        output: { type: "object" },
      },
    },
  });
}
async function committedContract(): Promise<Parameters<typeof describeDashboardSurface>[0]> {
  return JSON.parse(
    await readFile(join(artifactDirectory, "procedures.json"), "utf8"),
  ) as Parameters<typeof describeDashboardSurface>[0];
}
describe("a field that accepts several branches, or a check that JSON Schema cannot state", () => {
  it("keeps the bounds of each branch", () => {
    expect(integerUnion([0, 10], [20, 30]).procedures.page?.request.at?.branches).toEqual([
      { type: "integer", minimum: 0, maximum: 10 },
      { type: "integer", minimum: 20, maximum: 30 },
    ]);
  });

  it("names a branch range that accepts fewer values", () => {
    const changes = classifyDashboardSurface(
      integerUnion([0, 10], [20, 30]),
      integerUnion([0, 5], [20, 30]),
    ).map((finding) => `${finding.subject} ${finding.change}`);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("request field page.at integer values changed");
  });

  it("accepts a bound change in a type that another branch leaves unbounded", () => {
    // The first label branch changes from 10 to 5 characters. The second label branch accepts each
    // string before and after.
    const findings = classifyDashboardSurface(
      integerUnion([0, 10], [20, 30]),
      integerUnion([0, 10]),
    ).filter((finding) => finding.subject.endsWith("label"));
    expect(findings).toEqual([]);
  });

  it("records each refinement by the field that it checks", async () => {
    const custom = routerCustomValidation();
    expect(custom.setWorkerPaused?.["audit.requestId"]).toEqual([
      "custom ( value => utf8 . encode ( value ) . length <= 512 ) ;",
      "overwrite ( input => input . trim ( ) ) ;",
      'min_length {"minimum":1}',
    ]);
    expect(custom.events?.["(request)"]?.[0]).toContain(
      '"rangeStart and rangeEnd must be supplied together"',
    );
    const described = describeDashboardSurface(await committedContract(), custom);
    expect(described.procedures.setWorkerPaused?.customValidation?.["audit.requestId"]).toEqual(
      custom.setWorkerPaused?.["audit.requestId"],
    );
  });

  it("names a changed check, a new check, and a new order, and accepts a check that went away", async () => {
    const contract = await committedContract();
    const custom = routerCustomValidation();
    const promised = describeDashboardSurface(contract, custom);
    const edit = (checks: string[]): SurfaceFinding[] =>
      classifyDashboardSurface(
        promised,
        describeDashboardSurface(contract, {
          ...custom,
          setWorkerPaused: { ...custom.setWorkerPaused, "audit.requestId": checks },
        }),
      );
    const refine = "custom ( value => utf8 . encode ( value ) . length <= 512 ) ;";
    const trim = "overwrite ( input => input . trim ( ) ) ;";
    const minimum = 'min_length {"minimum":1}';

    const tightened = edit([refine.replace("512", "128"), trim, minimum]);
    expect(tightened.map((finding) => [finding.classification, finding.subject])).toEqual([
      ["unproven", "request field setWorkerPaused.audit.requestId"],
    ]);
    expect(tightened[0]?.change).toContain("<= 128");
    expect(edit([trim, refine, minimum])).toHaveLength(1);
    expect(edit([refine, minimum])).toHaveLength(1);
    expect(edit([trim, minimum])).toEqual([]);
    expect(edit([refine, trim])).toEqual([]);
  });

  it("accepts a check on a new field", async () => {
    const contract = await committedContract();
    const custom = routerCustomValidation();
    const promised = describeDashboardSurface(contract, custom);
    const current = describeDashboardSurface(contract, {
      ...custom,
      setWorkerPaused: { ...custom.setWorkerPaused, note: ["custom value=>value.length<10"] },
    });
    expect(classifyDashboardSurface(promised, current)).toEqual([]);
  });
});

function labelled(label: Record<string, unknown>): DashboardSurface {
  return describeDashboardSurface({
    procedures: {
      page: {
        mutation: false,
        input: { type: "object", properties: { label } },
        output: { type: "object" },
      },
    },
  });
}
/** The changes that one edit of the `label` request field makes. */
function labelChanges(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return classifyDashboardSurface(labelled(before), labelled(after)).map(
    (finding) => finding.change,
  );
}

describe("a bound beside anyOf, enum, or const", () => {
  it("applies a bound beside anyOf to each branch", () => {
    const wide = labelled({ anyOf: [{ type: "string" }, { type: "null" }], maxLength: 10 });
    expect(wide.procedures.page?.request.label?.branches).toEqual([
      { type: "null", maxLength: 10 },
      { type: "string", maxLength: 10 },
    ]);
    const narrow = labelled({ anyOf: [{ type: "string" }, { type: "null" }], maxLength: 5 });
    expect(classifyDashboardSurface(wide, narrow).map((finding) => finding.change)).toEqual([
      "maxLength changed from 10 to 5",
      "maxLength changed from 10 to 5",
    ]);
  });

  it("names a tighter bound beside an enum or a const", () => {
    expect(
      labelChanges({ enum: ["a", "bb"], maxLength: 10 }, { enum: ["a", "bb"], maxLength: 1 }),
    ).toEqual(["maxLength changed from 10 to 1"]);
    // The constant has one character, so a minimum length of 1 refuses no value.
    expect(labelChanges({ const: "a", minLength: 0 }, { const: "a", minLength: 1 })).toEqual([]);
    expect(labelChanges({ const: "a", minLength: 0 }, { const: "a", minLength: 2 })).toEqual([
      "minLength changed from 0 to 2",
    ]);
  });
});

/** A union of integer ranges. */
function integerRanges(pairs: [number, number][]): Record<string, unknown> {
  return { anyOf: pairs.map(([minimum, maximum]) => ({ type: "integer", minimum, maximum })) };
}

/** The classification of each finding of one edit of the `label` request field. */
function labelClasses(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return classifyDashboardSurface(labelled(before), labelled(after)).map(
    (finding) => finding.classification,
  );
}

describe("the round 2 review cases (SM-2047)", () => {
  it("names a new multipleOf, and reports a changed one as unproven", () => {
    expect(
      classifyDashboardSurface(
        labelled({ type: "integer" }),
        labelled({ type: "integer", multipleOf: 2 }),
      ).map((finding) => [finding.classification, finding.change]),
    ).toEqual([["breaking", "gained multipleOf 2"]]);
    expect(
      classifyDashboardSurface(
        labelled({ type: "integer", multipleOf: 2 }),
        labelled({ type: "integer", multipleOf: 3 }),
      ).map((finding) => finding.classification),
    ).toEqual(["unproven"]);
  });

  it("accepts a new bounded branch beside each promised branch", () => {
    expect(
      labelChanges(
        integerRanges([
          [0, 10],
          [20, 30],
        ]),
        integerRanges([
          [0, 10],
          [20, 30],
          [40, 50],
        ]),
      ),
    ).toEqual([]);
  });

  it("reports a new or changed pattern as unproven, because it does not evaluate one", () => {
    expect(labelClasses({ type: "string" }, { type: "string", pattern: "^a" })).toEqual([
      "unproven",
    ]);
    expect(
      labelClasses({ type: "string", pattern: "^a" }, { type: "string", pattern: "^[ab]" }),
    ).toEqual(["unproven"]);
  });
});

describe("a change of bounds that accepts each value it accepted before (SM-2047)", () => {
  it("reads an exclusive lower bound below the old minimum as looser", () => {
    expect(
      labelChanges({ type: "number", minimum: 1 }, { type: "number", exclusiveMinimum: 0 }),
    ).toEqual([]);
    expect(
      labelChanges({ type: "integer", minimum: 1 }, { type: "integer", exclusiveMinimum: 0 }),
    ).toEqual([]);
    expect(
      labelChanges({ type: "number", minimum: 0 }, { type: "number", exclusiveMinimum: 0 }),
    ).toEqual(["gained exclusiveMinimum 0"]);
  });

  it("accepts a wider branch beside an unchanged one", () => {
    expect(
      labelChanges(
        integerRanges([
          [0, 10],
          [20, 30],
        ]),
        integerRanges([
          [0, 11],
          [20, 30],
        ]),
      ),
    ).toEqual([]);
  });

  it("names a value that a branch with a set of values lost", () => {
    const before = { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] };
    const after = { anyOf: [{ type: "string", enum: ["a"] }, { type: "null" }] };
    expect(labelClasses(before, after)).toEqual(["breaking"]);
    expect(labelChanges(after, before)).toEqual([]);
  });
});

/** A request whose `label` refers to a string schema, with a minimum length beside the reference. */
function referenced(minLength: number): DashboardSurface {
  return describeDashboardSurface({
    procedures: {
      page: {
        mutation: false,
        input: {
          type: "object",
          properties: { label: { $ref: "#/$defs/Label", minLength } },
        },
        output: { type: "object" },
      },
    },
    $defs: { Label: { type: "string" } },
  });
}
describe("a bound beside $ref (SM-2047)", () => {
  it("records the bound and names a tighter one", () => {
    expect(referenced(5).procedures.page?.request.label).toEqual({
      type: "string",
      minLength: 5,
      required: false,
    });
    expect(
      classifyDashboardSurface(referenced(5), referenced(6)).map((finding) => finding.change),
    ).toEqual(["minLength changed from 5 to 6"]);
    expect(classifyDashboardSurface(referenced(6), referenced(5))).toEqual([]);
  });
});

describe("integer bounds that allow the same values (SM-2047)", () => {
  it("reads a fractional inclusive limit of an integer as the next integer", () => {
    expect(
      labelChanges({ type: "integer", minimum: 1.1 }, { type: "integer", minimum: 2 }),
    ).toEqual([]);
    expect(
      labelChanges({ type: "integer", maximum: 2.9 }, { type: "integer", maximum: 2 }),
    ).toEqual([]);
    expect(
      labelChanges({ type: "integer", minimum: 1.1 }, { type: "integer", minimum: 3 }),
    ).toEqual(["minimum changed from 1.1 to 3"]);
  });

  it("accepts a divisor that divides each value the promise accepted", () => {
    expect(labelChanges({ type: "integer" }, { type: "integer", multipleOf: 1 })).toEqual([]);
    expect(
      labelChanges({ type: "integer", multipleOf: 4 }, { type: "integer", multipleOf: 2 }),
    ).toEqual([]);
    expect(labelClasses({ type: "number" }, { type: "number", multipleOf: 1 })).toEqual([
      "breaking",
    ]);
  });
});

describe("a change that the checker cannot prove (SM-2047, known limit M)", () => {
  it("says what the checker does not read, that it is not a judged break, and where to read next", () => {
    // A new pattern `^` refuses no value, but the checker does not evaluate a pattern.
    const [finding] = classifyDashboardSurface(
      labelled({ type: "string" }),
      labelled({ type: "string", pattern: "^" }),
    );
    expect(finding?.classification).toBe("unproven");
    expect(finding?.change).toMatch(
      /does not evaluate a pattern.*not a judged break of dashboard\/v1.*"Known limits" in api\/README\.md.*--accept-breaking/s,
    );
  });
});
