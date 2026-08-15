# Batch dispatch default-profile analysis

**Recorded:** 2026-08-14  
**Artifact:** [`results/2026-08-14-batch-dispatch-default.json`](results/2026-08-14-batch-dispatch-default.json)  
**Environment:** PostgreSQL 18.4, Node.js 24.15.0, Linux 7.0, AMD Ryzen 7 8745HS

## Verdict

Keep batch dispatch as a lifecycle and provider-efficiency feature. This run found no claim-cost or lease-safety regression.

One local run does not support a general throughput claim.

The full-group comparison used the same 24-job ready backlog and eight worker slots for serial and batched handlers. Every member entered through one `claim_v3` transition and occupied one slot.

## Recorded observations

The serial cohort completed 248.8 jobs per second. The batched cohort completed 279.3 jobs per second, 12.3% higher in this run.

| Measure                   | Serial handler | Batch handler |
| ------------------------- | -------------: | ------------: |
| Claim p95                 |       4.126 ms |      3.569 ms |
| Completed jobs per second |          248.8 |         279.3 |
| Claim calls               |             24 |            24 |

Claims remained serial, and every claim had a free worker slot. Both cohorts ended with no ready, active, or expired work.

The full-group cohort dispatched three groups of eight. A separate seven-job comparison forced one partial group through the configured linger.

The serial partial cohort completed 191.4 jobs per second. The batched partial cohort completed 168.6 jobs per second, 11.9% lower in this run.

The combined client-observed p95 from the first successful member claim to handler dispatch was 21.962 ms. This included the partial group's linger.

The serial and batch mixed cohorts each settled 23 successful members and one terminal failure. The failure did not change its successful peers.

The concurrency-only phase admitted two members and left seven ready. The rate-only phase consumed two initial tokens and reported seven throttled members.

The claim-plan phase kept 24 live runtime rows while retained identity grew to 120 jobs. Shared buffer work changed from 407 blocks to 156.

Execution time changed from 3.069 ms to 1.655 ms. Retained terminal history did not increase claim work at fixed live depth in this run.

OpenTelemetry exported six batch size and linger series. Each used only queue name, job type, and the bounded full-or-partial flag.

The recovery phase expired one member after admission. PostgreSQL recovered exactly that member, and its next claim received a higher fence.

PostgreSQL rejected the old handler completion. The peer completed through its original fence, and health reported no active or expired lease afterward.

## Product contract

Batching does not combine durable admission or settlement. Every member consumes one worker slot, one concurrency count, and one rate token when those policies apply.

The throughput values compare one default-profile run on one host. Full groups were faster while the partial group was slower.

These results support no production latency, throughput, or optimal batch-size claim.
