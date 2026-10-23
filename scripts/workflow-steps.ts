import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Document,
  type Node,
} from "yaml";

/** One `with` input of a workflow step, with the source line that sets it. */
export interface StepInput {
  readonly value: unknown;
  readonly line: number;
  /** The full source line, so a check can read the comment after the value. */
  readonly text: string;
}

/** One step of a workflow job that runs an action through `uses`. */
export interface ActionStep {
  /** `file:line job[index]`, for a failure message that names where to look. */
  readonly location: string;
  readonly job: string;
  /** The action without its ref, for example `actions/setup-node`. */
  readonly action: string;
  /** The inputs by lowercase name, because GitHub reads an input name without its case. */
  readonly inputs: ReadonlyMap<string, StepInput>;
  /** Each input name that the step sets twice when the case is ignored. */
  readonly duplicateInputs: readonly string[];
  /** The `if` condition of the step, if it has one. */
  readonly condition: unknown;
  /** The `strategy.matrix` value of the job, as the source writes it. */
  readonly matrix: unknown;
}

function lineOf(node: Node, counter: LineCounter): number {
  return counter.linePos(node.range?.[0] ?? 0).line;
}

/** The node itself, or the node that an alias such as `*name` names. */
function resolved(node: unknown, document: Document): unknown {
  return isAlias(node) ? node.resolve(document) : node;
}

/** Every step of every job in a workflow that runs an action, in source order. */
export function actionSteps(file: string, source: string): ActionStep[] {
  const counter = new LineCounter();
  const document = parseDocument(source, { lineCounter: counter });
  const lines = source.split("\n");
  const jobs = resolved(document.get("jobs", true), document);
  if (!isMap(jobs)) return [];
  const found: ActionStep[] = [];
  for (const job of jobs.items) {
    const name = isScalar(job.key) ? String(job.key.value) : "?";
    const body = resolved(job.value, document);
    if (!isMap(body)) continue;
    const strategy = resolved(body.get("strategy", true), document);
    const matrix = isMap(strategy) ? resolved(strategy.get("matrix", true), document) : undefined;
    const steps = resolved(body.get("steps", true), document);
    if (!isSeq(steps)) continue;
    steps.items.forEach((item, index) => {
      const step = resolved(item, document);
      if (!isMap(step)) return;
      const uses = resolved(step.get("uses", true), document);
      const condition = resolved(step.get("if", true), document);
      if (!isScalar(uses) || typeof uses.value !== "string") return;
      const inputs = new Map<string, StepInput>();
      const duplicateInputs: string[] = [];
      const values = resolved(step.get("with", true), document);
      if (isMap(values))
        for (const pair of values.items) {
          const value = resolved(pair.value, document);
          if (!isScalar(pair.key) || !isScalar(value)) continue;
          // The line of the key, because an alias value points at the line of its anchor.
          const line = lineOf(pair.key, counter);
          const input = String(pair.key.value).toLowerCase();
          if (inputs.has(input)) duplicateInputs.push(input);
          inputs.set(input, {
            value: value.value,
            line,
            text: lines[line - 1] ?? "",
          });
        }
      found.push({
        location: `${file}:${lineOf(step, counter)} ${name}[${index}]`,
        job: name,
        action: uses.value.replace(/@.*$/, ""),
        inputs,
        duplicateInputs,
        condition: isScalar(condition) ? condition.value : undefined,
        matrix: isScalar(matrix) ? matrix.value : isMap(matrix) ? matrix.toJSON() : undefined,
      });
    });
  }
  return found;
}
