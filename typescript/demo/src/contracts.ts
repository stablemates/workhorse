import type { Json, QueueOptions } from "@workhorse/core";

/**
 * The demo's one contracted job type.
 *
 * Every process that accepts or completes `demo.contract-check` work must share these options:
 * the web tier and the seed validate payloads at enqueue, while the workers validate results at
 * completion. A process that omitted them would refuse to complete contracted jobs it claimed.
 */
export const DEMO_CONTRACT_JOB_TYPE = "demo.contract-check";
export const DEMO_CONTRACT_VERSION = "v1";
export const DEMO_CONTRACT_MAX_RESULT_BYTES = 2_048;

function isPlainObject(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const DEMO_QUEUE_OPTIONS: QueueOptions = {
  contracts: {
    [DEMO_CONTRACT_JOB_TYPE]: {
      currentVersion: DEMO_CONTRACT_VERSION,
      versions: {
        [DEMO_CONTRACT_VERSION]: {
          validatePayload: (payload) =>
            isPlainObject(payload) &&
            typeof payload["invoiceId"] === "string" &&
            payload["invoiceId"].length > 0,
          validateResult: (result) =>
            isPlainObject(result) && typeof result["approved"] === "boolean",
          maxResultBytes: DEMO_CONTRACT_MAX_RESULT_BYTES,
        },
      },
    },
  },
};
