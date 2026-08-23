import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isProcedure } from "@orpc/server";
import { z } from "zod";
import { dashboardRouter } from "../src/server/router.js";
import {
  DASHBOARD_BROWSER_MODULES_PLACEHOLDER,
  DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER,
  dashboardRuntimeConfigSchema,
} from "../src/server/html.js";
import { generateResponseSchemas } from "./response-schemas.js";

/**
 * Generate the committed `dashboard/v1` wire-contract artifacts from the dashboard router.
 *
 * The router is the generator and the committed artifacts are the authority, the same relation
 * `sql/schema/current.sql` has to the migrations. `pnpm dashboard-spec:check` and the
 * `dashboard-spec.test.ts` parity test regenerate and diff, so a router change that alters the
 * wire contract must land with regenerated artifacts — a conscious, reviewed contract change.
 */

const specDirectory = dirname(fileURLToPath(import.meta.url));
const artifactDirectory = join(specDirectory, "..", "..", "..", "dashboard", "v1");

const errorEnvelope = {
  type: "object",
  properties: {
    json: {
      type: "object",
      properties: {
        defined: { const: false },
        code: { type: "string" },
        status: { type: "number" },
        message: { type: "string" },
        data: {},
      },
      required: ["defined", "code", "status", "message"],
    },
  },
  required: ["json"],
};

interface ProcedureEntry {
  path: string;
  mutation: boolean;
  input: Record<string, unknown> | null;
  output: unknown;
}

function routerProcedures(): Map<string, { mutation: boolean; input: unknown }> {
  const procedures = new Map<string, { mutation: boolean; input: unknown }>();
  for (const [name, candidate] of Object.entries(dashboardRouter.dashboard)) {
    if (!isProcedure(candidate)) continue;
    const definition = candidate["~orpc"];
    procedures.set(name, {
      mutation: definition.meta.mutation === true,
      input: definition.inputSchema,
    });
  }
  return procedures;
}

/** Compose every artifact as its exact file content, keyed by file name. */
export function composeDashboardSpec(): Record<string, string> {
  const procedures = routerProcedures();
  const { responses, definitions } = generateResponseSchemas();

  const missing = [...procedures.keys()].filter((name) => !(name in responses));
  const orphaned = Object.keys(responses).filter((name) => !procedures.has(name));
  if (missing.length > 0 || orphaned.length > 0) {
    throw new Error(
      `The router and the inferred responses disagree: missing ${missing.join(", ") || "none"}; ` +
        `orphaned ${orphaned.join(", ") || "none"}`,
    );
  }

  const entries: Record<string, ProcedureEntry> = {};
  for (const [name, procedure] of procedures) {
    entries[name] = {
      path: `/rpc/dashboard/${name}`,
      mutation: procedure.mutation,
      input: procedure.input
        ? z.toJSONSchema(procedure.input as z.ZodType, { target: "draft-2020-12", io: "input" })
        : null,
      output: responses[name],
    };
  }

  const manifest = {
    formatVersion: 1,
    contractVersion: 1,
    readSurfaceVersion: 1,
    transport: {
      protocol: "orpc-rpc",
      method: "POST",
      pathTemplate: "{basePath}/rpc/dashboard/{procedure}",
      requestContentType: "application/json",
      requestEnvelope: { json: "<input>" },
      successEnvelope: { json: "<output>" },
      emptySuccessBody: {},
      errorEnvelope,
    },
    authentication: {
      delegated: true,
      unauthenticatedStatus: 401,
      forbiddenStatus: 403,
      singleAdminRoutes: { login: "{basePath}/login", logout: "{basePath}/logout" },
    },
    csrf: {
      mechanism: "same-origin",
      rule: "Mutation procedures require an Origin header matching the request origin; a mismatched or unparsable Origin is rejected with status 403 before the procedure runs.",
    },
    procedures: Object.fromEntries(
      [...procedures].map(([name, procedure]) => [name, { mutation: procedure.mutation }]),
    ),
  };

  const proceduresDocument = {
    formatVersion: 1,
    contractVersion: 1,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    procedures: entries,
    html: {
      runtimeConfigPlaceholder: DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER,
      browserModulesPlaceholder: DASHBOARD_BROWSER_MODULES_PLACEHOLDER,
      runtimeConfig: z.toJSONSchema(dashboardRuntimeConfigSchema, {
        target: "draft-2020-12",
        io: "output",
      }),
    },
    $defs: definitions,
  };

  return {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "procedures.json": `${JSON.stringify(proceduresDocument, null, 2)}\n`,
  };
}

export async function checkDashboardSpec(): Promise<string[]> {
  const artifacts = composeDashboardSpec();
  const stale: string[] = [];
  for (const [name, content] of Object.entries(artifacts)) {
    const committed = await readFile(join(artifactDirectory, name), "utf8").catch(() => null);
    if (committed !== content) stale.push(name);
  }
  return stale;
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  if (process.argv.includes("--check")) {
    const stale = await checkDashboardSpec();
    if (stale.length > 0) {
      console.error(
        `dashboard/v1 is stale: ${stale.join(", ")}. Run pnpm dashboard-spec:generate and commit the result.`,
      );
      process.exit(1);
    }
    console.log("dashboard/v1 matches the router.");
  } else {
    const artifacts = composeDashboardSpec();
    for (const [name, content] of Object.entries(artifacts)) {
      await writeFile(join(artifactDirectory, name), content);
    }
    console.log(`Wrote ${Object.keys(artifacts).join(", ")} to ${artifactDirectory}`);
  }
}
