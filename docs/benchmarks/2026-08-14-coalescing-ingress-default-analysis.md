# Coalescing ingress default-profile analysis

**Recorded:** 2026-08-14

**Artifact:** [`results/2026-08-14-coalescing-ingress-default.json`](results/2026-08-14-coalescing-ingress-default.json)

**Environment:** PostgreSQL 18.4, Node.js 24.15.0, Linux 7.0, AMD Ryzen 7 8745HS

The run used a local bare-metal host and a systemd-managed PostgreSQL process, with no VM or container. The database and workspace used local NVMe-backed ext4 storage.

`pnpm db:reset:bench` installed a fresh schema immediately before the run. PostgreSQL reported no concurrent active clients, held snapshots, or replication slots. Ordinary host workloads were not isolated.

## Verdict

Keep idempotency, debounce, and throttle as distinct acceptance contracts. This run found consistent durable state, bounded notification effects, and complete cleanup under concurrent requests.

One local run does not establish production latency or make handler effects exactly once.

## Recorded observations

Each cohort raced 32 requests across eight keys. PostgreSQL accepted one request per key, and the other three replayed, replaced, or coalesced that identity.

| Cohort            | Enqueue p50 | Enqueue p95 | Key indexes | Notifications |    Purge |
| ----------------- | ----------: | ----------: | ----------: | ------------: | -------: |
| Idempotency       |   24.365 ms |   26.940 ms |      32 KiB |             8 | 5.582 ms |
| Debounce reset    |   15.228 ms |   20.785 ms |      32 KiB |             0 | 3.950 ms |
| Debounce preserve |   10.990 ms |   15.659 ms |      32 KiB |             0 | 4.321 ms |
| Throttle          |   10.090 ms |   13.473 ms |      32 KiB |             8 | 3.270 ms |

Every cohort retained eight jobs, eight live runtimes, eight scoped keys, and eight `enqueued` events before cleanup. Every result for one key returned its accepted identity.

The idempotency cohort returned 24 `replayed` outcomes. The throttle cohort returned 24 `coalesced` outcomes without adding an event, FIFO placement, or notification.

Each debounce cohort returned 24 `replaced` outcomes and appended 24 `debounced` events. Reset scheduling moved the retained run time forward, while preserve scheduling left the original run time unchanged.

For each debounce key, every event's stored digest matched the preceding request digest. The final event digest matched the retained request fingerprint.

Debounced jobs remained scheduled, so they produced no ready notification or FIFO sequence. Idempotency and throttle each created eight ready jobs and produced eight notifications, one for each accepted key.

All four cohorts used the same `enqueue_idempotency` indexes, which occupied 32 KiB at this scale. That page-level result does not predict growth at larger key counts.

`purgeQueue` removed every pending job and retained key. Client-observed cleanup took 3.270–5.582 ms across the four cohorts.

## Product contract

Idempotency replays an equivalent request and rejects a material conflict. Debounce changes one pending definition and explicitly resets or preserves its schedule. Throttle reuses one accepted identity without changing it.

These mechanisms serialize acceptance in PostgreSQL. A handler can still repeat after lease loss or process failure, so callers must make external effects idempotent.

The timings compare one default-profile run on one host. They support no production latency, throughput, or preferred-mode claim.
