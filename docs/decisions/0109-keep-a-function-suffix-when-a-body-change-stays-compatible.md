# ADR 0109: Keep a function suffix when a body change stays compatible

- **Status:** Accepted
- **Date:** 2026-10-23
- **Amends:** [ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md)
- **Related:** [ADR 0057](0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)
- **Issue:** SM-1665 (SQL-09)

## Context

ADR 0053 makes every migration inside a major line additive. A migration may not change the
meaning of anything that a supported release reads or writes. The `_vN` suffix is how a function
is superseded: a migration adds `claim_v2` and keeps `claim_v1`.

The migrations do not follow that rule word for word. Most of them replace the body of an existing
`_vN` function with `CREATE OR REPLACE FUNCTION` and keep the suffix. Some of these changes also
change an outcome. For example, migration 0075 lets `enqueue_throttle_v1` accept throttle on a
fast-tier queue, which the earlier body rejected with `P1007`. A project review of 2026-10-22
found that no document states when such a change is permitted.

Every client calls a function by its name and suffix. A body change therefore reaches every
running client when its migration commits, and a client of an earlier release cannot opt out.

## Decision

**A migration can replace the body of a `_vN` function and keep the suffix when all of these stay
compatible:**

1. The function name, and the types, defaults, and order of its arguments.
2. The result columns, their types, and their order.
3. Each behavior that the documentation, a protocol fixture, or `docs/compatibility.md` states as a
   guarantee. A client that follows the documentation of an earlier release keeps working. For
   a result row order, a fixture assertion alone does not make a client guarantee.

A correction of a defect, a performance change, a new input that the function accepts, and a new
row in a result are compatible.

A result row order is a client guarantee only if the documentation tells clients that they can
rely on it. A change to a guaranteed order breaks condition 3, so it must use a successor. A
protocol fixture can pin an order that no document offers to clients as a guarantee. If no SDK
reads the rows by position, that order can change with the body. The same migration must then
update the fixture and the documentation that describes the order. Migration 0079 is an example:
it changes the order of the maintenance phases and updates the fixture and the documentation.

**A change that breaks one of the three conditions needs a successor.** These changes need one:

- A different result for an input, when the documentation states the earlier result.
- A rejection of an input that the documentation states the function accepts.
- A new meaning for a stored value that a supported release reads or writes.

The successor is `<name>_v<N+1>`. The earlier function stays until a contract step retires its
protocol version, as ADR 0057 states.

The header comment of a migration states why its body changes stay compatible.
`docs/schema-lifecycle.md` holds the rule.

## Consequences

The rule writes down the practice that the migrations already follow. No shipped migration
changes.

The documentation and the protocol fixtures become the boundary of a body change. A behavior that
no document states can change in place. A reader who needs a behavior to stay the same must find
it in the documentation or in a fixture.

A defect correction can change a result that a client saw before. The rule permits that change,
because the earlier result broke a documented guarantee.
