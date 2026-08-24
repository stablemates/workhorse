import type { Json } from "@stablemates/workhorse";

export const DURABLE_DEMO_JOB_TYPE = "demo.durable-pipeline";

export const durableDemoScenarios = {
  "order-fulfillment": {
    label: "Order fulfillment",
    description: "Reserve stock and payment once, then continue safely after a worker retry.",
    failAfterStep: 1,
    persistentFailAfterStep: 1,
    steps: [
      {
        name: "validate-order",
        label: "Validate order",
        description: "Validate the immutable order request.",
      },
      {
        name: "reserve-inventory",
        label: "Reserve inventory",
        description: "Create one durable stock reservation.",
      },
      {
        name: "authorize-payment",
        label: "Authorize payment",
        description: "Reuse prior work before authorizing payment.",
      },
      {
        name: "arrange-shipment",
        label: "Arrange shipment",
        description: "Create the final shipment instruction.",
      },
    ],
  },
  "customer-onboarding": {
    label: "Customer onboarding",
    description: "Provision a customer account through restart-safe boundaries.",
    failAfterStep: 0,
    persistentFailAfterStep: 0,
    steps: [
      {
        name: "create-account",
        label: "Create account",
        description: "Persist the external account identity.",
      },
      {
        name: "provision-workspace",
        label: "Provision workspace",
        description: "Create the customer's isolated workspace.",
      },
      {
        name: "send-welcome",
        label: "Send welcome",
        description: "Record the welcome-message delivery.",
      },
    ],
  },
  "report-publication": {
    label: "Report publication",
    description: "Build and publish a report without repeating completed stages.",
    failAfterStep: 2,
    persistentFailAfterStep: 1,
    steps: [
      {
        name: "snapshot-data",
        label: "Snapshot data",
        description: "Freeze the source data used by the report.",
      },
      {
        name: "render-report",
        label: "Render report",
        description: "Render one stable report artifact.",
      },
      {
        name: "publish-report",
        label: "Publish report",
        description: "Publish the artifact to its durable destination.",
      },
    ],
  },
} as const;

export type DurableDemoScenario = keyof typeof durableDemoScenarios;

export type DurableDemoPayload = {
  [key: string]: Json;
  scenario: DurableDemoScenario;
};

/** The declared stage after which a seeded `failureMode: "continuous"` task cannot advance. */
export interface DurablePersistentFailure {
  afterStepIndex: number;
  afterStepName: string;
  beforeStepName: string;
  /** Plain sentence an operator can read without decoding the seed payload. */
  reason: string;
}

export interface DurableDemoPlan {
  source: "demo-declared";
  scenario: DurableDemoScenario;
  label: string;
  description: string;
  steps: Array<{ name: string; label: string; description: string }>;
  /** Null for an ordinary task. Non-null only for the intentionally blocked seeded tasks. */
  persistentFailure: DurablePersistentFailure | null;
}

export function parseDurableDemoScenario(value: unknown): DurableDemoScenario | null {
  return typeof value === "string" && Object.hasOwn(durableDemoScenarios, value)
    ? (value as DurableDemoScenario)
    : null;
}

export function durableDemoPlanForJob(type: string, payload: unknown): DurableDemoPlan | null {
  if (type !== DURABLE_DEMO_JOB_TYPE || !payload || typeof payload !== "object") return null;
  const scenario = parseDurableDemoScenario((payload as { scenario?: unknown }).scenario);
  if (!scenario) return null;
  const definition = durableDemoScenarios[scenario];
  const persistentFailure =
    (payload as { failureMode?: unknown }).failureMode === "continuous"
      ? persistentFailureFor(scenario)
      : null;
  return {
    source: "demo-declared",
    scenario,
    label: definition.label,
    description: definition.description,
    steps: definition.steps.map((step) => ({
      name: step.name,
      label: step.label,
      description: step.description,
    })),
    persistentFailure,
  };
}

export function persistentFailureFor(scenario: DurableDemoScenario): DurablePersistentFailure {
  const definition = durableDemoScenarios[scenario];
  const index = Math.min(definition.persistentFailAfterStep, definition.steps.length - 2);
  const step = definition.steps[index]!;
  const nextStep = definition.steps[index + 1]!;
  return {
    afterStepIndex: index,
    afterStepName: step.name,
    beforeStepName: nextStep.name,
    reason: `It is now seeded to fail on every attempt after ${step.label} and before ${nextStep.label}, so it cannot reach later stages.`,
  };
}

/**
 * Vocabulary shared with the dashboard drawer.
 *
 * These functions are pure and live beside the demo scenario declaration so the wording can be
 * asserted directly, without rendering React.
 */

export type DurableBoundaryState = "saved" | "blocked" | "not-reached" | "pending";

export interface DurableBoundaryDescription {
  state: DurableBoundaryState;
  /** Short text badge. Carries the state on its own, so colour stays decoration. */
  label: string;
  /** One sentence that is true without reading any other part of the drawer. */
  summary: string;
}

/**
 * State of one declared stage.
 *
 * A stage after a persistent blocking boundary is reported as never reached rather than as
 * waiting to run, because no future attempt can get there.
 */
export function describeDurableBoundary(input: {
  stepIndex: number;
  hasCheckpoint: boolean;
  persistentFailureAfterStepIndex: number | null;
}): DurableBoundaryDescription {
  const blockedAfter = input.persistentFailureAfterStepIndex;
  if (input.hasCheckpoint) {
    if (blockedAfter !== null && input.stepIndex === blockedAfter) {
      return {
        state: "blocked",
        label: "Intentionally blocked between stages",
        summary:
          "This checkpoint output is durable, but the seeded failure stops the task immediately after this stage, so nothing past it can run.",
      };
    }
    return {
      state: "saved",
      label: "Checkpoint saved",
      summary:
        "The checkpoint output for this stage is stored and is reused by every later attempt.",
    };
  }
  if (blockedAfter !== null && input.stepIndex > blockedAfter) {
    return {
      state: "not-reached",
      label: "Not reached",
      summary:
        "This stage was never reached and no future attempt can reach it, because the task is blocked at an earlier stage.",
    };
  }
  return {
    state: "pending",
    label: "No checkpoint yet",
    summary: "No checkpoint output has been stored for this stage yet.",
  };
}

export type TaskResultState = "succeeded" | "failed" | "canceled" | "pending";

export interface TaskResultDescription {
  state: TaskResultState;
  /** Badge text. Never the raw stored state and never colour-dependent. */
  label: string;
  /** One sentence stating what the stored evidence does and does not prove. */
  summary: string;
  /** Heading for the stored JSON value, or null when there is no final value to show. */
  valueLabel: string | null;
  /** Shown instead of a value, so an empty state never renders an invented value. */
  emptyLabel: string | null;
}

export interface TaskResultEvidence {
  description: TaskResultDescription;
  value: unknown;
}

/**
 * Final outcome of one task, described from the stored terminal row only.
 *
 * A live or scheduled task has no final outcome, and that is stated plainly rather than shown as
 * an empty result. A scheduled retry may still carry the error from its latest finished attempt,
 * which is labelled as an attempt error, never as a terminal one.
 */
export function describeTaskResult(input: {
  state: string;
  hasOutcome: boolean;
  outcomeState: string | null;
  hasResultValue: boolean;
  hasErrorValue: boolean;
  blockedByPersistentFailure: boolean;
}): TaskResultDescription {
  const terminal = input.hasOutcome ? (input.outcomeState ?? input.state) : null;
  if (terminal === "succeeded") {
    return {
      state: "succeeded",
      label: "Succeeded",
      summary: "The task finished successfully and this is the stored final result.",
      valueLabel: input.hasResultValue ? "Final result" : null,
      emptyLabel: input.hasResultValue
        ? null
        : "This task returned no value, so no final result was stored.",
    };
  }
  if (terminal === "failed" || terminal === "canceled") {
    const failed = terminal === "failed";
    return {
      state: failed ? "failed" : "canceled",
      label: failed ? "Failed" : "Canceled",
      summary: failed
        ? "The task exhausted its attempts and ended as failed, so no result was produced."
        : "The task was canceled before it could produce a result, so nothing here reports success.",
      valueLabel: input.hasErrorValue ? "Terminal error" : null,
      emptyLabel: input.hasErrorValue
        ? null
        : failed
          ? "No error value was stored with the terminal failure."
          : "No error value was stored with the cancellation.",
    };
  }
  return {
    state: "pending",
    label: "No final outcome yet",
    summary: input.blockedByPersistentFailure
      ? "This task is seeded to fail on every attempt. It has no final outcome while retries remain; exhausting its attempt budget records a terminal failure."
      : "This task has not finished, so no final result or terminal error exists yet.",
    valueLabel: input.hasErrorValue ? "Latest attempt error" : null,
    emptyLabel: input.hasErrorValue
      ? null
      : "No attempt has failed yet, so there is nothing to show.",
  };
}

/** Derive drawer evidence from the real nullable PostgreSQL projection. */
export function readTaskResultEvidence(input: {
  state: string;
  outcome: { state: string; result: unknown; error: unknown } | null;
  runtimeError: unknown;
  currentError: unknown;
  blockedByPersistentFailure: boolean;
}): TaskResultEvidence {
  const terminalValue =
    input.outcome?.state === "succeeded" ? input.outcome.result : input.outcome?.error;
  const pendingValue = input.runtimeError ?? input.currentError;
  const value = input.outcome !== null ? terminalValue : pendingValue;
  const hasValue = value !== null && value !== undefined;
  const description = describeTaskResult({
    state: input.state,
    hasOutcome: input.outcome !== null,
    outcomeState: input.outcome?.state ?? null,
    hasResultValue: input.outcome?.state === "succeeded" && hasValue,
    hasErrorValue: input.outcome?.state !== "succeeded" && hasValue,
    blockedByPersistentFailure: input.blockedByPersistentFailure,
  });
  return {
    description,
    value: description.valueLabel === null ? undefined : value,
  };
}
