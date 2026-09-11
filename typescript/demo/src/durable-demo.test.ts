import { describe, expect, it } from "vitest";
import {
  durableDemoPlanForTask,
  durableDemoScenarios,
  DURABLE_DEMO_TASK_TYPE,
} from "./durable-demo.js";

describe("persistent failure projection", () => {
  it("marks a seeded continuous-failure task and leaves ordinary tasks untouched", () => {
    const ordinary = durableDemoPlanForTask(DURABLE_DEMO_TASK_TYPE, {
      scenario: "order-fulfillment",
    });
    expect(ordinary?.persistentFailure).toBeNull();

    const blocked = durableDemoPlanForTask(DURABLE_DEMO_TASK_TYPE, {
      scenario: "order-fulfillment",
      failureMode: "continuous",
    });
    expect(blocked?.persistentFailure).toMatchObject({
      afterStepIndex: durableDemoScenarios["order-fulfillment"].persistentFailAfterStep,
      afterStepName: "reserve-inventory",
      beforeStepName: "authorize-payment",
    });
    expect(blocked?.persistentFailure?.reason).toContain("every attempt");
  });

  it("keeps every declared boundary inside the declared step list", () => {
    for (const [scenario, definition] of Object.entries(durableDemoScenarios)) {
      const plan = durableDemoPlanForTask(DURABLE_DEMO_TASK_TYPE, {
        scenario,
        failureMode: "continuous",
      });
      const index = plan?.persistentFailure?.afterStepIndex;
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(definition.steps.length - 1);
      expect(plan?.persistentFailure?.beforeStepName).toBe(definition.steps[index! + 1]!.name);
    }
  });

  it("leaves a task with no declared plan without an invented boundary", () => {
    expect(durableDemoPlanForTask("demo.recurring", { failureMode: "continuous" })).toBeNull();
  });
});
