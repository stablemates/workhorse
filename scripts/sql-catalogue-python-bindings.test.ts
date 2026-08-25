import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPythonStatementBindings,
  findPythonStatementAccesses,
} from "./sql-catalogue-python-bindings.js";

const pythonProject = path.resolve(import.meta.dirname, "../python");

describe("Python statement bindings", () => {
  it("accepts bindings whose statements exist and whose fields are consumed", () => {
    expect(() =>
      assertPythonStatementBindings({ health: "queue_health_v1" }, new Set(["queue_health_v1"]), [
        { filename: "client.py", field: "health" },
      ]),
    ).not.toThrow();
  });

  it("rejects a binding to a missing manifest statement", () => {
    expect(() =>
      assertPythonStatementBindings({ health: "renamed_health_v1" }, new Set(["queue_health_v1"]), [
        { filename: "client.py", field: "health" },
      ]),
    ).toThrow("health names missing manifest statement renamed_health_v1");
  });

  it("rejects a registry field that Python does not consume", () => {
    expect(() =>
      assertPythonStatementBindings(
        { health: "queue_health_v1" },
        new Set(["queue_health_v1"]),
        [],
      ),
    ).toThrow("StatementRegistry field health is not consumed in python/src/workhorse");
  });

  it("rejects a Python statement access without a registry field", () => {
    expect(() =>
      assertPythonStatementBindings({ health: "queue_health_v1" }, new Set(["queue_health_v1"]), [
        { filename: "worker.py", field: "claim" },
      ]),
    ).toThrow("worker.py consumes missing StatementRegistry field claim");
  });

  it("ignores statement names in comments and strings", () => {
    expect(
      findPythonStatementAccesses(
        [
          {
            filename: "client.py",
            source: `
# STATEMENTS.comment
example = "STATEMENTS.string"
executor.rows(STATEMENTS.health)
`,
          },
        ],
        pythonProject,
      ),
    ).toEqual([{ filename: "client.py", field: "health" }]);
  });
});
