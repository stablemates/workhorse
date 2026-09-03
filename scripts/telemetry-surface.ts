import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import { repositoryRoot } from "./packages.js";

/**
 * The telemetry names Workhorse emits, read from the source that emits them.
 *
 * ADR 0054 governs instrument, span, and attribute names, and no compiler stands behind them: an
 * instrument name is a string a dashboard alert matches by hand, so renaming one breaks a consumer
 * silently. This module reads those strings out of the emitting source with the TypeScript parser,
 * which is what makes the check worth having. A table declared beside the emitters, rather than
 * consulted by them, would leave a rename in the source and no change in the snapshot.
 *
 * Four shapes carry a name:
 *
 * - `lazyCounter`, `lazyHistogram`, and `lazyGauge` each take the instrument's name, description,
 *   and unit, and the helper's own name states the kind.
 * - An asynchronous observation is an element of a `TelemetryObservationDefinition` array, which
 *   carries the same three fields and is always an observable gauge.
 * - A span is the first argument of a `withSpan` call.
 * - An attribute is a `workhorse.`-prefixed string in object-literal property position, or the
 *   first argument of a `setAttribute` call.
 *
 * Log event names are not read here. `WorkhorseLogEvent` is an exported union, so `api/typescript.txt`
 * already prints every member and the compiler already refuses an unlisted one.
 *
 * `scripts/generate-telemetry-surface.ts` writes the rendering to `api/telemetry.txt`.
 */

/** The three synchronous instrument helpers, mapped to the kind each one creates. */
const instrumentHelpers: Readonly<Record<string, string>> = {
  lazyCounter: "counter",
  lazyHistogram: "histogram",
  lazyGauge: "gauge",
};

/** The type whose array elements declare an asynchronous observation. */
const observationType = "TelemetryObservationDefinition";

/** The `typescript/` packages whose `src` emits telemetry. */
const emittingPackages = ["core", "otel"] as const;

export interface TelemetryInstrument {
  readonly name: string;
  /** `counter`, `histogram`, `gauge`, or `observable_gauge`. */
  readonly kind: string;
  readonly unit: string;
  readonly description: string;
}

export interface TelemetrySurface {
  readonly instruments: readonly TelemetryInstrument[];
  readonly spans: readonly string[];
  readonly attributes: readonly string[];
}

/** Compare by UTF-16 code unit so the ordering does not depend on the machine's locale. */
function compare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Every `.ts` file under one directory, recursively, sorted so a reading is reproducible. */
async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return await sourceFiles(full);
      return entry.isFile() && full.endsWith(".ts") ? [full] : [];
    }),
  );
  return nested.flat().toSorted(compare);
}

function stringLiteral(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** One string-literal property of an object literal, or `undefined` when it states none. */
function literalProperty(node: ts.Node | undefined, field: string): string | undefined {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (property.name.getText() === field) return stringLiteral(property.initializer);
  }
  return undefined;
}

/**
 * Whether an array literal's elements declare asynchronous observations.
 *
 * The elements are ordinary object literals, so the type annotation on the declaration that holds
 * them is what says they are observations rather than anything else with a name and a unit.
 */
function isObservationArray(node: ts.ArrayLiteralExpression): boolean {
  const declaration = node.parent;
  if (!ts.isVariableDeclaration(declaration)) return false;
  return declaration.type?.getText().includes(observationType) ?? false;
}

/**
 * Whether a string sits in object-literal property position, which is where an attribute appears.
 *
 * An instrument name, a span name, and a log event name are all call arguments rather than property
 * names, so this one rule separates attributes from every other `workhorse.`-prefixed string.
 */
function isPropertyName(node: ts.StringLiteralLike): boolean {
  return ts.isPropertyAssignment(node.parent) && node.parent.name === node;
}

/** The name a call's callee ends in, for example `setAttribute` or `lazyCounter`. */
function calleeName(node: ts.CallExpression): string {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return ts.isIdentifier(callee) ? callee.text : "";
}

/**
 * Everything one traversal found, keyed by name.
 *
 * The same attribute appears on many spans and many metrics, and a second sighting adds nothing, so
 * the first one recorded wins.
 */
class SurfaceCollector {
  readonly instruments = new Map<string, TelemetryInstrument>();
  readonly spans = new Set<string>();
  readonly attributes = new Set<string>();

  private instrument(name: string, kind: string, options: ts.Node | undefined): void {
    if (this.instruments.has(name)) return;
    this.instruments.set(name, {
      name,
      kind,
      unit: literalProperty(options, "unit") ?? "",
      description: literalProperty(options, "description") ?? "",
    });
  }

  visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node);
      const kind = instrumentHelpers[callee];
      const argument = stringLiteral(node.arguments[0]);
      if (argument !== undefined) {
        if (kind !== undefined) this.instrument(argument, kind, node.arguments[1]);
        if (callee === "withSpan") this.spans.add(argument);
        if (callee === "setAttribute") this.attributes.add(argument);
      }
    }
    if (ts.isArrayLiteralExpression(node) && isObservationArray(node)) {
      for (const element of node.elements) {
        const name = literalProperty(element, "name");
        if (name !== undefined) this.instrument(name, "observable_gauge", element);
      }
    }
    if (
      ts.isStringLiteralLike(node) &&
      node.text.startsWith("workhorse.") &&
      isPropertyName(node)
    ) {
      this.attributes.add(node.text);
    }
    ts.forEachChild(node, (child) => this.visit(child));
  }
}

/** Read every telemetry name the emitting packages state. */
export async function telemetrySurface(): Promise<TelemetrySurface> {
  const perPackage = await Promise.all(
    emittingPackages.map(
      async (directory) =>
        await sourceFiles(path.join(repositoryRoot, "typescript", directory, "src")),
    ),
  );
  const collector = new SurfaceCollector();
  for (const file of perPackage.flat()) {
    const text = await readFile(file, "utf8");
    collector.visit(
      ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS),
    );
  }
  // A reader that stops matching the source would otherwise generate an empty snapshot, and an
  // empty snapshot passes every rename. Refuse to write one instead.
  if (collector.instruments.size === 0 || collector.spans.size === 0) {
    throw new Error(
      "Read no instruments or no spans from the emitting packages; the reader no longer matches the source",
    );
  }
  return {
    instruments: [...collector.instruments.values()].toSorted((left, right) =>
      compare(left.name, right.name),
    ),
    spans: [...collector.spans].toSorted(compare),
    attributes: [...collector.attributes].toSorted(compare),
  };
}

/** Pad each column to its widest entry, so a renamed instrument shows as one changed line. */
function renderInstruments(instruments: readonly TelemetryInstrument[]): string {
  const width = (read: (entry: TelemetryInstrument) => string): number =>
    Math.max(...instruments.map((entry) => read(entry).length));
  const nameWidth = width((entry) => entry.name);
  const kindWidth = width((entry) => entry.kind);
  const unitWidth = width((entry) => entry.unit);
  return instruments
    .map((entry) =>
      [
        entry.name.padEnd(nameWidth),
        entry.kind.padEnd(kindWidth),
        entry.unit.padEnd(unitWidth),
        entry.description,
      ].join("  "),
    )
    .join("\n");
}

export function renderTelemetry(surface: TelemetrySurface): string {
  return [
    "## Instruments",
    "",
    "# name  kind  unit  description",
    "",
    renderInstruments(surface.instruments),
    "",
    "## Spans",
    "",
    surface.spans.join("\n"),
    "",
    "## Attributes",
    "",
    surface.attributes.join("\n"),
    "",
  ].join("\n");
}
