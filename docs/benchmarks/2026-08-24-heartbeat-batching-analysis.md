# Heartbeat batching at worker concurrency 100

The worker-level batch reduced heartbeat traffic from 100 statements per interval to one. With the default interval derived from the benchmark lease, that is 10 statements per second before batching and 0.1 after batching.

The focused smoke run used PostgreSQL 18.4 on the local benchmark database. Renewing 100 leases through individual calls took 20.74 ms, while one `heartbeat_many_v1` call took 2.92 ms. PostgreSQL reported 500 HOT updates across the measured heartbeat samples, confirming that lease renewal no longer writes active-runtime index entries.

These timings compare one local run and are evidence for statement reduction, not a general throughput claim. The machine, PostgreSQL settings, command, dirty source provenance, assertions, and raw measurements are recorded in [the benchmark result](results/2026-08-24-wh-382-heartbeats.json).
