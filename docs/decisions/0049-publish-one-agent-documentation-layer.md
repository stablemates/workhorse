# ADR 0049: Publish one agent documentation layer

- **Status:** Accepted; amended by [ADR 0061](0061-record-the-agent-docs-eval-through-the-claude-cli.md)
- **Date:** 2026-09-02
- **Related:** [WH-517](https://ontrack.sh/projects/WH/issues/WH-517), [ADR 0033](0033-maintain-site-docs-as-a-guide-consumer.md), [ADR 0043](0043-public-ci-and-release-policy.md), [ADR 0046](0046-make-readmes-entry-points.md)

## Context

Coding agents integrate Workhorse into other people's applications by fetching URLs. Four fresh
URL-only sessions were recorded against the live site on 2026-09-01. Every session enqueued inside
the caller's transaction, and every session kept schema installation off the runtime path. The
failures were discovery, not comprehension.

Two sessions never found the agent page. Three lost two of three languages, because the HTML page
collapses its language tabs and the site says nothing about the Markdown twin that does not. One
session reconciled the three published versions into `0.1.0-beta.3`, which does not exist, and
emitted commands that fail at the first step. One session sent an external effect outside a
checkpoint, which is the one remedy `site/content/docs/for-ai-agents.mdx` never names.

The supporting conditions are in the repository. `site/scripts/gen-docs-index.ts` copies each page
body into its twin unchanged, so `<Tabs>` and `<Tab>` reach the agent verbatim, and
`site/nginx.conf` declares no Markdown type, so the origin serves a twin as
`application/octet-stream`. Nine install snippets disagree on pinning and on the schema step. The
three packages publish on a staged train, so their versions legitimately differ and always will.

Every peer project surveyed ships an installable skill. Workhorse ships no neutral agent page worth
packaging yet, so packaging is not decided here.

## Decision

Workhorse publishes one agent layer with five parts.

**One router and one destination.** `llms.txt` is the router. `/docs/for-ai-agents` is the
destination, and it keeps that URL, because the origin serves one `location /` block and issues no
redirect. The router's lead states four things: start at the destination, append `.md` for a page
that shows all three languages, install the version Installation names, and `llms-full.txt` costs
about 256 KB. `llms-full.txt` carries its own lead and keeps sidebar order. Every landing surface
carries exactly one pointer to the router: the site footer, `robots.txt`, the root README, and the
three package READMEs. A docs page keeps its `alternate` link and gains nothing, because its
prerendered HTML carries no sidebar.

**The Markdown twin is the agent's form of every page.** The generator expands each `<Tab>` inline
under a bold language label and de-indents its fenced block, so the twin's heading outline still
matches the page's. Twins carry `title`, `description`, and `canonical` frontmatter and no version.
`llms-full.txt` embeds the body without frontmatter. The origin serves `.md` as `text/markdown`, and
a canonical HTML URL does not negotiate on `Accept`. The generator throws on any MDX tag its
transform does not know.

**No document states a package version.** One install command per language and one schema command,
all unpinned, held as an `install` catalog in `support.json` and swept across every governed surface
by a test. Unpinned resolves correctly in all three ecosystems today and after the first stable
release. Three pins that legitimately disagree invite an agent to average them. The schema command
uses the `npx --package` form everywhere, because the bare form resolves an unrelated npm package
named `workhorse` in any project that is not a Node project. Every Python and Go install surface
states that the schema is a deployment step, names the command, and names its Node requirement. The
runtime answers the version question, through `workhorse schema status`, `assertSchemaCompatible`,
`assert_schema_compatible`, and `AssertSchemaCompatible`.

**One agent-facing page.** `site/content/docs/for-ai-agents.mdx` is rewritten in place as the
playbook, and `docs/guides/385-agent-integration.md` stays its guide-layer sibling. The page carries
six sections: how to read this documentation, whether Workhorse fits, the four things you write, the
three mistakes with their remedies, confirmation, and next. Its end-to-end example wraps an external
send in a checkpoint and sets a failure policy at enqueue. Every documentation link in its body
targets a Markdown twin. Its identifiers are verified in three tiers: compiled inside a `verify`
fence, named in prose and required to appear in that language's fence, or allowlisted against the
source path that must still contain them.

**The eval records once and scores offline.** `record` produces a session and needs a model
credential; ADR 0061 makes that the maintainer's CLI login rather than an API key.
`score` reads a frozen fixture and needs nothing. Four tasks reuse the baseline's task text and its
four start points, so the TypeScript pair that differs only in start point measures the entry point
directly. Scoring is mechanical on the transcript, over discovery index, off-site signature fetches,
failed fetches, and install resolution against real registries, plus a recorded maintainer read for
the three known mistakes. The harness lives in `scripts/agent-eval/` and its dated notes in
`docs/agent-evals/`. It runs on demand and in no CI lane, because ADR 0043 keeps model credentials
out of CI and a frozen fixture's score cannot go red.

## Consequences

An agent reaches correct integration in two fetches. Every surface that could strand it now points
at one router, and the router names one page.

A human who reads the playbook in HTML and follows a link receives Markdown. That trade is correct
for this one page and for no other page.

Three enforced rules change. `typescript/core/test/support-matrix.test.ts` asserts the unpinned rule
for Python only, and generalises to all four commands. The `readme-alignment` test that keeps a
pinned command on the newest changelog release becomes vacuous, because no pin remains, and the
sweep's no-pin assertion replaces it. `scripts/public-beta-release.test.ts` keeps its hardcoded
versions, because gating a release is a different job from telling a reader what to type.

`docs/decisions/` is exempt from the install sweep. An accepted record states what was decided on
its date, so ADR 0046 keeps the pin it recorded.

Two proofs stay weaker than they read. `pnpm test:site-smoke` runs in no enabled CI lane, so a smoke
assertion added for this layer is real but ungated. Nothing in the repository runs the site's nginx,
so the Markdown type is proved against `site/nginx.conf` text and not against a served
response.

Per-harness packaging stays undecided. A neutral page has to exist before anything can package it,
and the drift check and freshness mechanism for packaged text both wait on that decision.
