import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, expect, it } from "vitest";
import { responseSchemasOf, type ResponseSchemas } from "../spec/response-schemas.js";

// The wire model in miniature: an `Omit` of a page, the construct that moved the keys of
// `DashboardTasksCursorPage` when an unrelated SDK type changed. The page comes from a second
// file, as core types reach the dashboard wire model.
const coreModel = `
export interface Page {
  capturedAt: string;
  hasMore: boolean;
  count: number;
  tasks: string[];
}
`;

const wireModel = `
import type { Page } from "./core.js";

interface CursorPage extends Omit<Page, "hasMore"> {
  nextCursor: string | null;
}

export type Responses = { list: CursorPage; tally: Record<"waiting" | "running", number> };
`;

// An unrelated type that the checker reads first. It creates the literal types "tasks" and
// "count" before the checker resolves the key union of the `Omit`, so the checker interns those
// keys in a different order.
const unrelatedType = `export type Unrelated = "tasks" | "count" | "running";\n`;

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "workhorse-response-schemas-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function schemasFor(name: string, core: string): Promise<ResponseSchemas> {
  const root = join(directory, name);
  await mkdir(root);
  await writeFile(join(root, "core.ts"), core);
  const entry = join(root, "wire.ts");
  await writeFile(entry, wireModel);
  const program = ts.createProgram([entry], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  });
  // Check the whole program first, as the generator does, so the checker creates types in
  // source order rather than on demand from the alias.
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  expect(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))).toEqual(
    [],
  );
  return responseSchemasOf(program, entry, "Responses");
}

it("writes properties in declaration order whatever types the checker created first", async () => {
  const alone = await schemasFor("alone", coreModel);
  const withUnrelated = await schemasFor("with-unrelated", `${unrelatedType}${coreModel}`);

  expect(JSON.stringify(withUnrelated)).toBe(JSON.stringify(alone));
  const page = alone.definitions["DashboardCursorPage"] as {
    properties: Record<string, unknown>;
    required: string[];
  };
  // The members from core.ts come before the member that wire.ts adds.
  expect(Object.keys(page.properties)).toEqual(["capturedAt", "count", "tasks", "nextCursor"]);
  expect(page.required).toEqual(["capturedAt", "count", "tasks", "nextCursor"]);
  // A key with no declaration, such as a key of a `Record`, sorts by name.
  const tally = alone.responses["tally"] as { properties: Record<string, unknown> };
  expect(Object.keys(tally.properties)).toEqual(["running", "waiting"]);
});
