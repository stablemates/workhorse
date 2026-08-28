# How does an AI coding agent integrate Workhorse?

An AI coding agent needs a short path from product documentation to verified application code.
Workhorse publishes agent-readable documentation and keeps the same workflow across every SDK.

## Find the right documentation

Start with `/llms.txt` for the documentation map. Use `/llms-full.txt` when the agent needs the
complete documentation in one request. Every documentation page also has a Markdown twin, and the
HTML response advertises that twin through its alternate link.

The Markdown pages preserve code and identifiers without requiring the agent to extract an HTML
shell. Give the agent the narrow page first, then use the full index when the task crosses several
features.

## Follow one integration path

Install the SDK for the application's language, then construct `Queue` over the application's
PostgreSQL connection. Enqueue inside the transaction that changes application data, so PostgreSQL
commits the job and that data together.

Run a `Worker` with a handler for the same job type. After the worker settles the job, use
`Admin.getJob`, `Admin.get_job`, or `Admin.GetJob` to confirm its durable state and result.

The site page shows complete TypeScript, Python, and Go programs. The repository verifies their
public names against the SDK sources and compiles the Python and Go examples during site checks.

## Next

- [200-transactional-enqueue.md](200-transactional-enqueue.md) — commit application data and work together
- [310-workers.md](310-workers.md) — run handlers as a supervised process
- [395-serverless-web-tiers.md](395-serverless-web-tiers.md) — enqueue from short-lived request handlers

---

Exact enqueue and transaction semantics:
[`architecture.md`](../architecture.md#enqueue).
