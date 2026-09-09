# Agent documentation eval: Accept negotiation run

A follow-up to [2026-09-05-lighter-pages.md](2026-09-05-lighter-pages.md), run after SM-691 (WH-666) deployed and the origin began negotiating on `Accept`. The eval's `fetch_url` now sends `Accept: text/markdown, text/html, */*`, the same header Claude Code sends, so the canonical landing page returns the Markdown twin instead of the 347,928-byte HTML.

## What was under test

- **ADR 0062** reversed ADR 0049's clause that a canonical HTML URL does not negotiate on `Accept`. Any page with a Markdown twin now serves `text/markdown; charset=utf-8` when the `Accept` header names `text/markdown`.
- The harness's `fetch_url` was updated to send the header, so every fetch the recorded sessions made asked for Markdown first.

## Fetches and discovery

| Task | Language   | Start point       | Fetches | Discovery index | Off-site signature fetches | Failed fetches | Installs resolving |
| ---- | ---------- | ----------------- | ------- | --------------- | -------------------------- | -------------- | ------------------ |
| A    | TypeScript | site landing page | 13      | never           | 0                          | 0              | 2 of 2             |
| B    | Python     | site landing page | 16      | never           | 0                          | 0              | 2 of 2             |
| C    | Go         | site landing page | 12      | never           | 0                          | 0              | 2 of 2             |
| D    | TypeScript | root README       | 13      | 2               | 0                          | 0              | 2 of 2             |

The landing page for A, B and C returned Markdown on the first fetch. None of those three sessions then fetched `/llms.txt`, `/docs/for-ai-agents`, or a `.md` path, so the discovery index is `never` under the current `isAgentSurface` definition. They did read `/docs/quickstart`, `/docs/enqueue` and other canonical pages, which the server returned as `text/markdown`, but `score` does not yet count a canonical `/docs/*` response as an agent surface. D still reached `/llms.txt` second, the same index as the 2026-09-05 baseline.

## Landing page bytes

| Task | Landing bytes before (HTML) | Landing bytes after (Markdown) | Saved |
| ---- | --------------------------- | ------------------------------ | ----- |
| A    | 347,928                     | 48,042                         | 86.2% |
| B    | 347,928                     | 48,042                         | 86.2% |
| C    | 347,928                     | 48,042                         | 86.2% |

The three sessions that start at the landing page save 299,886 bytes on that first fetch. The Markdown landing is 48,042 bytes and returns `content-type: text/markdown; charset=utf-8` with `Vary: Accept`.

## Total bytes per session

| Task | Total bytes before (2026-09-05) | Total bytes after (this run) | Saved |
| ---- | ------------------------------- | ---------------------------- | ----- |
| A    | 541,613                         | 160,030                      | 70.5% |
| B    | 547,035                         | 183,536                      | 66.4% |
| C    | 535,664                         | 163,743                      | 69.4% |
| D    | 180,962                         | 128,369                      | 29.1% |

D's saving is smaller because it starts from the GitHub README, which is unchanged, and then reads the same documentation pages as before.

## Contradictions and false positives

`pnpm agent-eval:score` reports three contradictions, all false positives from scanning the produced markdown rather than the code:

- **Task A, enqueueOutsideTransaction**: the produced text includes design prose (`TypeScript's queue.enqueue(type, payload, options, client)` takes the open pg client...) and an ORM example (`adapter.forTransaction(tx).enqueue(...)`). The actual `queue.enqueue` call in `src/orders/create-order.ts` does pass the open `client` as the fourth argument.
- **Task D, schemaOnRuntimePath**: the produced markdown includes an optional `src/deploy/install-schema.ts` file. The runtime paths (`assertSchemaCompatible` in client, worker and handler) only verify the schema.
- **Task D, effectOutsideCheckpoint**: the handler is returned by `createOrderConfirmationHandler`, and the external send is inside `context.checkpoint("provider-send", ...)`. The signal matches the function name and not the checkpoint.

## What this means for the unused twin

The landing twin is no longer unused. In the 2026-09-05 run, not one session fetched `/index.md`. In this run, every session that starts at the landing page receives the twin on the first fetch, because the request asks for Markdown and the origin serves it. The saving is the twin's alone: 299,886 bytes per landing-first session.

SM-47 (WH-665) therefore kept the twin and the fix was `Accept` negotiation. The remaining acceptance item, the later eval run, is now recorded here.

## Reproduce the scoring

```bash
pnpm agent-eval:score scripts/agent-eval/sessions/2026-09-09-accept-negotiation
```

Scoring is offline and needs no credential or network. The `--registries` flag can re-check the install commands against the live registries.
