# How does an AI coding agent integrate Workhorse?

An AI coding agent reads documentation by fetching URLs. It cannot click a language tab, so an
HTML page hides two of the three languages from it. Workhorse publishes an agent-facing layer that
solves discovery first, then walks one integration end to end.

## Read the Markdown, not the HTML

Append `.md` to any documentation URL to reach that page's Markdown twin. The twin shows every
language at once, because it expands each language tab inline. The suffix is the only route; asking
for Markdown through content negotiation does not work.

Two index files sit above the twins. One is a compact map of every page, grouped like the sidebar.
The other is the whole corpus in a single response, which is large and worth fetching only when a
change crosses several contracts at once.

## Decide before you integrate

The playbook states what Workhorse is not, before it shows any code, so an agent can stop early
rather than discover a mismatch after writing the integration. Handlers run at least once. Schema
compatibility is exact. PostgreSQL is the only database. There is no workflow definition language.

## Follow one integration path

The agent writes four things. It installs the schema from the deployment rather than from the
application. It enqueues inside the transaction that writes application data, so both commit
together. It registers a handler. It chooses the failure policy when it enqueues.

Three mistakes survive review because none of them fails immediately. Enqueueing outside the
caller's transaction leaves a job for a row that rolled back. Installing the schema at startup makes
every instance race. An external effect that is not restart-safe repeats on every retry, which a
checkpoint prevents by recording the result the first time.

After the worker settles the job, the agent reads it back by its identifier to confirm the durable
state and result.

## How the examples stay true

The site page carries one complete program per language. Site checks compile all three: TypeScript
through the type checker, Python through the formatter and the type checker, and Go through the
formatter and the compiler. The cross-SDK name sweep that guards the feature pages does not cover
this page, because compiling its programs is the stronger check.

## Next

- [200-transactional-enqueue.md](200-transactional-enqueue.md) — commit application data and work together
- [310-workers.md](310-workers.md) — run handlers as a supervised process
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — why a handler must tolerate running twice

---

Exact enqueue and transaction semantics:
[`architecture.md`](../architecture.md#enqueue).
