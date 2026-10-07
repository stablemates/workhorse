# LangGraph approval bridge

This page is the precise reference for [`langgraph_approval.py`](langgraph_approval.py).
It sits next to that example because a defect in the recipe is not a Workhorse defect.
The [LangGraph page](https://workhorse.run/docs/langgraph) explains the recipe for a new reader.

The Python example coordinates one persistent draft, approval, and local tool action.
Workhorse owns admission, leases, retries, and the committed human wait.
LangGraph owns graph state, node replay, and the interrupt.
This is an application recipe, not a Workhorse checkpointer or an SDK adapter.

## Verified interface

[`python/examples/langgraph_approval.py`](langgraph_approval.py) uses these released development dependencies:

- `langgraph==1.2.12`, upstream tag `1.2.12` at `49cce0ca852be4cfb567a1cbe0e511ff325a1682`.
- `langgraph-checkpoint-postgres==3.1.2`, tag `checkpointpostgres==3.1.2` at
  `fde3068970679184b68d3d068a92c83c966a4888`.
- `langgraph-checkpoint==4.2.0`, resolved in `python/uv.lock`.

The recipe uses `StateGraph.compile(checkpointer=...)`, `PostgresSaver.setup()`, `interrupt`,
`StateSnapshot.interrupts`, `Interrupt.id`, and `Command(resume={interrupt_id: decision})`.
Every invocation uses `durability="sync"`.
`get_state(config)` reads the persistent graph before recovery chooses an invocation.
`update_state(config, {"outcome": reason})` stops a pending tool through LangGraph's own persistence API.

`install(database_url)` installs the application's tables and calls `PostgresSaver.setup()` separately
from Workhorse's schema migration.
Its session lock serializes setup.
Run setup before admitting tasks; do not grant schema creation to approval request handlers.

## Application storage

`langgraph_example.bridge` has these columns:

| Column             | Ownership and meaning                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `task_id`          | Primary key: the immutable Workhorse task UUID.                                                                 |
| `thread_id`        | Unique `workhorse:{task_id}` identity passed in `configurable.thread_id`.                                       |
| `version`          | Application graph definition, currently `draft-approval-local-note-v1`.                                         |
| `phase`            | `preparing`, `interrupted`, `resuming`, or `finished`; a reconciliation receipt, not graph execution authority. |
| `interrupt_id`     | Actual persisted `Interrupt.id`, never a newly generated approval identity.                                     |
| `approval_context` | The original interrupt's JSON context: `task_id`, `draft`, and allowlisted `tool`.                              |
| `resume_id`        | SHA-256 of thread identity, interrupt identity, and definition version.                                         |
| `decision`         | First accepted `{"approved": boolean}` response; conflicting reuse fails closed.                                |
| `stop_reason`      | Explicit terminal reconciliation reason, retained separately from the user's decision.                          |
| `outcome`          | Graph-reconciled `approved`, `rejected`, `cancelled`, `timed_out`, or `failed`.                                 |

`langgraph_example.tool_effect` stores `effect_id`, `task_id`, and `result`.
`effect_id` is the bridge's `resume_id`; `task_id` references the bridge.
The only tool inserts a deterministic local note.
A replay verifies the existing task identity and result instead of silently accepting a collision.

The graph checkpointer owns its tables under `langgraph_example_graph`, including `checkpoints`,
`checkpoint_blobs`, `checkpoint_writes`, and `checkpoint_migrations`.
The bridge never copies graph channel values or checkpoint blobs into Workhorse.
`langgraph-interrupt-receipt` and `langgraph-resume-receipt` contain only thread, interrupt,
resume identity, retained approval context, and terminal outcome.
They do not wrap the graph invocation in `HandlerContext.checkpoint`.

## Driver authority

Queue concurrency alone cannot prevent an obsolete handler from running after its lease expires.
The application therefore owns a separate graph-driver lock.

`driver()` opens one direct, autocommit Psycopg connection with `dict_row` and `prepare_threshold=0`.
It calls `pg_try_advisory_lock(lock_key(thread_id))` before constructing the graph.
`lock_key` takes the signed first eight bytes of SHA-256.
A collision reduces concurrency; it cannot admit two drivers for one identity.
If another session owns the lock, `DriverBusy` fails the attempt without invoking the graph.
The example's bounded retry policy determines whether another attempt can recover.

The lock, `PostgresSaver`, bridge writes, and local tool all use **that same connection**.
There is no checkpointer pool, automatic reconnection, separate effect connection, or external tool.
If PostgreSQL terminates that session, its lock disappears and every old graph/effect writer fails.
A separate lock connection would not establish this guarantee.
Transaction pooling and reconnecting proxies are outside this recipe.

Under the lock, the handler calls `HandlerContext.set_progress` before graph entry and each node.
It writes the same `langgraph_thread` value each time.
Workhorse still checks the live fence for an unchanged report.
A checkpoint replay or cancellation-token check alone would not establish fresh ownership.
The recipe releases the lock before `wait_for_human` suspends the handler.
When the handler resumes, it reacquires the lock and revalidates its fence.

This does not atomically fence an arbitrary external action with a Workhorse lease.
Cancellation can arrive after a node's ownership check.
A committed effect cannot be undone, and a noncooperative computation may still unwind after lease loss.
The successor cannot concurrently drive this graph while the old session retains the lock.
After that session closes, an obsolete context cannot regain authority through a cached receipt.

## Commit and recovery boundaries

The graph first persists its interrupt.
The bridge then retains its identity and context.
`wait_for_human("langgraph-approval", context, timeout_ms=...)` commits Workhorse's wait before
an approval response can make its task runnable.
The handler observes that committed response before calling `Command(resume=...)`.
An approval request owns its transaction and must commit it.

| Window                                              | Recovery                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph saved, bridge still `preparing`               | Read the existing graph and persist its original interrupt identity/context. Never invoke existing graph state with fresh input.                   |
| Bridge `preparing`, no graph checkpoint             | `prepare()` invokes the graph from the start. `stop()` stores the stop outcome through `update_state(..., as_node="approval")`.                    |
| Decision saved, graph not resumed                   | Retain the decision and address the same interrupt with the same resume identity.                                                                  |
| Local tool committed, graph tool checkpoint missing | Resume pending graph work with `invoke(None, config)`; the deterministic effect ledger validates and reuses the note.                              |
| Graph resumed, bridge save missing                  | Read the terminal graph and repair the bridge phase/outcome without resuming the approval again.                                                   |
| Bridge finished, Workhorse receipt missing          | Reconcile the graph and save the receipt under the new Workhorse fence.                                                                            |
| Duplicate or concurrent resume                      | Equal decisions replay the same result; conflicting decisions fail. A second driver session fails before graph invocation.                         |
| Lease lost while tool node is paused                | The new attempt cannot take the application lock. The old node's next fenced write fails; a later authorized attempt resumes persisted graph work. |
| Lock session terminated                             | A successor can acquire the lock; the old checkpointer and local tool cannot write through their disconnected connection.                          |

`prepare()` and `stop()` refuse a missing graph when the bridge already retains an interrupt or later phase.
`row()` refuses a mismatched application version.
Neither condition authorizes starting another graph to conceal lost history.

## Timeout and cancellation

The handler's default approval timeout is 60,000 milliseconds.
Workhorse bounds a human wait to 604,800,000 milliseconds and may apply an earlier task deadline.
A suspended task can become terminal without running its handler again.
That transition does not automatically change LangGraph.

The application's terminal observer must call `reconcile_terminal(database_url, task_id)`
after Workhorse records `canceled` or `failed`.
The example exposes this function; it installs no observer service or scheduler.
Without that application observer, a stopped Workhorse task can leave a retained graph interrupt.
`DeadlineExceeded` maps to `timed_out`; another failure maps to `failed`.
The observer verifies retained terminal task state under the same graph-driver lock.
It resumes a pending interrupt with a stop response or stops pending graph work through `update_state`.
It retains approval context and the original decision.
If the graph already completed, reconciliation preserves its outcome rather than undoing a tool effect.

## Retention, compatibility, and trust

Keep Workhorse task/wait history, bridge receipts, graph history, and the local ledger until
the application's recovery and approval audit windows have ended.
Workhorse retention does not delete graph or bridge rows.
LangGraph deletion does not delete Workhorse history or the effect ledger.
The application owns coordinated cleanup, backups, and restoration; this recipe implements no retention service.
Do not purge an active thread or reuse its task, interrupt, or effect identity.
If terminal Workhorse history is gone, the observer fails closed instead of guessing authority.

Before changing dependencies, serializer, graph nodes, edges, or interrupt placement, test retained
threads against the new definition and plan an application migration.
`PostgresSaver.setup()` handles its own migrations, not the bridge's definition compatibility.
Keep the example's exact development pins for the demonstrated recipe.
It makes no compatibility claim for another graph, SDK, async saver, or provider.

The graph generates no paid model request and accepts no prompt-selected tool.
`normalize_decision` accepts exactly one boolean and rejects tool names or extra fields.
The application must authenticate reviewers and authorize their task access before completing the human wait.
`requested_by` records an actor; it is not authentication.
Keep database credentials server-side and restrict direct graph, bridge, ledger, and Workhorse writes.
Approval context is retained data visible to authorized operators, not a place for secrets.
Treat prompts, drafts, model output, and tool results as untrusted data.
The serializer disables pickle fallback and JSON/MessagePack module reconstruction.
The driver disables LangSmith tracing rather than exporting approval context through ambient tracing settings.

## Evidence

[`python/tests/test_langgraph_approval.py`](../tests/test_langgraph_approval.py) uses the existing `database_url` scratch-database fixture.
Each database test creates and drops its own local PostgreSQL database.
The tests exercise the real saver, real Workhorse worker, committed waits, crash boundaries,
stale fences, session loss, cancellation, timeout, schema mismatch, and retained-context recovery.
The existing `pnpm python:test` CI lane collects this file once; no duplicate integration lane is added.
The catalog tier is `documented`: this is a tested recipe, not a published adapter or live-provider proof.

Official interface references:
[persistence](https://docs.langchain.com/oss/python/langgraph/persistence),
[interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), and
[PostgreSQL checkpointer](https://pypi.org/project/langgraph-checkpoint-postgres/3.1.2/).
