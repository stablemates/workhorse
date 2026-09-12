/**
 * Textual signals for the three known mistakes, read off a produced program.
 *
 * A signal is not a proof. WH-524 scores the mistakes as a small per-language assertion plus a
 * maintainer's read that the fixture records, and the read is what a note cites. These functions
 * exist so a read and a program that disagree are reported rather than hidden, and so a fixture
 * whose program was never kept still scores its other dimensions.
 *
 * Executing a produced program to observe the failure is a separate Issue, deliberately.
 */
import type { Language } from "./tasks.js";
import type { MistakeName, MistakeVerdict } from "./transcript.js";

/** What a signal can conclude. "unclear" never contradicts a recorded read. */
export type SignalVerdict = MistakeVerdict | "unclear";

export interface Signal {
  readonly verdict: SignalVerdict;
  /** Why, in one clause, for the report. */
  readonly reason: string;
}

/** Identifiers that carry a transaction into an enqueue call. */
const transactionTokens = /\b(tx|trx|transaction|txn|client|connection|conn|executor)\b/;

/**
 * Argument text of every call to `name` in `source`, matched by counting parentheses so a nested
 * call does not truncate the arguments. String contents are scanned too, which is harmless: a
 * transaction token inside a string literal argument is not a case that arises here.
 */
function callArguments(source: string, name: string): string[] {
  const found: string[] = [];
  const opener = new RegExp(`\\b${name}\\s*\\(`, "g");
  let match = opener.exec(source);
  while (match !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
      }
      index += 1;
    }
    if (depth === 0) {
      found.push(source.slice(start, index - 1));
    }
    opener.lastIndex = index;
    match = opener.exec(source);
  }
  return found;
}

function fromPattern(
  source: string,
  clean: RegExp,
  dirty: RegExp | undefined,
  reasons: { readonly clean: string; readonly dirty: string; readonly unclear: string },
): Signal {
  if (dirty !== undefined && dirty.test(source)) {
    return { verdict: "committed", reason: reasons.dirty };
  }
  if (clean.test(source)) {
    return { verdict: "clean", reason: reasons.clean };
  }
  return { verdict: "unclear", reason: reasons.unclear };
}

/**
 * TypeScript carries the transaction as a fourth argument to `enqueue`, so every call site is
 * checkable on its own. Python builds the `Queue` over the connection and Go wraps it in an
 * executor, so those two are matched by construction instead.
 */
function enqueueSignal(source: string, language: Language): Signal {
  if (language === "typescript") {
    const calls = callArguments(source, "enqueue");
    if (calls.length === 0) {
      return { verdict: "unclear", reason: "no enqueue call found" };
    }
    const bare = calls.filter((argumentText) => !transactionTokens.test(argumentText));
    if (bare.length > 0) {
      return {
        verdict: "committed",
        reason: `${bare.length} of ${calls.length} enqueue calls name no transaction`,
      };
    }
    return { verdict: "clean", reason: `all ${calls.length} enqueue calls name a transaction` };
  }
  if (language === "python") {
    return fromPattern(
      source,
      /Queue\s*\([^)]*\b(conn|connection|cursor|tx|transaction)\b/,
      undefined,
      {
        clean: "the Queue is constructed over a connection",
        dirty: "",
        unclear: "no Queue construction naming a connection",
      },
    );
  }
  return fromPattern(source, /NewPGXExecutor\s*\(/, undefined, {
    clean: "the queue wraps the transaction in NewPGXExecutor",
    dirty: "",
    unclear: "no NewPGXExecutor call",
  });
}

interface SourceRegion {
  readonly name: string | undefined;
  readonly body: string;
}

type SchemaCallContext = "deploy" | "runtime" | "unknown";

/**
 * Recorded programs are usually Markdown with one fenced block per proposed file. Keep the file
 * heading with each block so a deploy entry point is not confused with the worker beside it.
 */
function sourceRegions(source: string): readonly SourceRegion[] {
  const fences = [...source.matchAll(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)];
  if (fences.length === 0) {
    return [{ name: undefined, body: source }];
  }
  return fences.map((fence) => {
    const before = source.slice(0, fence.index);
    const headings = [...before.matchAll(/^#{1,6}\s+.*`([^`\n]+)`.*$/gm)];
    return { name: headings.at(-1)?.[1], body: fence[1] ?? "" };
  });
}

const deployPath =
  /(?:^|[/_.-])(deploy(?:ment)?|migrat(?:e|ion)|install[-_.]?schema|schema[-_.]?install)(?:[/_.-]|$)/i;
const runtimePath =
  /(?:^|[/_.-])(worker|handler|server|main|client|jobs?)(?:[/_.-]|$)|(?:^|\/)app\//i;
const deployFunction = /\b(?:function|func|def)\s+\w*(?:deploy|migrat|install)\w*\b/i;
const runtimeFunction = /\b(?:function|func|def)\s+\w*(?:handle|worker|run|start|main)\w*\b/i;
const runtimeCallback = /(?:\bworker\s*\.\s*handle|\bdefineWorkerProcess|\bcreate\w*Handler)\s*\(/i;

/** Headers of the brace-delimited scopes containing one call, nearest scope first. */
function containingScopeHeaders(source: string, callIndex: number): readonly string[] {
  const openings: number[] = [];
  for (let index = 0; index < callIndex; index += 1) {
    if (source[index] === "{") {
      openings.push(index);
    } else if (source[index] === "}") {
      openings.pop();
    }
  }
  return openings.toReversed().map((opening) => source.slice(Math.max(0, opening - 240), opening));
}

function schemaCallContext(region: SourceRegion, callIndex: number): SchemaCallContext {
  if (region.name !== undefined && deployPath.test(region.name)) {
    return "deploy";
  }
  if (region.name !== undefined && runtimePath.test(region.name)) {
    return "runtime";
  }

  const scopeHeaders = containingScopeHeaders(region.body, callIndex);
  if (scopeHeaders.some((header) => deployFunction.test(header))) {
    return "deploy";
  }
  if (scopeHeaders.some((header) => runtimeFunction.test(header) || runtimeCallback.test(header))) {
    return "runtime";
  }

  // Python has indentation rather than braces. The nearest function declaration owns the call.
  const declarations = [
    ...region.body.slice(0, callIndex).matchAll(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/gm),
  ];
  const functionName = declarations.at(-1)?.[1];
  if (functionName !== undefined && /deploy|migrat|install/i.test(functionName)) {
    return "deploy";
  }
  if (functionName !== undefined && /handle|worker|run|start|main/i.test(functionName)) {
    return "runtime";
  }
  return "unknown";
}

function schemaSignal(source: string, language: Language): Signal {
  const installer = language === "python" ? /\binstall_schema\s*\(/g : /\b[iI]nstallSchema\s*\(/g;
  const verifier =
    language === "typescript"
      ? /\bassertSchemaCompatible\s*\(/
      : language === "go"
        ? /\bAssert(?:Schema)?Compatible\s*\(/
        : /\bassert_(?:schema|sync|async)_compatible\s*\(/;
  const calls = sourceRegions(source).flatMap((region) =>
    [...region.body.matchAll(installer)].map((match) => ({
      context: schemaCallContext(region, match.index),
      name: region.name,
    })),
  );
  const runtimeCall = calls.find((call) => call.context === "runtime");
  if (runtimeCall !== undefined) {
    const location = runtimeCall.name === undefined ? "a runtime function" : runtimeCall.name;
    return { verdict: "committed", reason: `schema installation runs from ${location}` };
  }
  if (calls.some((call) => call.context === "unknown")) {
    return {
      verdict: "unclear",
      reason: "schema installation cannot be placed on a deploy-time or runtime path",
    };
  }
  if (calls.length > 0) {
    const locations = [
      ...new Set(calls.flatMap((call) => (call.name === undefined ? [] : [call.name]))),
    ];
    const where = locations.length === 0 ? "a named deploy function" : locations.join(", ");
    return {
      verdict: "clean",
      reason: `schema installation is confined to deploy-time code in ${where}`,
    };
  }
  if (verifier.test(source)) {
    return {
      verdict: "clean",
      reason: "the application verifies the schema and does not install it",
    };
  }
  return { verdict: "clean", reason: "the application never installs the schema" };
}

function checkpointSignal(source: string, language: Language): Signal {
  const checkpoint = language === "go" ? /\bCheckpoint\s*\(/ : /\bcheckpoint\s*\(/;
  const handler =
    language === "go"
      ? /\b(Handle|RunOnce|Run)\s*\(/
      : language === "python"
        ? /\b(handle|run_once|run)\s*\(/
        : /\b(handle|runOnce|run)\s*\(/;
  if (checkpoint.test(source)) {
    return { verdict: "clean", reason: "the external effect is wrapped in a checkpoint" };
  }
  if (handler.test(source)) {
    return { verdict: "committed", reason: "a handler exists and names no checkpoint" };
  }
  return { verdict: "unclear", reason: "no handler found" };
}

/** Read all three signals off one produced program. */
export function readSignals(
  source: string,
  language: Language,
): Readonly<Record<MistakeName, Signal>> {
  return {
    enqueueOutsideTransaction: enqueueSignal(source, language),
    schemaOnRuntimePath: schemaSignal(source, language),
    effectOutsideCheckpoint: checkpointSignal(source, language),
  };
}

/** A signal contradicts a recorded read only when both are decided and they differ. */
export function contradicts(signal: Signal, recorded: MistakeVerdict): boolean {
  return signal.verdict !== "unclear" && signal.verdict !== recorded;
}
