import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

type Schema = Record<string, unknown>;

interface ProcedureSchema {
  input: Schema | null;
  output: Schema | null;
}

interface DashboardContract {
  procedures: Record<string, ProcedureSchema>;
  html: { runtimeConfig: Schema };
  $defs: Record<string, Schema>;
}

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const contractPath = join(repositoryRoot, "dashboard", "v1", "procedures.json");
const outputPaths = {
  "go/dashboard/v1_generated.go": join(repositoryRoot, "go", "dashboard", "v1_generated.go"),
  "python/src/workhorse/dashboard_v1.py": join(
    repositoryRoot,
    "python",
    "src",
    "workhorse",
    "dashboard_v1.py",
  ),
};

const acronyms = new Map([
  ["id", "ID"],
  ["ids", "IDs"],
  ["url", "URL"],
  ["rpc", "RPC"],
  ["json", "JSON"],
  ["html", "HTML"],
  ["sql", "SQL"],
]);

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function exportedName(value: string): string {
  return words(value)
    .map((word) => acronyms.get(word.toLowerCase()) ?? `${word[0]!.toUpperCase()}${word.slice(1)}`)
    .join("");
}

function pythonName(value: string): string {
  const name = exportedName(value);
  return /^\d/.test(name) ? `Value${name}` : name;
}

function snakeName(value: string): string {
  return words(value)
    .map((word) => word.toLowerCase())
    .join("_");
}

function refName(schema: Schema): string | null {
  const ref = schema.$ref;
  return typeof ref === "string" ? (ref.split("/").at(-1) ?? null) : null;
}

function nullableBranch(schema: Schema): Schema | null {
  if (!Array.isArray(schema.anyOf)) return null;
  const branches = schema.anyOf as Schema[];
  if (branches.length !== 2 || !branches.some((branch) => branch.type === "null")) return null;
  return branches.find((branch) => branch.type !== "null") ?? null;
}

function goType(schema: Schema, indent = ""): string {
  const ref = refName(schema);
  if (ref) return exportedName(ref === "__schema0" ? "Json" : ref);
  const nullable = nullableBranch(schema);
  if (nullable) return `*${goType(nullable, indent)}`;
  if (Array.isArray(schema.anyOf)) {
    const types = new Set((schema.anyOf as Schema[]).map((branch) => goType(branch, indent)));
    return types.size === 1 ? [...types][0]! : "any";
  }
  if (schema.const !== undefined) return goType({ type: typeof schema.const }, indent);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return goType({ type: typeof schema.enum[0] }, indent);
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
      return "int64";
    case "number":
      return "float64";
    case "boolean":
      return "bool";
    case "null":
      return "struct{}";
    case "array":
      return `[]${goType((schema.items as Schema | undefined) ?? {}, indent)}`;
    case "object": {
      const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};
      if (Object.keys(properties).length === 0) {
        return schema.additionalProperties
          ? `map[string]${goType(schema.additionalProperties as Schema)}`
          : "map[string]any";
      }
      const required = new Set((schema.required as string[] | undefined) ?? []);
      const lines = Object.entries(properties).map(([name, child]) => {
        let childType = goType(child, `${indent}\t`);
        if (!required.has(name) && !childType.startsWith("*")) childType = `*${childType}`;
        return `${indent}\t${exportedName(name)} ${childType} \`json:"${name}${required.has(name) ? "" : ",omitempty"}"\``;
      });
      return `struct {\n${lines.join("\n")}\n${indent}}`;
    }
    default:
      return "any";
  }
}

function pythonLiteral(value: unknown): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return JSON.stringify(value);
}

function pythonType(schema: Schema, names?: WeakMap<Schema, string>): string {
  const ref = refName(schema);
  if (ref) return pythonName(ref === "__schema0" ? "Json" : ref);
  const nullable = nullableBranch(schema);
  if (nullable) return `${pythonType(nullable, names)} | None`;
  if (Array.isArray(schema.anyOf)) {
    const types = new Set((schema.anyOf as Schema[]).map((branch) => pythonType(branch, names)));
    const includesNull = types.delete("None");
    return [...types, ...(includesNull ? ["None"] : [])].join(" | ");
  }
  if (schema.const !== undefined) return `Literal[${pythonLiteral(schema.const)}]`;
  if (Array.isArray(schema.enum)) {
    return `Literal[${schema.enum.map(pythonLiteral).join(", ")}]`;
  }
  switch (schema.type) {
    case "string":
      return "str";
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "null":
      return "None";
    case "array":
      return `list[${pythonType((schema.items as Schema | undefined) ?? {}, names)}]`;
    case "object": {
      const named = names?.get(schema);
      if (named) return named;
      return schema.additionalProperties
        ? `dict[str, ${pythonType(schema.additionalProperties as Schema, names)}]`
        : "dict[str, object]";
    }
    default:
      return "object";
  }
}

function goDeclaration(name: string, schema: Schema): string {
  return `type ${exportedName(name)} ${goType(schema)}\n`;
}

function pythonDeclaration(name: string, schema: Schema, names: WeakMap<Schema, string>): string {
  const typeName = pythonName(name);
  if (typeName === "JSON") {
    return 'JSON: TypeAlias = str | int | float | bool | list["JSON"] | dict[str, "JSON"] | None\n';
  }
  if (schema.type !== "object" || !schema.properties) {
    return `${typeName}: TypeAlias = ${pythonType(schema)}\n`;
  }
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const properties = schema.properties as Record<string, Schema>;
  const fields = Object.entries(properties).map(
    ([field, child]) =>
      `    ${field}: ${required.has(field) ? "Required" : "NotRequired"}[${pythonType(child, names)}]`,
  );
  return `class ${typeName}(TypedDict, total=False):\n${fields.length > 0 ? fields.join("\n") : "    pass"}\n`;
}

function pythonDeclarations(roots: Array<[string, Schema]>): string[] {
  const names = new WeakMap<Schema, string>();
  const usedNames = new Set<string>();
  const ordered: Array<[string, Schema]> = [];
  const visited = new WeakSet<Schema>();

  for (const [name, schema] of roots) {
    names.set(schema, pythonName(name));
    usedNames.add(pythonName(name));
  }

  const uniqueName = (hint: string): string => {
    let candidate = pythonName(hint);
    let suffix = 2;
    while (usedNames.has(candidate)) candidate = `${pythonName(hint)}${suffix++}`;
    usedNames.add(candidate);
    return candidate;
  };

  const visitChild = (schema: Schema, hint: string): void => {
    const nullable = nullableBranch(schema);
    if (nullable) {
      visitChild(nullable, hint);
      return;
    }
    if (schema.type === "object" && schema.properties) {
      if (!names.has(schema)) names.set(schema, uniqueName(hint));
      visit(schema, names.get(schema)!);
      return;
    }
    if (schema.type === "array" && schema.items) {
      visitChild(schema.items as Schema, `${hint}Item`);
    }
    if (Array.isArray(schema.anyOf)) {
      for (const [index, branch] of (schema.anyOf as Schema[]).entries()) {
        if (branch.type !== "null") visitChild(branch, `${hint}Variant${index + 1}`);
      }
    }
  };

  const visit = (schema: Schema, name: string): void => {
    if (visited.has(schema)) return;
    visited.add(schema);
    const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [field, child] of Object.entries(properties)) {
      visitChild(child, `${name}${exportedName(field)}`);
    }
    ordered.push([name, schema]);
  };

  for (const [name, schema] of roots) visit(schema, pythonName(name));
  return ordered.map(([name, schema]) => pythonDeclaration(name, schema, names));
}

function inputSchemas(contract: DashboardContract): Record<string, Schema | null> {
  return Object.fromEntries(
    Object.entries(contract.procedures).map(([name, procedure]) => [name, procedure.input]),
  );
}

function generateGo(contract: DashboardContract): string {
  const declarations = [
    ...Object.entries(contract.$defs).map(([name, schema]) => goDeclaration(name, schema)),
    goDeclaration("DashboardRuntimeConfig", contract.html.runtimeConfig),
    ...Object.entries(contract.procedures).flatMap(([name, procedure]) => [
      goDeclaration(`${name}Input`, procedure.input ?? { type: "null" }),
      goDeclaration(`${name}Output`, procedure.output ?? { type: "null" }),
    ]),
  ].join("\n");
  const schemas = JSON.stringify(inputSchemas(contract));
  const wrappers = Object.keys(contract.procedures)
    .map(
      (name) =>
        `func Validate${exportedName(name)}Input(value any) error { return ValidateInput(${JSON.stringify(name)}, value) }`,
    )
    .join("\n");
  return `// Code generated by generate-bindings.ts from dashboard/v1/procedures.json. DO NOT EDIT.
package dashboard

import (
	"encoding/json"
	"fmt"
	"regexp"
)

${declarations}
var inputSchemas = func() map[string]any {
	var schemas map[string]any
	if err := json.Unmarshal([]byte(${JSON.stringify(schemas)}), &schemas); err != nil { panic(err) }
	return schemas
}()

// ValidateInput validates a decoded JSON value against a procedure's generated request schema.
func ValidateInput(procedure string, value any) error {
	schema, ok := inputSchemas[procedure]
	if !ok { return fmt.Errorf("unknown dashboard procedure %q", procedure) }
	if schema == nil {
		if value != nil { return fmt.Errorf("%s does not accept input", procedure) }
		return nil
	}
	return validateSchema(schema.(map[string]any), schema.(map[string]any), value, "$" )
}

${wrappers}

func validateSchema(schema, root map[string]any, value any, path string) error {
	if ref, ok := schema["$ref"].(string); ok {
		name := ref[len("#/$defs/"):]
		defs, _ := root["$defs"].(map[string]any)
		resolved, ok := defs[name].(map[string]any)
		if !ok { return fmt.Errorf("%s: unresolved schema reference %s", path, ref) }
		return validateSchema(resolved, root, value, path)
	}
	if branches, ok := schema["anyOf"].([]any); ok {
		for _, branch := range branches {
			if validateSchema(branch.(map[string]any), root, value, path) == nil { return nil }
		}
		return fmt.Errorf("%s: value does not match any allowed schema", path)
	}
	if expected, ok := schema["const"]; ok && !equalJSON(expected, value) {
		return fmt.Errorf("%s: value must equal %v", path, expected)
	}
	if values, ok := schema["enum"].([]any); ok {
		matched := false
		for _, expected := range values { if equalJSON(expected, value) { matched = true; break } }
		if !matched { return fmt.Errorf("%s: value is not in the allowed set", path) }
	}
	typeName, _ := schema["type"].(string)
	switch typeName {
	case "null": if value != nil { return fmt.Errorf("%s: expected null", path) }
	case "boolean": if _, ok := value.(bool); !ok { return fmt.Errorf("%s: expected boolean", path) }
	case "string":
		text, ok := value.(string); if !ok { return fmt.Errorf("%s: expected string", path) }
		if min, ok := number(schema["minLength"]); ok && float64(len([]rune(text))) < min { return fmt.Errorf("%s: string is too short", path) }
		if max, ok := number(schema["maxLength"]); ok && float64(len([]rune(text))) > max { return fmt.Errorf("%s: string is too long", path) }
		if pattern, ok := schema["pattern"].(string); ok { matched, err := regexp.MatchString(pattern, text); if err != nil || !matched { return fmt.Errorf("%s: string does not match %s", path, pattern) } }
	case "integer", "number":
		n, ok := number(value); if !ok || (typeName == "integer" && n != float64(int64(n))) { return fmt.Errorf("%s: expected %s", path, typeName) }
		if min, ok := number(schema["minimum"]); ok && n < min { return fmt.Errorf("%s: number is below minimum", path) }
		if max, ok := number(schema["maximum"]); ok && n > max { return fmt.Errorf("%s: number is above maximum", path) }
	case "array":
		items, ok := value.([]any); if !ok { return fmt.Errorf("%s: expected array", path) }
		if min, ok := number(schema["minItems"]); ok && float64(len(items)) < min { return fmt.Errorf("%s: array has too few items", path) }
		if max, ok := number(schema["maxItems"]); ok && float64(len(items)) > max { return fmt.Errorf("%s: array has too many items", path) }
		if child, ok := schema["items"].(map[string]any); ok { for index, item := range items { if err := validateSchema(child, root, item, fmt.Sprintf("%s[%d]", path, index)); err != nil { return err } } }
	case "object":
		object, ok := value.(map[string]any); if !ok { return fmt.Errorf("%s: expected object", path) }
		properties, _ := schema["properties"].(map[string]any)
		if required, ok := schema["required"].([]any); ok { for _, raw := range required { name := raw.(string); if _, exists := object[name]; !exists { return fmt.Errorf("%s.%s: required property is missing", path, name) } } }
		for name, childValue := range object {
			if child, exists := properties[name].(map[string]any); exists { if err := validateSchema(child, root, childValue, path+"."+name); err != nil { return err }; continue }
			if schema["additionalProperties"] == false { return fmt.Errorf("%s.%s: additional property is not allowed", path, name) }
			if child, ok := schema["additionalProperties"].(map[string]any); ok { if err := validateSchema(child, root, childValue, path+"."+name); err != nil { return err } }
		}
	}
	return nil
}

func number(value any) (float64, bool) {
	switch value := value.(type) { case float64: return value, true; case float32: return float64(value), true; case int: return float64(value), true; case int64: return float64(value), true; case json.Number: number, err := value.Float64(); return number, err == nil; default: return 0, false }
}

func equalJSON(left, right any) bool {
	leftNumber, leftIsNumber := number(left)
	rightNumber, rightIsNumber := number(right)
	if leftIsNumber || rightIsNumber { return leftIsNumber && rightIsNumber && leftNumber == rightNumber }
	return fmt.Sprint(left) == fmt.Sprint(right)
}
`;
}

function generatePython(contract: DashboardContract): string {
  const roots: Array<[string, Schema]> = [
    ...Object.entries(contract.$defs),
    ["DashboardRuntimeConfig", contract.html.runtimeConfig],
    ...Object.entries(contract.procedures).flatMap(([name, procedure]) => [
      [`${name}Input`, procedure.input ?? { type: "null" }] as [string, Schema],
      [`${name}Output`, procedure.output ?? { type: "null" }] as [string, Schema],
    ]),
  ];
  const declarations = pythonDeclarations(roots).join("\n\n");
  const schemas = JSON.stringify(inputSchemas(contract));
  const wrappers = Object.keys(contract.procedures)
    .map(
      (name) =>
        `def validate_${snakeName(name)}_input(value: object) -> None:\n    validate_input(${JSON.stringify(name)}, value)`,
    )
    .join("\n\n");
  return `# Code generated by generate-bindings.ts from dashboard/v1/procedures.json. DO NOT EDIT.
# ruff: noqa: E501
from __future__ import annotations

import json
import re
from typing import Literal, TypeAlias, TypedDict

from typing_extensions import NotRequired, Required

# fmt: off
# Generated declarations stay byte-for-byte stable across formatter versions.

${declarations}

_INPUT_SCHEMAS: dict[str, object] = json.loads(${JSON.stringify(schemas)})


class DashboardInputValidationError(ValueError):
    """A dashboard request does not match its generated JSON Schema."""


def validate_input(procedure: str, value: object) -> None:
    try:
        schema = _INPUT_SCHEMAS[procedure]
    except KeyError as error:
        raise DashboardInputValidationError(f"unknown dashboard procedure {procedure!r}") from error
    if schema is None:
        if value is not None:
            raise DashboardInputValidationError(f"{procedure} does not accept input")
        return
    _validate_schema(schema, schema, value, "$")


${wrappers}


def _validate_schema(schema: object, root: object, value: object, path: str) -> None:
    assert isinstance(schema, dict) and isinstance(root, dict)
    reference = schema.get("$ref")
    if isinstance(reference, str):
        definitions = root.get("$defs")
        if not isinstance(definitions, dict) or reference.removeprefix("#/$defs/") not in definitions:
            raise DashboardInputValidationError(f"{path}: unresolved schema reference {reference}")
        _validate_schema(definitions[reference.removeprefix("#/$defs/")], root, value, path)
        return
    branches = schema.get("anyOf")
    if isinstance(branches, list):
        for branch in branches:
            try:
                _validate_schema(branch, root, value, path)
                return
            except DashboardInputValidationError:
                pass
        raise DashboardInputValidationError(f"{path}: value does not match any allowed schema")
    if "const" in schema and value != schema["const"]:
        raise DashboardInputValidationError(f"{path}: value must equal {schema['const']!r}")
    allowed = schema.get("enum")
    if isinstance(allowed, list) and value not in allowed:
        raise DashboardInputValidationError(f"{path}: value is not in the allowed set")
    kind = schema.get("type")
    if kind == "null" and value is not None:
        raise DashboardInputValidationError(f"{path}: expected null")
    if kind == "boolean" and not isinstance(value, bool):
        raise DashboardInputValidationError(f"{path}: expected boolean")
    if kind == "string":
        if not isinstance(value, str):
            raise DashboardInputValidationError(f"{path}: expected string")
        if isinstance(schema.get("minLength"), int) and len(value) < schema["minLength"]:
            raise DashboardInputValidationError(f"{path}: string is too short")
        if isinstance(schema.get("maxLength"), int) and len(value) > schema["maxLength"]:
            raise DashboardInputValidationError(f"{path}: string is too long")
        if isinstance(schema.get("pattern"), str) and re.search(schema["pattern"], value) is None:
            raise DashboardInputValidationError(f"{path}: string does not match {schema['pattern']}")
    if kind in ("integer", "number"):
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise DashboardInputValidationError(f"{path}: expected {kind}")
        if kind == "integer" and not isinstance(value, int):
            raise DashboardInputValidationError(f"{path}: expected integer")
        if isinstance(schema.get("minimum"), int | float) and value < schema["minimum"]:
            raise DashboardInputValidationError(f"{path}: number is below minimum")
        if isinstance(schema.get("maximum"), int | float) and value > schema["maximum"]:
            raise DashboardInputValidationError(f"{path}: number is above maximum")
    if kind == "array":
        if not isinstance(value, list):
            raise DashboardInputValidationError(f"{path}: expected array")
        if isinstance(schema.get("minItems"), int) and len(value) < schema["minItems"]:
            raise DashboardInputValidationError(f"{path}: array has too few items")
        if isinstance(schema.get("maxItems"), int) and len(value) > schema["maxItems"]:
            raise DashboardInputValidationError(f"{path}: array has too many items")
        if isinstance(schema.get("items"), dict):
            for index, item in enumerate(value):
                _validate_schema(schema["items"], root, item, f"{path}[{index}]")
    if kind == "object":
        if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
            raise DashboardInputValidationError(f"{path}: expected object")
        properties = schema.get("properties", {})
        assert isinstance(properties, dict)
        required = schema.get("required", [])
        assert isinstance(required, list)
        for name in required:
            if name not in value:
                raise DashboardInputValidationError(f"{path}.{name}: required property is missing")
        for name, child_value in value.items():
            child = properties.get(name)
            if isinstance(child, dict):
                _validate_schema(child, root, child_value, f"{path}.{name}")
            elif schema.get("additionalProperties") is False:
                raise DashboardInputValidationError(f"{path}.{name}: additional property is not allowed")
            elif isinstance(schema.get("additionalProperties"), dict):
                _validate_schema(schema["additionalProperties"], root, child_value, f"{path}.{name}")
`;
}

export async function composeDashboardBindings(): Promise<Record<string, string>> {
  const contract = JSON.parse(await readFile(contractPath, "utf8")) as DashboardContract;
  return {
    "go/dashboard/v1_generated.go": execFileSync("gofmt", {
      input: generateGo(contract),
      encoding: "utf8",
    }),
    "python/src/workhorse/dashboard_v1.py": generatePython(contract),
  };
}

export async function checkDashboardBindings(): Promise<string[]> {
  const bindings = await composeDashboardBindings();
  const stale: string[] = [];
  for (const [name, content] of Object.entries(bindings)) {
    const committed = await readFile(outputPaths[name as keyof typeof outputPaths], "utf8").catch(
      () => null,
    );
    if (committed !== content) stale.push(name);
  }
  return stale;
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  if (process.argv.includes("--check")) {
    const stale = await checkDashboardBindings();
    if (stale.length > 0) {
      console.error(
        `Dashboard bindings are stale: ${stale.join(", ")}. Run pnpm dashboard-bindings:generate and commit the result.`,
      );
      process.exit(1);
    }
    console.log("Dashboard bindings match dashboard/v1/procedures.json.");
  } else {
    const bindings = await composeDashboardBindings();
    for (const [name, content] of Object.entries(bindings)) {
      await writeFile(outputPaths[name as keyof typeof outputPaths], content);
    }
    console.log(`Wrote ${Object.keys(bindings).join(", ")}`);
  }
}
