# ADR 0124: Keep the lock order cases that end one transaction with a deadlock

- **Status:** Accepted
- **Date:** 2026-11-15
- **Issues:** SM-2050. SM-2004 and SM-2006 (migration 0103) found the cases.
- **Related:** [ADR 0101](0101-cancel-a-purged-prerequisite-whose-dependent-stays.md)

## Context

If two transactions lock the same two objects in opposite orders, PostgreSQL ends one of them with
SQLSTATE `40P01`. That transaction rolls back completely, so the caller can run it again.

Migration 0103 (schema version 102) makes each enqueue call take its key locks, then its tier
locks, then its row locks. A tier lock is the lock of `lock_queue_tiers_v1` on a queue. At read
committed it is only a shared advisory lock, and it takes no row lock. Outside read committed it
also inserts the `queue_control` row of each new queue and locks the row `FOR SHARE`. A second
transaction that inserts the same row waits for the first.

Some calls still take their locks in another order. SM-2050 lists nine such cases. ADR 0101 already
keeps one limit of this type: a cancel against an enqueue (SM-1286).

Three facts of the code decide most of the cases:

1. Each claim entry point raises SQLSTATE `0A000` unless the isolation is read committed. A worker
   sends each terminal transition, each child create, and its maintenance as single statements on
   the same connections. Thus a worker runs them at read committed.
2. A fast-tier queue cannot hold a member of a task group, so each group member gets its lease from
   a claim at read committed.
3. No SDK calls `enqueue_debounce_v1` or `enqueue_throttle_v1` directly. `enqueue_many_v1` calls
   them after it takes its key locks and its tier locks.

## Decision

**All nine cases stay.** Each case is in one of two classes. In each case, PostgreSQL ends one
transaction with `40P01`. That transaction commits no task change. The other transaction can
commit.

### Class A: the case needs a transaction outside read committed

Cases 2, 3, 4, 5, 6, and 7 are in class A. Only outside read committed does a tier lock take a row
lock, so only there can these cycles form.

1. No worker reaches a class A case. Workers claim, settle, and run maintenance at read committed.
2. A caller that selects repeatable read or serializable must already run its transaction again.
   At those levels PostgreSQL and Workhorse answer `40001`, for example when a tier change or a
   second enqueue changes the `queue_control` row after the snapshot. `40P01` asks for the same
   action, so it adds no new duty for that caller.
3. A fix without a new lock at read committed is possible for cases 3, 4, 5, and 6. Each fix
   changes the lock order outside read committed only, as migration 0103 did for
   `cancel_task_group_v1`. The fix of case 4 is the smallest. These fixes are not done, because
   each one replaces the body of functions that each read committed call uses. The gain is for a
   caller that must run its transaction again in any case.
4. For case 2, no fix inside one call is known. The cycle spans two calls of one transaction.

### Class B: the case can occur at read committed

Cases 1, 8, and 9 are in class B.

1. Each case needs a purge, a group cancel, or a batch that names two related prerequisites. The
   second transaction is one of these calls or a terminal transition of the prerequisite, such as
   a cancel.
2. A fix must lock in dependency order. That needs a read of the dependency graph on each enqueue
   or in each purge or group cancel. ADR 0101 keeps the same limit for the same reason.
3. The caller or the operator runs the transaction that ended with `40P01` again.

### The cases

Each case states its cycle, its class, and its evidence.

#### Case 1: a purge against a batch with a debounce member

A batch locks a debounced task P before its blocked dependent D. A purge locks the tasks of its
queue in identity order. If D sorts below P, and the purge waits for a row between them, each
transaction waits for the other. A purge against a `cancel_v1` of P has the same order, as case 9
states.

- Class: B.
- Evidence: a test, `integration-enqueue-contracts.test.ts`, "ends one transaction with a deadlock
  when a purge holds the dependent before the debounced task".
- Fix: the purge locks prerequisites before dependents. That changes the purge order and needs a
  measurement on a large queue.

#### Case 2: two calls of one transaction

A transaction inserts the `queue_control` row of a new queue in one call. It takes an enqueue key in
a later call. A second transaction holds that key and waits for the row.

- Class: A.
- Evidence: a test, `integration-enqueue-lock-order.test.ts`, "ends one transaction with a deadlock
  when two calls of one transaction take the row before the key".
- Fix: no lock order inside one call can close a cycle that spans two calls. No fix is known.

#### Case 3: a group cancel against the completion of the last member

A `cancel_task_group_v1` inserts the `queue_control` row of a callback queue and then waits for a
member. The completion holds that member. At commit, it enqueues the callback and waits for the row.

- Class: A. The cycle needs the cancel and the completion both outside read committed. If the
  completion runs at read committed, its callback enqueue takes no row lock, and the completion does
  not wait. The cancel then ends with `40001`, as before migration 0103. A worker completes at read
  committed, so a worker never reaches this case.
- Evidence: two tests in `integration-enqueue-lock-order.test.ts`. With both transactions at
  repeatable read, one transaction ends with `40P01`. With the completion at read committed, the
  cancel ends with `40001`.
- Fix: outside read committed only, each terminal transition reads its group and locks the tiers of
  the callback queues before its row lock.

#### Case 4: a direct call of `enqueue_debounce_v1` or `enqueue_throttle_v1`

Each function takes the tier lock before the key lock. No SDK calls these functions directly.

- Class: A.
- Evidence: a read of the code.
- Fix: outside read committed only, take the key lock first. Read committed runs no new statement.
  **This fix is the smallest of the nine.**

#### Case 5: other terminal transitions

`complete_v1`, `fail_v2`, `cancel_v1`, `acknowledge_cancel_v1`, lease expiry, and the deadline of
the last member lock the member row. Their resolver also locks each blocked dependent of the
member. At commit, they enqueue the callback of the group. The case needs a callback queue that has
no `queue_control` row. A purge of that queue inserts the row first. Then it locks the `blocked`, `ready`, and `scheduled` tasks of the queue.
If one of them is a task that the transition holds, each transaction waits for the other. That task
is a dependent of the member in the callback queue, or the member itself if it is not `active`.

- Class: A. The case needs a caller that runs a transition in its own transaction outside read
  committed.
- Evidence: a test, `integration-enqueue-lock-order.test.ts`, "ends one transaction with a deadlock
  when a repeatable read completion of the last member meets a purge of the callback queue". The
  member is `active`, and its dependent is in the callback queue. The other transitions come from a
  read of the code.
- Fix: as case 3.

#### Case 6: child task creates

`create_single_child_v2`, `create_children_v1`, and `create_children_v2` lock the parent row and the
child edge. Then they take the tier lock of the child queue. An enqueue to the child queue that
names the parent as a prerequisite takes that tier lock first, and then it locks the parent. If the
child queue has no `queue_control` row and both run outside read committed, each transaction
waits for the other. A purge of the child queue does
not form this cycle, because a purge never locks the `active` parent.

- Class: A. A worker sends each child create at read committed.
- Evidence: a test, `integration-enqueue-lock-order.test.ts`, "ends one transaction with a deadlock
  when a repeatable read child create meets a repeatable read enqueue that names the parent".
- Fix: the request names the child queue before the parent lock. Outside read committed only, take
  the tier lock of the child queue before the parent row.

#### Case 7: the cancels of a purge

A purge cancels tasks after its row locks. A cancel can finish a group and enqueue its callback to
another queue, and that enqueue takes a tier lock.

- Class: A. The case needs a purge outside read committed.
- Evidence: a read of the code.
- Fix: the purge locks the callback queues of the affected groups before its row locks, or it
  refuses to run outside read committed. A refusal breaks a caller that purges in its own
  transaction.

#### Case 8: a plain batch with two related prerequisites

A batch without a debounce member names the prerequisites D1 and D2. D1 depends on D2, and D1 sorts
below D2. A cancel of D2 that rejects D1 can deadlock with the batch. This is the limit that ADR
0101 keeps (SM-1286).

- Class: B.
- Evidence: a test, `integration-cancel-enqueue-deadlock.test.ts`, "can deadlock when the dependent
  sorts first, and PostgreSQL aborts one with 40P01".
- Fix: the batch locks prerequisites in dependency order, so it reads the dependency graph on each
  enqueue.

#### Case 9: `cancel_task_group_v1` and a purge against a resolver

A group cancel and a purge both lock their tasks in identity order. A blocked dependent D and its
prerequisite P can both be in the set, with D below P. A cancel of P in another transaction locks P
first, and its resolver then waits for D.

- Class: B.
- Evidence: two tests in `integration-enqueue-lock-order.test.ts`, one for a purge and one for a
  group cancel. Each ends one transaction with `40P01` at read committed. The ADR 0101 amendment of
  2026-11-15 records the purge part.
- Fix: the purge and the group cancel lock prerequisites before dependents, as in case 1.

## When to decide again

Decide again if one of these events occurs:

1. A user reports a class B case in normal operation.
2. A fix for a class B case needs no read of the dependency graph on the enqueue path.
3. A supported SDK path starts to run a class A case outside read committed.

## Consequences

- A caller that gets `40P01` from one of these cases runs its transaction again. Nothing of the
  rolled-back transaction commits.
- A read committed enqueue takes no new lock and runs no new statement.
- The completion of the last member can also run outside read committed. Then a group cancel
  outside read committed can get `40P01`. Before migration 0103 it got `40001`.
- Nine tests pin cases 1, 2, 3, 5, 6, 8, and 9. A change that closes or moves one of these cases makes a
  test fail. That change must update this record.

Rejected options:

- Fix the class A cases now. Each fix replaces the body of functions that each read committed call
  uses, for a caller that must run its transaction again in any case.
- Fix the class B cases now. Each fix reads the dependency graph on each enqueue or in each purge.
- Refuse each call outside read committed that can meet a class A case. An application can enqueue
  in its own transaction at any level, and such a refusal breaks it.

[Task lifecycle: Isolation requirement](../architecture/lifecycle.md#isolation-requirement) owns
the class A cases and case 9.
[Task lifecycle: Keyed debounce](../architecture/lifecycle.md#keyed-debounce) owns case 1.
[Data model: Resolver lock order](../architecture/data-model.md#resolver-lock-order) owns case 8,
and [Data model: Queue purge](../architecture/data-model.md#queue-purge) states the purge part of
case 9.
