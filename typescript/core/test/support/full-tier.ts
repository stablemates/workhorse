/**
 * The error PostgreSQL raises when a worker probes a full-tier queue with the fast claim. A fake
 * database throws it so the worker under test falls back to `claim_many_v1`, as it would against a
 * real installation.
 */
export function fullTierProbeRejection(queue = "default"): Error {
  return Object.assign(new Error("queue is not on the fast tier"), {
    code: "P1007",
    detail: JSON.stringify({ queue, feature: "batched completion" }),
  });
}
