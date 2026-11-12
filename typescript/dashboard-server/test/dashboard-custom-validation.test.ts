import { describe, expect, it } from "vitest";
import { z } from "zod";

import { classifyDashboardSurface, describeDashboardSurface } from "../spec/compatibility.js";
import { customValidation } from "../spec/custom-validation.js";
import { checkDashboardSpec } from "../spec/generate.js";
import { dashboardRouter } from "../src/server/router.js";

/**
 * The request checks that JSON Schema cannot state (SM-2047). A Zod refinement or a `trim` decides
 * whether a host accepts a request, so `governed-surface.json` records each one, and
 * `pnpm dashboard-spec:check` reports a check that an existing field gains or changes.
 */

/** A request whose field `v` is trimmed and then limited to `maximum` characters. */
function trimmedLimit(maximum: number) {
  return describeDashboardSurface(
    {
      procedures: {
        page: {
          mutation: false,
          input: { type: "object", properties: { v: { type: "string", maxLength: maximum } } },
          output: { type: "object" },
        },
      },
    },
    { page: customValidation(z.object({ v: z.string().trim().max(maximum) })) },
  );
}

describe("the request checks that JSON Schema cannot state", () => {
  it("records a refinement the same way whatever its layout and literals", () => {
    const spaced = customValidation(
      z.object({ name: z.string().refine((value) => value.length <= 1_000 && value !== void 0) }),
    );
    const compact = customValidation(
      z.object({ name: z.string().refine((value) => value.length <= 1e3 && value !== undefined) }),
    );
    expect(spaced).toEqual(compact);
    expect(spaced).toEqual({
      name: ["custom ( value => value . length <= 1000 && value !== undefined ) ;"],
    });
  });

  it("keeps each character of a string and a regular expression", () => {
    expect(customValidation(z.string().refine((value) => value !== "a b"))).not.toEqual(
      customValidation(z.string().refine((value) => value !== "ab")),
    );
    expect(customValidation(z.string().refine((value) => !/a b/.test(value)))).not.toEqual(
      customValidation(z.string().refine((value) => !/ab/.test(value))),
    );
    expect(customValidation(z.string().refine((value) => value !== ";}"))).not.toEqual(
      customValidation(z.string().refine((value) => value !== "}")),
    );
  });

  it("records the condition that decides whether a refinement runs", () => {
    const never = customValidation(
      z.string().refine((value) => value.length <= 1, { when: () => false }),
    );
    const always = customValidation(
      z.string().refine((value) => value.length <= 1, { when: () => true }),
    );
    expect(never).not.toEqual(always);
  });

  it("records the function of a transform, which can refuse a value", () => {
    const refusing = customValidation(
      z.object({
        reason: z.string().transform((value, context) => {
          if (value.length > 1) context.addIssue({ code: "custom", message: "long" });
          return value;
        }),
      }),
    );
    expect(refusing.reason?.[0]).toContain("transform ( ( value , context ) =>");
  });

  it("keeps the raw text of a tagged template", () => {
    expect(customValidation(z.string().refine((value) => value !== String.raw`\n`))).not.toEqual(
      customValidation(
        z.string().refine(
          (value) =>
            value !==
            String.raw`
`,
        ),
      ),
    );
  });

  it("keeps the order of a normalization and the checks around it", () => {
    const trimFirst = customValidation(z.object({ reason: z.string().trim().min(1).max(10) }));
    const trimLast = customValidation(z.object({ reason: z.string().min(1).max(10).trim() }));
    expect(trimFirst.reason?.[0]).toContain("overwrite");
    expect(trimLast.reason?.at(-1)).toContain("overwrite");
  });

  it("accepts a looser length limit after an unchanged trim", () => {
    expect(classifyDashboardSurface(trimmedLimit(1), trimmedLimit(2))).toEqual([]);
    expect(
      classifyDashboardSurface(trimmedLimit(2), trimmedLimit(1)).map((f) => f.classification),
    ).toContain("breaking");
  });

  it("leaves out a field whose checks JSON Schema states", () => {
    expect(customValidation(z.object({ page: z.number().int().min(1).max(100) }))).toEqual({});
  });

  it("reads the function of a superRefine on the request", () => {
    const schema = z.object({ start: z.number() }).superRefine((input, context) => {
      if (input.start < 0) context.addIssue({ code: "custom", message: "negative" });
    });
    expect(customValidation(schema)["(request)"]?.[0]).toContain('message : "negative"');
  });

  it("fails the check when the router tightens a refinement", async () => {
    const procedure = dashboardRouter.dashboard.setWorkerPaused["~orpc"];
    const original = procedure.inputSchema;
    const audit = original.shape.audit;
    const tightened = original.extend({
      audit: audit.extend({
        requestId: audit.shape.requestId.refine(
          (value) => new TextEncoder().encode(value).length <= 128,
        ),
      }),
    });
    expect(
      tightened.safeParse({
        workerId: "worker",
        paused: true,
        audit: { actor: "a", reason: "r", requestId: "x".repeat(129) },
      }).success,
    ).toBe(false);

    expect((await checkDashboardSpec()).findings).toEqual([]);
    try {
      procedure.inputSchema = tightened;
      const { findings } = await checkDashboardSpec();
      expect(findings.map((finding) => [finding.classification, finding.subject])).toEqual([
        ["unproven", "request field setWorkerPaused.audit.requestId"],
      ]);
      expect(findings[0]?.change).toContain("encode ( value ) . length <= 128");
    } finally {
      procedure.inputSchema = original;
    }
  });

  it("fails the check when the router moves a trim after a length limit", async () => {
    const procedure = dashboardRouter.dashboard.setWorkerPaused["~orpc"];
    const original = procedure.inputSchema;
    const audit = original.shape.audit;
    const moved = original.extend({
      audit: audit.extend({ reason: z.string().min(1).max(2_000).trim() }),
    });
    const spaces = { workerId: "w", paused: true, audit: { actor: "a", requestId: "r" } };
    const reason = `${" ".repeat(2_000)}r`;
    expect(original.safeParse({ ...spaces, audit: { ...spaces.audit, reason } }).success).toBe(
      true,
    );
    expect(moved.safeParse({ ...spaces, audit: { ...spaces.audit, reason } }).success).toBe(false);
    try {
      procedure.inputSchema = moved;
      const { findings } = await checkDashboardSpec();
      expect(findings.map((finding) => finding.subject)).toEqual([
        "request field setWorkerPaused.audit.reason",
      ]);
    } finally {
      procedure.inputSchema = original;
    }
  });

  it("fails the check when the router adds a transform that refuses a request", async () => {
    const procedure = dashboardRouter.dashboard.setWorkerPaused["~orpc"];
    const original = procedure.inputSchema;
    const audit = original.shape.audit;
    const refusing = original.extend({
      audit: audit.extend({
        reason: audit.shape.reason.transform((value, context) => {
          if (value.length > 1) context.addIssue({ code: "custom", message: "long" });
          return value;
        }),
      }),
    });
    const request = {
      workerId: "w",
      paused: true,
      audit: { actor: "a", reason: "abc", requestId: "r" },
    };
    expect(original.safeParse(request).success).toBe(true);
    expect(refusing.safeParse(request).success).toBe(false);
    try {
      procedure.inputSchema = refusing;
      const { findings } = await checkDashboardSpec();
      expect(findings.map((finding) => finding.subject)).toEqual([
        "request field setWorkerPaused.audit.reason",
      ]);
    } finally {
      procedure.inputSchema = original;
    }
  });
});
