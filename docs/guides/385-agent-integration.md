# How does an AI coding agent integrate Workhorse?

<!-- scenario-names: order-42, order.created -->

An AI coding agent reads documentation by fetching URLs. It cannot click a language tab, so an
HTML page hides every language but one from it. Workhorse publishes an agent-facing layer that
solves discovery first, then walks one integration end to end.

## Read the Markdown, not the HTML

> **Example.** An agent is asked to add Workhorse to a Python order service. This is how it finds
> what to read.
>
> 1. **It fetches the index.** `/llms.txt` is a compact map of every page, grouped like the sidebar.
>    It names the agent page as the place to start.
> 2. **It fetches the agent page with `Accept: text/markdown`.** The page's own URL answers with its
>    Markdown twin. The twin shows every language at once, because it expands each language tab
>    inline. The Python example is there, next to the others.
> 3. **It follows a link to the enqueue page by appending `.md`.** That fetches the same twin
>    without negotiation.

Every documentation page has a Markdown twin, and both routes reach it. A second index holds the
whole corpus in a single response. It is large, and worth fetching only when a change crosses
several contracts at once.

<details>
<summary>Reference: agent-facing files and negotiation</summary>

| URL                   | Content                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `/llms.txt`           | Every page with a one-line description, grouped like the sidebar. |
| `/llms-full.txt`      | Every documentation page in one file, without frontmatter.        |
| `/docs/for-ai-agents` | The agent playbook. Its body links only Markdown twins.           |
| `/docs/<slug>.md`     | The Markdown twin of `/docs/<slug>`, served as `text/markdown`.   |

**Twins.** The generator expands each `<Tab>` inline under a bold language label. A twin carries
`title`, `description`, and `canonical` frontmatter.

**Negotiation on a page URL**

1. An `Accept` header that names `text/markdown` selects the twin, as
   `text/markdown; charset=utf-8`.
2. `text/markdown;q=0` is a rejection and selects HTML.
3. A browser, a missing header, or `*/*` selects HTML.
4. Every negotiated response carries `Vary: Accept`.
5. A page with no twin answers a Markdown-only client with `406 Not Acceptable`.

The match is a substring test, not a q-value ordering.

**Not found.** A client that asked for Markdown gets a 404 whose Markdown body names the index, the
entry point, the one-file download, the sitemap, and the `.md` rule.

More detail: [ADR 0062: Decision](../decisions/0062-negotiate-markdown-on-accept-and-publish-the-machine-readable-surfaces.md#decision).

</details>

## Decide before you integrate

The agent's order service runs on MySQL. The playbook's second section says PostgreSQL is the only
database, so the agent stops there and reports why. It has written no code.

The playbook states what Workhorse is not, before it shows any code, so an agent can stop early
rather than discover a mismatch after writing the integration. Handlers run at least once. A client's
compatibility check refuses a schema older than the client needs, or one that no longer serves the
client's SQL protocol. PostgreSQL is the only database. There is no workflow definition
language. A concurrency policy covers one queue, not several.

<details>
<summary>Reference: schema compatibility refusals</summary>

The TypeScript, Go, and Python compatibility checks return the same five refusal codes:

| Code                      | Meaning                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `schema-not-installed`    | The schema version is missing or ambiguous.                          |
| `schema-too-old`          | The schema is below the minimum, or does not yet serve the protocol. |
| `schema-too-new`          | The schema no longer serves the protocol this client speaks.         |
| `client-protocol-too-old` | The client's protocol is below the minimum this runtime supports.    |
| `client-protocol-too-new` | The client's protocol is above the maximum this runtime supports.    |

| Language   | Startup assertion          |
| ---------- | -------------------------- |
| TypeScript | `assertSchemaCompatible`   |
| Python     | `assert_schema_compatible` |
| Go         | `AssertSchemaCompatible`   |
| Rust, Ruby | `assert_compatible`        |

More detail: [Schema and SQL protocol: Schema compatibility checks](../architecture/schema-and-protocol.md#schema-compatibility-checks).

</details>

## Follow one integration path

The playbook's example inserts order `order-42` and enqueues `order.created` for it. The agent
writes four things.

1. **The schema install.** It runs from the deployment, not from the application.
2. **The enqueue.** It runs inside the transaction that inserts `order-42`, so the order and the
   task commit together.
3. **The handler.** It sends the confirmation email inside a checkpoint. A checkpoint is named
   handler code whose result Workhorse records, so a replay reuses it.
4. **The failure policy.** The agent chooses the retry budget and the time bounds when it enqueues.

After the worker settles the task, the agent reads it back by its identifier. A settled task
reports its state and its result. An unsettled one reports the state it is in, which tells a slow
worker from a missing one.

Three mistakes survive review because none of them fails immediately.

- **Enqueueing outside the caller's transaction.** The insert of `order-42` rolls back, but the task
  commits. A worker then processes an order that does not exist.
- **Installing the schema at startup.** Every application instance races to install.
- **An external effect that is not restart-safe.** A handler that sends the email and then fails
  sends it again on every retry. A checkpoint prevents this by recording the result the first time.

<details>
<summary>Reference: identifiers the playbook uses</summary>

**Transaction handover**

| Language   | How enqueue joins the caller's transaction                           |
| ---------- | -------------------------------------------------------------------- |
| TypeScript | Pass the transaction client as the fourth argument to `enqueue`.     |
| Python     | Construct the `Queue` over the connection whose transaction is open. |
| Go         | Wrap the transaction with `workhorse.NewPGXExecutor(tx)`.            |
| Rust, Ruby | Construct the `Queue` over the open transaction.                     |

**Checkpoint and read-back**

| Language   | Checkpoint                            | Read the task back |
| ---------- | ------------------------------------- | ------------------ |
| TypeScript | `context.checkpoint(name, operation)` | `Admin.getTask`    |
| Python     | `context.checkpoint(name, operation)` | `Admin.get_task`   |
| Go         | `handler.Checkpoint(name, operation)` | `Admin.GetTask`    |
| Rust       | `context.checkpoint(name, operation)` | `Admin::get_task`  |
| Ruby       | `context.checkpoint(name) { … }`      | `Admin#get_task`   |

**Failure policy.** `maxAttempts` and `retryPolicy` set the retry budget. `deadline` ends the whole
task when it passes. `executionTimeoutMs` ends one attempt; the task then retries under its policy
while attempts remain.

More detail: [Task lifecycle: Enqueue](../architecture/lifecycle.md#enqueue).

</details>

## How the examples stay true

A pull request renames a Go method that the playbook's Go program calls.

1. **The site checks run.** They compile the playbook's Go program, which still calls the old name.
2. **The compiler fails**, so the build fails.
3. **The change stops there.** No agent fetches a playbook that calls a method Go no longer has.

The playbook carries one complete program per language. Site checks compile each one, so a renamed
method breaks the build before it reaches an agent. Identifiers named in the playbook's prose must
also appear in that language's program, or in a short list of source files that must still define
them. The cross-SDK name sweep that guards the feature pages does not cover this page, because
compiling its programs is the stronger check.

<details>
<summary>Reference: example checks</summary>

| Language   | Check                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| TypeScript | `tsc` type-checks the `ts verify` fence.                                                                            |
| Python     | `ruff format --check` and `mypy` check the `python verify` fence.                                                   |
| Go         | `gofmt` and the Go compiler check the `go verify` fence.                                                            |
| Rust       | The fence must equal a `docs:start` region in `rust/examples/`, which `cargo clippy --all-targets` compiles.        |
| Ruby       | The fence must equal a `docs:start` region in `ruby/examples/`, which a documentation spec runs against PostgreSQL. |

`site/scripts/check-language-examples.ts` runs these checks. Its `crossSdkGuidePaths` list, the
feature-page name sweep, does not include `for-ai-agents.mdx`.

More detail: [ADR 0049: Decision](../decisions/0049-publish-one-agent-documentation-layer.md#decision).

</details>

## Next

- [200-transactional-enqueue.md](200-transactional-enqueue.md) — commit application data and work together
- [310-workers.md](310-workers.md) — run handlers as a supervised process
- [030-delivery-guarantees.md](030-delivery-guarantees.md) — why a handler must tolerate running twice

---

Exact enqueue and transaction semantics:
[`architecture/lifecycle.md`](../architecture/lifecycle.md#enqueue).
