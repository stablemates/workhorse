import { execFileSync } from "node:child_process";

export type PythonSource = { filename: string; source: string };
export type PythonStatementAccess = { filename: string; field: string };

const findAccesses = `
import ast
import json
import sys

accesses = []
for item in json.load(sys.stdin):
    tree = ast.parse(item["source"], filename=item["filename"])
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "STATEMENTS"
        ):
            accesses.append({"filename": item["filename"], "field": node.attr})
print(json.dumps(accesses))
`;

export function findPythonStatementAccesses(
  sources: readonly PythonSource[],
  pythonProject: string,
): PythonStatementAccess[] {
  return JSON.parse(
    execFileSync("uv", ["run", "--project", pythonProject, "python", "-c", findAccesses], {
      input: JSON.stringify(sources),
      encoding: "utf8",
    }),
  ) as PythonStatementAccess[];
}

export function assertPythonStatementBindings(
  bindings: Readonly<Record<string, string>>,
  manifestStatements: ReadonlySet<string>,
  accesses: readonly PythonStatementAccess[],
): void {
  for (const [field, statement] of Object.entries(bindings)) {
    if (!manifestStatements.has(statement)) {
      throw new Error(`${field} names missing manifest statement ${statement}`);
    }
  }

  const consumed = new Set<string>();
  for (const { filename, field } of accesses) {
    if (!Object.hasOwn(bindings, field)) {
      throw new Error(`${filename} consumes missing StatementRegistry field ${field}`);
    }
    consumed.add(field);
  }

  for (const field of Object.keys(bindings)) {
    if (!consumed.has(field)) {
      throw new Error(`StatementRegistry field ${field} is not consumed in python/src/workhorse`);
    }
  }
}
