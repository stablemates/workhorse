# Dependency operations smoke evidence

The `dependency-operations` scenario passed every lifecycle and cost invariant on PostgreSQL 18.4.
It exercised six-way fan-in, cancellation policy resolution, dependency health, and claim plans
before and after adding retained terminal history.

Fan-in resolution took 23.8 ms for the cohort, recorded one release event, and cancellation
resolution took 2.0 ms. The claim plan touched 154 shared buffers before history and 191 afterward
while retained identity grew to 1,011 rows. The history-to-live-work ratio is production-shaped,
but this smoke run does not establish a production throughput ceiling.

The health snapshot reported no blocked dependencies after both cohorts settled. The scenario did
not create a policy-selected failure, so `dependencyFailedResolutions` remained zero; integration
coverage separately verifies that counter with a retained `DependencyFailed` outcome.

Canonical report:
[`results/2026-08-14-dependency-operations-smoke.json`](results/2026-08-14-dependency-operations-smoke.json).
