# Priority dispatch default-profile analysis

**Recorded:** 2026-08-14  
**Artifact:** [`results/2026-08-14-priority-dispatch-default.json`](results/2026-08-14-priority-dispatch-default.json)  
**Environment:** PostgreSQL 18.4, Node.js 24.15.0, Linux 7.0, AMD Ryzen 7 8745HS

## Verdict

Keep strict priority and document starvation as supported behavior. This run found no claim-cost reason to add aging, while aging would weaken the ordering contract.

The mixed cohort preserved descending priority and FIFO order among peers. Replenished priority-100 work won all 120 flood claims. The priority-0 job stayed ready for the full 429 ms flood and ran only after urgent arrivals stopped.

## Recorded observations

The default profile used 120 jobs per measured cohort and four concurrent claimers. Each handler interval overlapped claim work before completion.

The mixed cohort assigned 80% ordinary, 15% elevated, and 5% urgent priority.

The history phase retained 480 terminal identities beside 120 live ready rows.

The FIFO and mixed cohorts each used 32 KiB of ready-index storage before claims began.

| Measure                   | FIFO baseline | Mixed priority |
| ------------------------- | ------------: | -------------: |
| Claim p50                 |      1.343 ms |       1.351 ms |
| Claim p95                 |      2.117 ms |       1.878 ms |
| Completed jobs per second |        1059.8 |         1123.7 |

Mixed throughput was 6.0% above FIFO in this single run. Claim p95 was 11.3% lower. One default-profile run does not support a priority-performance claim.

The measured `claim_v3` transition touched 239 shared blocks before terminal history grew. It touched 202 shared blocks after retained identities increased fivefold.

The corresponding execution time changed from 1.607 ms to 1.094 ms. These are full claim-transition observations, including state and event writes.

The ready index grew from 32 KiB to 112 KiB after churn, even after `VACUUM (ANALYZE)`. PostgreSQL removed terminal jobs from `job_runtime`, but B-tree storage retained allocated pages.

The run held `job_runtime` at 120 rows while retained `job` identities reached 600. Actual claim buffer work did not follow that fivefold history increase.

The index-size result means sustained churn can still increase allocated storage.

## Product contract

Workhorse does not age waiting jobs or reserve capacity by priority. Operators must use separate queues when lower-priority work needs guaranteed capacity.

This artifact records one default-profile run on one host. It supports ordering, starvation, and fixed-ready-depth claim-buffer claims, but no general latency or throughput claim.
