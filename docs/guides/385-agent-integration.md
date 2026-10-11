# How does an AI coding agent integrate Workhorse?

<!-- scenario-names: order-42, order.created -->

This page is for an AI coding agent that adds Workhorse to an application. An agent reads
documentation when it fetches a URL. It cannot click a language tab, so an HTML page shows it only
one language. This page tells you what to fetch and how to decide if Workhorse fits. Then it shows
one complete integration, from the enqueue to the result.

Each documentation page has a Markdown twin. A Markdown twin is a copy of the page in Markdown. It
shows the examples for all languages.

All examples on this page use one application. The application inserts order `order-42` and
enqueues the task `order.created` for it.

## Read the Markdown, not the HTML

**Example.** An agent must add Workhorse to a Python order service.

1. The agent fetches `/llms.txt`. This index lists each page, in the same groups as the sidebar. It
   names this page as the start point.
2. The agent fetches this page with the header `Accept: text/markdown`. The URL of the page returns
   its Markdown twin.
3. The twin shows the code of each language tab. The agent finds the Python example next to the
   other examples.
4. The agent adds `.md` to the URL of the enqueue page. The URL `/docs/enqueue.md` returns the twin
   without the header.

Read the twin, not the HTML page. The HTML page shows only the language of the selected tab.

The second index, `/llms-full.txt`, holds all pages in one file. It is large. Fetch it only if a
change touches many subjects at the same time. Usually, one twin costs less to read.

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

## Decide whether Workhorse fits

Workhorse has some fixed properties. They are not defects, but they can make Workhorse wrong for an
application. Read them before you write code, so that you can stop early.

Stop and report why if one of these properties does not fit the application:

- A handler runs at least one time, and sometimes more. Each effect of the handler must be safe to
  repeat.
- PostgreSQL is the only supported database. Workhorse has no other backend.
- The schema does not change when the application starts. A deployment step installs or migrates
  it. Each client refuses a schema that is too old, or a schema that no longer serves its SQL
  protocol.
- Workhorse has no workflow definition language. You write the steps of a flow as checkpoints in
  your own code.
- A concurrency policy applies to one queue, not to many queues.

For example, if the order service runs on MySQL, stop. Report the reason, and do not write code.

[Limitations](https://workhorse.run/docs/limitations.md) owns this subject. It also gives the workarounds.

<details>
<summary>Reference: schema compatibility refusals</summary>

The TypeScript, Python, Go, and Rust compatibility checks return the same five refusal codes. Ruby
returns the same codes as symbols with underscores, for example `:schema_too_old`.

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

## Write the four parts of the integration

An integration has four parts. Each part has one correct place in the application.

1. **The schema install.** The deployment installs the schema, not the application.
2. **The enqueue.** The application enqueues `order.created` in the transaction that inserts
   `order-42`. Thus, the order and the task commit together.
3. **The handler.** The handler sends the confirmation email in a checkpoint. A checkpoint is a
   named piece of handler code. Workhorse stores its result, so a later run uses the stored result.
4. **The failure policy.** The enqueue sets the number of attempts and the time limits.

After the worker completes the task, read the task with its identifier. The subsections below show
each part.

### Install the schema from your deployment

Install the schema in a deployment step. Do not install it when the application starts. A
TypeScript project runs the binary of its own dependency:

```bash
npm exec --no -- workhorse schema install
```

A Python, Go, Rust, or Ruby project has no Node.js dependencies. It names the version in the
command. This version must be equal to the SDK version of the application:

```bash
npx --package @stablemates/workhorse@0.7.1 workhorse schema install
```

The machine that runs the deployment needs Node.js for this command. [the compatibility reference](../compatibility.md#supported-versions)
names the Node.js version. The application does not need Node.js.

When the application starts, assert compatibility. Use `assertSchemaCompatible` in TypeScript,
`assert_schema_compatible` in Python, `AssertSchemaCompatible` in Go, or `assert_compatible` in Rust and Ruby.

Install the SDK of the application language:

```bash
npm install @stablemates/workhorse
pip install stablemates-workhorse
go get github.com/stablemates/workhorse/go
cargo add workhorse
bundle add stablemates-workhorse
bundle add connection_pool
```

The Ruby SDK also needs the `connection_pool` gem.

### Enqueue in the transaction of your application data

Enqueue the task in the same transaction that writes the application data. Then you do not need an
outbox. Each language gets the transaction in a different way:

- TypeScript passes the transaction client as the fourth argument to `enqueue`.
- Python constructs the `Queue` over the connection whose transaction is open.
- Go wraps the transaction with `workhorse.NewPGXExecutor(tx)`.
- Rust and Ruby construct the `Queue` over the open transaction, as Python does.

### Register a handler

The example calls the bounded run method, so it can stop. A production worker process calls the
continuous method:

- `worker.run()` in TypeScript.
- `worker.run()` in Python.
- `worker.Run(ctx)` in Go.
- `run_worker_process` in Rust.
- `Stablemates::Workhorse.run_worker_process(worker)` in Ruby.

### Set the failure policy when you enqueue

`maxAttempts` and `retryPolicy` set the number of attempts and the delay between them. `deadline`
and `executionTimeoutMs` set two different time limits. When the deadline passes, the task ends.
When the execution timeout passes, the attempt ends. Then the task retries if it has attempts that
remain.

<details>
<summary>Reference: the four things, per language</summary>

- **Schema install.** A TypeScript project runs `npm exec --no -- workhorse schema install`. Other
  projects run the pinned `npx --package` command shown above.
- **Startup assertion.** Call `assertSchemaCompatible` in TypeScript, `assert_schema_compatible` in
  Python, `AssertSchemaCompatible` in Go, or `assert_compatible` in Rust and Ruby.
- **Transaction handover.** TypeScript passes the transaction client as the fourth argument to
  `enqueue`. Go wraps the transaction with `workhorse.NewPGXExecutor(tx)`. Python, Rust, and Ruby
  construct the `Queue` over the open transaction.
- **Continuous worker.** Call `worker.run()` in TypeScript and Python, `worker.Run(ctx)` in Go, or
  `run_worker_process` in Rust and Ruby.

| Failure option       | Bounds                                               |
| -------------------- | ---------------------------------------------------- |
| `maxAttempts`        | The number of attempts.                              |
| `retryPolicy`        | The delay between attempts.                          |
| `deadline`           | The whole task. When it passes, the task ends.       |
| `executionTimeoutMs` | One attempt. The task retries while attempts remain. |

More detail: [Task lifecycle](../architecture/lifecycle.md).

</details>

## Avoid the three mistakes that pass review

Three mistakes often pass a code review, because none of them fails immediately.

**Do not enqueue outside the transaction of the caller.** If you do, the insert of `order-42` can
roll back while the task commits. Then a worker processes an order that does not exist. Give the
transaction to the enqueue, as the example does.

**Do not install the schema when the application starts.** If you do, all instances of the
application try to install it at the same time. Then a version difference causes a startup failure
under load, not a deployment failure. Use the deployment command and the startup assertion above.

**Do not let a handler repeat an external effect.** For example, a handler sends the email and then
fails. If the send is not in a checkpoint, each retry sends the email again. Put the send in a
checkpoint. The checkpoint stores the result of the first send, and a later run uses the stored
result. If a checkpoint does not fit, use an idempotency key on the remote call. You can also use an
outbox, an inbox, or a compensating action.

## Integrate one task from enqueue to result

Each example does these steps:

1. It connects to PostgreSQL.
2. It enqueues `order.created` in the transaction that inserts the order, with a failure policy.
3. It runs a worker. The handler puts the external send in a checkpoint.
4. It reads the stored result of the task.

The site page [`/docs/for-ai-agents.md`](https://workhorse.run/docs/for-ai-agents.md) has the complete
program for each language.

Expect two differences between the languages. Go's `RetryPolicy` is a `map[string]any`, but
TypeScript has a typed union. Python uses a mapping, Rust a JSON object, and Ruby a Hash. Thus, only
TypeScript rejects a malformed policy when it compiles. Each language has a schema compatibility
assertion, as the section about the schema install names.

## Confirm that the task is complete

After the worker runs, confirm that the task has a final state. Then you know that the integration
works.

The worker in the example runs one time and completes the `order.created` task. The program then
reads the task with the identifier that the enqueue returned. A complete task shows its state and
its result. An incomplete task shows its current state. Thus, you can find a slow worker or a
missing worker.

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

## Know how the site keeps the examples correct

The site checks the programs on this page when it builds. Thus, an agent never fetches a program
that calls a method the SDK no longer has.

**Example.** A pull request renames a Go method that the Go program on this page calls.

1. The site build compiles the Go program on this page.
2. The program still calls the old name, so the Go compiler fails.
3. The build fails, and the change stops before it reaches an agent.

The page has one complete program for each language. Each identifier that the text of the page
names must also be in the program of its language. A short list of identifiers is the exception, and
their source files must still define them. The name check of the feature pages does not include this
page, because the compilation of its programs is a stronger check.

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
