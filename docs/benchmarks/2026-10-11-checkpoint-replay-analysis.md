# Checkpoint replay

A handler restarts from the top after a retry, a crash, or a durable wait. On each pass it reads
the stored checkpoints of its task again. Workhorse has no limit on checkpoints per task, so the
replay work grows with the length of a long task. This note measures that growth for SM-1209.

The replay cost per pass grows linearly with the number of checkpoints. A pass without checkpoints
took about 14 ms. Replay took 44 percent of the pass at 1,000 checkpoints, 73 percent at 3,000,
and 90 percent of a 123 ms pass at 10,000. PostgreSQL execution was a small part of that time: the
list query executed in 6.9 ms, but the worker waited 68 ms for its rows. The cost of a save did
not grow with the number of checkpoints, so the first pass grows linearly too.

## Method

The `checkpoint-replay` lifecycle scenario in `typescript/core/benchmarks/scenarios.ts` runs one
full-tier task for each checkpoint count. Its handler does these steps on each pass:

1. It calls `context.checkpoint` for `step-0` to `step-<N-1>` in sequence. Each value is
   `{ step, result }`, with a 100-character string, and PostgreSQL stores it in 144 bytes.
2. It calls `context.sleep` with a new wait name and a 20 ms duration, and the task suspends.

The scenario wakes the task with `promote`, outside the timed pass, and runs the next pass with
`worker.runOnce()`. The first pass saves every checkpoint. Each of the next five passes replays
them, and the last pass completes the task. A real handler calls every earlier wait again on each
pass. This handler schedules only the new wait, so each replay pass has the same fixed statements
and the checkpoint count is the only variable.

The worker loads all checkpoints of a task with one `list_checkpoints` query the first time a
handler pass asks for one. Then it answers each `context.checkpoint` call from that map. A probe
times every statement that the worker sends and assigns it to its pass. The scenario records:

| Measurement         | Source                                                                             |
| ------------------- | ---------------------------------------------------------------------------------- |
| Pass time           | `worker.runOnce()` from claim to suspension or completion                          |
| Save time           | each `save_checkpoint_v1` statement as the worker observes it                      |
| List time           | the `list_checkpoints` statement as the worker observes it, rows decoded           |
| List execution time | `EXPLAIN (ANALYZE, BUFFERS)` of `list_checkpoints`, median of 3, after the task    |
| Statement time      | the sum of every statement in the pass as the worker observes it                   |
| Handler replay time | from handler entry until the last `context.checkpoint` call returns, list included |
| Replay share        | handler replay time divided by pass time                                           |

The invariants make each run fail if the behavior is not the expected behavior. Each task must
succeed in one logical attempt. The save pass must run each checkpoint operation once and store one
row and one `checkpoint_saved` event for each checkpoint. Each replay pass must send exactly one
`list_checkpoints` query that returns every checkpoint, and no save. Each replayed value must equal
the saved value. The scenario checks the values after each timed pass. At count 0 the handler asks
for no checkpoint, so no list query runs, and that count gives the fixed cost of a pass.

### Environment

Three sequential invocations ran this command against the `bench` database of the SM-1209
worktree:

```sh
pnpm benchmark -- --suite lifecycle --profile full --scenario checkpoint-replay
```

The `full` profile measures 0, 10, 100, 300, 1,000, 3,000, and 10,000 checkpoints with 5 replay
passes each.

| Item       | Value                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| PostgreSQL | 18.6, `shared_buffers` 5 GB, `work_mem` 4 MB, `synchronous_commit` on   |
| Host       | AMD Ryzen 9 9955HX, 32 logical CPUs, 92 GiB memory, Linux 7.0.0         |
| Worker     | Node.js 24.21.0, TypeScript worker, one task at a time                  |
| Load       | one-minute load average 39 to 84, from other checkouts on the same host |
| Source     | commit `f7552f68`, this change before its final rebase onto `main`      |

The PostgreSQL server was shared with other worktrees, and the host was heavily loaded during all
three invocations. Treat each absolute time as an observation of this host only. The shape of the
growth was the same in all three invocations. The complete machine-readable result is
[`2026-10-11-checkpoint-replay.json`](results/2026-10-11-checkpoint-replay.json).

## Results

Each value is the median over the replay passes of one invocation, then the median of the three
invocations. Pass time also shows the range of the three invocations.

| Checkpoints | Replay pass p50        | Statement time | List time | List execution | Handler replay | Replay share |
| ----------: | :--------------------- | -------------: | --------: | -------------: | -------------: | -----------: |
|           0 | 14.3 ms (7.2–17.4)     |        13.4 ms |         — |              — |        0.00 ms |         0.00 |
|          10 | 16.0 ms (10.1–17.2)    |        15.4 ms |   1.04 ms |       0.027 ms |        3.50 ms |         0.21 |
|         100 | 17.1 ms (11.2–22.2)    |        16.5 ms |   2.57 ms |       0.075 ms |        4.60 ms |         0.37 |
|         300 | 15.0 ms (13.1–19.1)    |        14.5 ms |   1.70 ms |       0.194 ms |        2.34 ms |         0.18 |
|       1,000 | 27.5 ms (24.1–30.4)    |        25.3 ms |   5.10 ms |       0.586 ms |        12.0 ms |         0.44 |
|       3,000 | 43.1 ms (41.4–45.2)    |        36.6 ms |   22.3 ms |        1.75 ms |        29.7 ms |         0.73 |
|      10,000 | 123.2 ms (103.2–137.1) |        95.0 ms |   68.4 ms |        6.92 ms |        94.0 ms |         0.90 |

The save pass measured these values:

| Checkpoints | Save p50 | Save pass              | Stored value bytes |
| ----------: | -------: | :--------------------- | -----------------: |
|          10 |  3.18 ms | 64 ms                  |              1,438 |
|         100 |  3.95 ms | 0.49 s                 |             14,398 |
|         300 |  3.95 ms | 1.27 s                 |             43,198 |
|       1,000 |  3.95 ms | 4.13 s                 |            143,998 |
|       3,000 |  3.82 ms | 12.5 s                 |            431,998 |
|      10,000 |  3.95 ms | 45.8 s (38.0 s–50.8 s) |          1,439,998 |

### The knee

Replay share passes one half between 1,000 and 3,000 checkpoints. The first count at which the
median share of an invocation reached one half was 1,000, 3,000, and 3,000. Below 1,000
checkpoints, the fixed statements of a pass take most of its time: `claim_many_v1`, the queue tier
read, and `schedule_wait_v1`, or the completion on the last pass. Below 1,000 checkpoints the share
also did not grow steadily, because the host load moved these small times more than the count did.
Above 1,000 checkpoints, the pass time grows by about 11 µs for each checkpoint.

### Where the replay time goes

Statement time is the time the worker waits for PostgreSQL, as the worker observes it. List
execution is the time PostgreSQL needs to execute the list query, from a separate `EXPLAIN` run.
The two series measure different things.

PostgreSQL executed the list query in 3 to 12 percent of the list time, and in 10 percent at
10,000 checkpoints. The query reads the task's rows and sorts them by `created_at` and name, at
about 0.7 µs for each row. The remaining list time includes planning, the transfer of the rows, the
driver's decode of the rows, and the pool. This benchmark does not separate those parts.

Handler replay time also includes the build of the checkpoint map and the `context.checkpoint`
loop: about 26 ms at 10,000 checkpoints. That work runs in the worker, not in PostgreSQL. At
10,000 checkpoints, statements took 95 ms of the 123 ms pass, and the worker used the rest.

### The save pass

Each save is its own transaction, which locks the task's runtime row and commits. The median save
of each count was between 3.2 and 4.0 ms, so the save pass grows linearly: 10,000 checkpoints took
46 s at the median. On this host the commit, not the number of earlier checkpoints, set the cost.
One invocation saved its 100 checkpoints at 0.68 ms each, which shows how much the commit cost
moved with the host load. Each save also appended one `checkpoint_saved` event, so a task with
10,000 checkpoints writes 10,000 history rows.

## What this means for long tasks

The total replay work of a task is its number of passes multiplied by its number of checkpoints.
On this host, a task with 1,000 checkpoints spent about 12 ms of each pass on replay. A task with
10,000 checkpoints read 1.4 MB of stored values and spent about 94 ms on each pass before its own
work. Thus a task with some thousands of checkpoints and few passes pays a small replay cost. A
task that suspends often with 10,000 checkpoints spends most of each pass in replay. This note
measured no count above 10,000, and Workhorse has no limit that stops a task above it.

## What this does not measure

- It uses one 144-byte value. A value can have up to 1 MiB, and larger values increase the list
  time.
- It runs one task at a time. It does not measure concurrent replays, which share the server and
  the worker's event loop.
- It uses only the TypeScript worker. The other SDKs load checkpoints with their own code.
- It does not include the calls that a real handler makes again for its earlier waits. Each such
  call is one more `schedule_wait_v1` statement.
- It does not measure retention of the checkpoint rows and events, or the history-partition cost
  of 10,000 `checkpoint_saved` events.
- It ran on a shared, loaded server, not on a dedicated container.
