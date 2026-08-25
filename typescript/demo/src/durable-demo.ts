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
