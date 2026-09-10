# Agent documentation eval: the repository start point, with no skill

The run SM-704 asked for, and the evidence ADR 0063 gates a packaged skill on. One session, task
E, recorded against `https://workhorse.run` as published on 2026-09-10, with SM-703 not yet
deployed.

## What was under test

Every earlier task hands the session a URL. Task E hands it none. The session starts inside a
scratch application that already depends on `@stablemates/workhorse`, with `npm install` run for
real, and is told only that the application uses a job library it should use. Whether the
session finds the documentation at all, and how, is the whole question: a packaged skill exists
for exactly this start point, and ADR 0063 builds one only if this session misses.

The session could read the repository. ADR 0061 gives a session one tool, `fetch_url`; task E
adds `list_files` and `read_file`, served by the same MCP server, confined to the scratch
repository by real-path check, and logged apart from fetches. A read spends no fetch budget and
never enters the fetch log, so the discovery index is still a position among fetches. The CLI's
own `Read`, `Glob`, and `Grep` stay denied. `session.test.ts` asserts the option set for both
kinds of session, and the server tests assert that a path outside the repository is refused.

## Provenance

Recorded by `pnpm agent-eval:record E` through the `claude` CLI at `claude-opus-5`, the model and
harness of the 2026-09-09 run. The fixture is
`scripts/agent-eval/sessions/2026-09-10-repository-start/e/`. Install commands were checked
against the npm registry on the day with `--registries`.

## Scores

| Task | Language   | Start point                                         | Fetches | Repository reads | Discovery index | Off-site signature fetches | Failed fetches | Installs resolving |
| ---- | ---------- | --------------------------------------------------- | ------- | ---------------- | --------------- | -------------------------- | -------------- | ------------------ |
| E    | TypeScript | a repository depending on the SDK, no URL, no skill | 11      | 18               | 1               | 0                          | 0              | 2 of 2             |

Every fetch was served by `workhorse.run`, and every fetch after the first returned
`text/markdown`. Total bytes fetched: 97,067. None of the three known mistakes was committed.

The discovery index uses the definition SM-704 amended: a `/docs/*` fetch whose response is
`text/markdown` counts as an agent surface, because it is the twin. The index here does not
depend on that clause; the first fetch was `/llms.txt`.

## How the session found the documentation

The read log answers the Issue's question directly. The session listed the repository, read
`package.json`, the application README, and both source files, then went straight into
`node_modules/@stablemates/workhorse`. Its eighth read was that package's `package.json` and its
ninth was the package README, which carries the one router pointer ADR 0049 put there. The first
fetch followed it: `/llms.txt`. The second was `/docs/for-ai-agents.md`, the playbook, which the
router names first.

The session then made nine more reads, eight of them inside the installed package, all `.d.ts`
declarations under `dist/src/`, while fetching nine documentation twins. The produced program uses the typed handler
signature, contracts with a sensitive payload key, an idempotency key on enqueue, a decorrelated
jitter retry policy, the job's abort signal, and the `defineWorkerProcess` entry point, none of
which the playbook's example shows. It states in its own first sentence that the README pointed
at `llms.txt`.

The installed package's README is the same file the npm packument serves as the package's README,
verified on the day. So the pointer reaches any project that installed the package, in the form
the session read it.

## The three mistakes

Recorded read, from the produced program:

- **Enqueuing outside the caller's transaction:** clean. `queue.enqueue` is called between `BEGIN`
  and `COMMIT` with the transaction client as its fourth argument.
- **Installing the schema on the runtime path:** clean. The runtime calls
  `assertSchemaCompatible` at startup; `workhorse schema install` appears only in the install
  block and the deployment note.
- **An external effect outside a checkpoint:** clean. The provider send runs inside
  `context.checkpoint("provider-send", ...)`, and the call also carries an idempotency key.

`score` reports no contradiction. Two signals are `unclear` rather than `clean`: the enqueue
detector does not recognise a generic call, `queue.enqueue<Payload>(...)`, and the handler
detector does not recognise a handler declared as a typed constant rather than registered inline.
An unclear signal never contradicts a recorded read, and both patterns are worth teaching the
detectors; that is the same class of gap WH-662 fixed for the schema signal.

## What this decides

**The session reached the playbook on its own, so no skill is built.** That is the first of the
two outcomes SM-704 named, and the one ADR 0063 chose to make decisive: a surface with no measured
value is a maintenance cost and nothing else. SM-702 closes on this note. ADR 0063 stands as
written, with the pointer skill as the recorded design should a later run miss.

The result also says what the existing layer does in this scenario. An agent in a repository
that depends on Workhorse reaches the router in one fetch and the playbook in two, one better
than every URL-start session, because the README pointer inside the installed package is closer
than the site's landing page.

## Caveats

One session, one language. Python and Go projects also install the README with the package, and
their READMEs carry the same pointer, but no session was recorded from them.

The scratch repository is small and idle. A larger application would cost the session more reads
before it reached `node_modules`, and a session that never looked inside `node_modules` would have
had to guess a URL. This one did not guess: its first fetch followed a link it had read.

`fetch_url` sends `Accept: text/markdown, text/html, */*`, so the twins arrived negotiated. The
session also appended `.md` on every docs fetch, following the playbook it had read.

## Reproduce the scoring

```bash
pnpm agent-eval:score scripts/agent-eval/sessions/2026-09-10-repository-start
```

Scoring is offline and needs no credential or network. `--registries` re-checks the two install
commands against npm.
