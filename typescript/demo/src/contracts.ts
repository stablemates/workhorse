import type { QueueOptions } from "@stablemates/workhorse";

/**
 * The demo's one contracted task type.
 *
 * Every process that accepts or completes `demo.contract-check` work must share these options:
 * the web tier and the seed validate payloads at enqueue, while the workers validate results at
 * completion. A process that omitted them would refuse to complete contracted tasks it claimed.
 */
export const DEMO_CONTRACT_TASK_TYPE = "demo.contract-check";
const DEMO_CONTRACT_VERSION = "v1";
const DEMO_CONTRACT_MAX_RESULT_BYTES = 2_048;

export const DEMO_QUEUE_OPTIONS: QueueOptions = {
  contracts: {
    [DEMO_CONTRACT_TASK_TYPE]: {
      currentVersion: DEMO_CONTRACT_VERSION,
      versions: {
        [DEMO_CONTRACT_VERSION]: {
          payloadSchema: {
            type: "object",
            required: ["invoiceId"],
            properties: { invoiceId: { type: "string", minLength: 1 } },
          },
          resultSchema: {
            type: "object",
            required: ["approved"],
            properties: { approved: { type: "boolean" } },
          },
          maxResultBytes: DEMO_CONTRACT_MAX_RESULT_BYTES,
        },
      },
    },
  },
};
