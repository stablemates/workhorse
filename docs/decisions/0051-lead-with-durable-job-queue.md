# ADR 0051: Lead with "durable job queue" and explain the protocol second

- **Status:** Accepted
- **Date:** 2026-09-02
- **Related:** [WH-554](https://ontrack.sh/projects/WH/issues/WH-554), [WH-548](https://ontrack.sh/projects/WH/issues/WH-548), [ADR 0042](0042-publish-the-first-public-beta.md), [ADR 0046](0046-make-readmes-entry-points.md)

## Context

Workhorse describes itself two ways. The site tagline, `CONTEXT.md`, and the three package READMEs
say "PostgreSQL-native durable execution protocol". The root README and the GitHub description say
"a durable job queue built on PostgreSQL". The site hero adds "background tasks". One page ships
three nouns, and a launch post would have to pick one.

The competitor survey (WH-552) found a terminology split. "Job queue" and "background jobs"
(pg-boss, Graphile Worker, BullMQ, River, Solid Queue) address application developers replacing
Sidekiq, Bull, or Celery. "Durable execution" and "durable workflows" (Temporal, Inngest, DBOS,
Absurd, Hatchet) address platform engineers who expect a persisted program to resume from its last
step, usually behind a server. `docs/features.md` rules out a workflow runtime and a persisted
continuation stack, so the tagline overstates against the term's owners. It also sits two words
from Absurd's "Postgres-native durable workflow system". No surveyed project uses "protocol".

The launch survey (WH-549) found that "durable execution" in a title reliably summoned Temporal and
DBOS comparisons, while "Name: adjective job queue for Language and Postgres" was the title shape
that scored without a company behind it. The marketing map (WH-548) fixes the primary audience as
TypeScript backend developers who already run PostgreSQL, with Python and Go developers second.

No surveyed project ships all five axes open source in one library: transactional enqueue, durable
execution inside a handler, full workers in more than one language, a built-in dashboard, and no
infrastructure beside PostgreSQL. Workhorse's copy on all five is supported by `docs/parity.md`,
`docs/features.md`, and `docs/architecture.md`, with the qualifiers in the site's limitations page.

## Decision

The category noun is **durable job queue**. Every outbound surface repeats one line:

> A durable job queue for PostgreSQL, with TypeScript, Python, and Go workers on one SQL protocol.

Where a field is too short for the clause, the short form is "A durable job queue for PostgreSQL."
The line is the first sentence of the root README, the GitHub description, the site tagline and meta
description, the package descriptions where a registry field exists, and the shape of the launch
post title.

"Protocol" survives as the second line, because it is why three languages share full parity. It
gets one clause that says why a reader should care:

> Workhorse is versioned SQL functions inside the database you already run. Every language gets the
> same workers, the same durable waits, and the same dashboard, with no broker or server beside
> PostgreSQL.

The site hero is the one surface where the second line is not that clause. A hero is read in one
glance, so it gets one job per element rather than two paragraphs of definition. The `h1` carries
the position, "Harness the Postgres you already run." The right panel heading carries the protocol,
"One database protocol, three clients." The paragraph under the `h1` carries what the reader gets:

> Durable background tasks with crash recovery, efficient long waits, and fleet-wide concurrency
> controls.

Every other surface keeps the clause as written above. WH-628 owns the hero wording.

Three supporting claims follow, in this order. Each is true of the code today and absent or weaker in
the incumbents the reader will compare against.

1. **Enqueue inside your own transaction.** The business write and its job commit or roll back
   together, with no outbox table and no relay. Absent in BullMQ, Inngest, Trigger.dev, Temporal, and
   Hatchet; a docs footnote in Graphile Worker.
2. **Crash mid-job, finish anyway.** Named checkpoints, durable waits, and signals replay completed
   stages, and fence tokens stop a resumed worker from overwriting newer work. Delivery is
   at-least-once, and the copy says so. Absent in pg-boss, Graphile Worker, BullMQ, River, and Solid
   Queue; the platforms that have it need their own server.
3. **Three languages, one protocol, one dashboard.** TypeScript, Python, and Go run full workers over
   the same versioned SQL functions and embed the same operator dashboard. Every PostgreSQL queue
   surveyed is single-language or insert-only elsewhere; DBOS licenses its production dashboard;
   Absurd marks Go experimental.

"Durable execution" remains the name of the feature family: checkpoints, durable waits, and signals,
documented at `/docs/durable-execution`. It is never the category noun. "Durable execution
protocol" is retired as a product description.

"Public beta" sits outside the line. It follows the line as the fixed labelled sentence
[ADR 0042](0042-publish-the-first-public-beta.md) defines, with its compatibility boundary. It is
never an adjective inside the line and never part of a title.

Applying the line to the root README, the package READMEs, the site configuration and hero, and the
GitHub description is an execution Issue of the marketing map, WH-587, not part of this decision. The GitHub
description is outward-facing, and site copy reaches readers only through a maintainer deployment.

## Considered options

- **Lead with "durable execution protocol".** Distinct and unclaimed, but it invites the reader to
  test Workhorse against Temporal and DBOS, where the honest answer is "not a workflow runtime".
- **Lead with "durable execution" for agent builders.** Absurd and DBOS already own that reader, and
  the map's primary audience is application developers.
- **Coin a new noun such as "job protocol".** Unclaimed, but a reader searching for a category would
  not find it, and no incumbent comparison would place it.

## Consequences

Comparison copy contrasts "at-least-once, with checkpoints and fences" against pg-boss's
"exactly-once" and never borrows that phrase. The launch post title (WH-560) keeps "durable
execution" out of the title and puts PostgreSQL in it. The README first sentence loses "built from
PostgreSQL tables and versioned SQL functions" to the line, and the second line carries that fact.
The unit noun is unsettled: the SDKs and guides say "job" while the dashboard says "task"; WH-588
owns that glossary decision. The hero exemption (WH-629) narrows where the protocol clause appears
and nothing else. The category noun, the positioning line, the surfaces that carry it, the three
supporting claims, and the "Public beta" placement are unchanged, and `site/lib/site.ts` still
carries the line as the site tagline and meta description.
