# Agent documentation eval: the 2026-09-05 agent docs run

The first recorded run, and the first scored against the layer ADR 0049 built. It measures
`https://workhorse.run` as published on 2026-09-05, with WH-530 to WH-539 live.

## Provenance

Four sessions, recorded by `pnpm agent-eval:record` through the `claude` CLI at `claude-opus-5`.
Every fetch was performed by the harness, so each carries a real status, content type and byte
count. The produced programs are kept beside their transcripts, so `score` reports a signal for each
of the three known mistakes rather than the baseline's `unclear`.

The install verdicts were checked against the live registries on the day: npm for
`@stablemates/workhorse`, PyPI for `stablemates-workhorse` and `httpx`, and the Go module proxy for
`github.com/stablemates/workhorse/go` and `github.com/jackc/pgx/v5`.

## Scores

| Task | Language   | Start point       | Fetches | Discovery index | Off-site signature fetches | Failed fetches | Installs resolving |
| ---- | ---------- | ----------------- | ------- | --------------- | -------------------------- | -------------- | ------------------ |
| A    | TypeScript | site landing page | 14      | 2               | 0                          | 0              | 3 of 3             |
| B    | Python     | site landing page | 17      | 3               | 0                          | 0              | 3 of 3             |
| C    | Go         | site landing page | 15      | 2               | 0                          | 0              | 4 of 4             |
| D    | TypeScript | root README       | 15      | 2               | 0                          | 0              | 3 of 3             |

Four of four reached an agent surface. Four of four produced install commands that all resolve. None
committed a known mistake.

## Against the 2026-09-01 baseline

| Measure                             | Baseline  | This run |
| ----------------------------------- | --------- | -------- |
| Task A discovery index              | never     | 2        |
| Task D discovery index              | 4         | 2        |
| A minus D                           | unbounded | 0        |
| Sessions reaching an agent surface  | 3 of 4    | 4 of 4   |
| Off-site signature fetches, total   | 5         | 0        |
| Failed fetches, total               | 2         | 0        |
| Sessions whose installs all resolve | 3 of 4    | 4 of 4   |
| Sessions committing a known mistake | 1 of 4    | 0 of 4   |

## Pass bar

Set by WH-524 and recorded in ADR 0049. Every line is met.

- Discovery index non-null for all four tasks, and at most 3. **Met**: 2, 3, 2, 2.
- Task A within one of task D. **Met**: both 2. The baseline's gap was 15 fetches against 4, with A
  never arriving.
- Zero off-site fetches for SDK signatures. **Met**: 0, against 5 in the baseline.
- Four of four sessions resolving every install command. **Met**.
- Zero occurrences of the three known mistakes. **Met**.

## What the numbers say

**The entry point decision worked, and it is the whole story.** Tasks A and D differ only in start
point. In the baseline, A spent fifteen fetches in HTML and never saw an agent surface, while D
reached `llms.txt` on its fourth fetch. Both now reach it on the second. A starts at the landing
page and follows the footer link; D starts at the root README and follows the pointer there. The
gap the pass bar was written around has closed to nothing.

**Every session left HTML almost immediately and stayed in Markdown.** Twelve of A's fourteen
fetches, fourteen of B's seventeen, and twelve each of C's and D's fifteen were served as
`text/markdown`. The two or three HTML fetches per session are the start point and the `/docs`
index, both of which are reached before the router names the `.md` rule.

**The per-language reference closed the off-site leak.** The baseline spent five fetches on GitHub
and `pkg.go.dev` because no page listed signatures. This run spent none: C read `/docs/api.md` and
`/docs/contracts.md` and stopped there.

**Nobody fetched `llms-full.txt`.** Not one of the four, though the router names it and states its
size. This answers the question WH-540 held open: an ordering rule for `llms-full.txt` has no
evidence behind it, and the item is dropped rather than decided. Stating the size appears to be
enough, and a session that has the router and the twins does not need the corpus.

**The pinned schema command is copied, and that is correct.** B and C both emitted
`npx --package @stablemates/workhorse@0.1.0 workhorse schema install`, from `support.json`'s
`schemaPinned`. WH-605 added that pin deliberately, because the schema tool has to match the library
version the application depends on. It resolves. This is the opposite of the baseline's failure,
where a session reconciled two disagreeing pins into `0.1.0-beta.3`, which does not exist.

## One contradiction, and it is the harness's fault

`score` exits non-zero on this run. Task D's program calls `installSchema` inside
`src/workhorse/deploy.ts`, under the comment "Run from your deploy pipeline, not from an application
process", and uses `assertSchemaCompatible` on the runtime path. That is the pattern the
documentation asks for, so the recorded read is `clean`. `schemaSignal` matches `installSchema(`
anywhere in the source and cannot see where the call sits, so it says `committed`.

The recorded read is authoritative and the disagreement is meant to be visible, so the fixture is
left as it stands. [WH-662](https://ontrack.sh/projects/WH/issues/WH-662) fixes the detector.

## Caveat

The baseline and this run do not share a harness. The baseline was reconstructed from sessions run
by hand, whose model was never recorded; this run is the first recorded one, and it goes through the
`claude` CLI (ADR 0061). The comparison above is therefore indicative of the documentation change
and not clean evidence of it. **This run is the reference every later run should be compared
against**, because it names its model and its harness.

Two changes landed after this run was recorded and are not measured by it: WH-660, which cut the
landing page from 555,509 bytes to 346,359, and WH-661, which gave that page a 48,105-byte Markdown
twin. A run recorded after they are published measures those, against this run, on one harness.

Reproduce the scoring with `pnpm agent-eval:score scripts/agent-eval/sessions/2026-09-05-agent-docs`,
which needs no credential and no network.
