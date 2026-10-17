# ADR 0104: Publish sourced product comparisons in the docs

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR 0052](0052-publish-long-form-content-on-the-site.md) (comparisons are docs pages,
  not posts)
- **Related:** [ADR 0051](0051-lead-with-durable-job-queue.md)
- **Issue:** SM-1362, SM-1363, SM-1415

## Context

A developer who chooses a task queue compares Workhorse with the products that they already know.
The docs did not help with this choice. The rule "Keep benchmark comparisons private" in `CLAUDE.md`
did not permit the name of a competitor anywhere in the repository. Thus, no page could compare
Workhorse with another product.

ADR 0052 put comparisons on the blog. A post has a date and does not change. A comparison must stay
true while two products change, so it needs a check on a schedule and a fixed place in the docs.

The rule against names had one purpose: benchmark results must stay private until a maintainer
publishes them. A qualitative comparison with a source for each fact does not publish a benchmark
result.

## Decision

1. **Permitted places.** The name of a compared product can appear only in `site/comparisons.json`
   and in the pages under `site/content/docs/compare/`. Three earlier places stay exempt: the
   decision records, `site/content/docs/active-job.mdx`, and `site/content/docs/django.mdx`.
   Release notes in a `CHANGELOG.md` file are also exempt, because they do not change after a
   release. `scripts/comparison-names.test.ts` reads the names from the data file and fails on a
   name in any other tracked file.
2. **Benchmarks stay private.** A comparison page states qualitative facts only. It gives no
   performance number, no throughput, and no latency. Benchmark results stay in the private
   operations repository and in Linear.
3. **Docs pages, not posts.** This decision amends ADR 0052. A comparison is a docs page in the
   "Compare" group: the hub at `/docs/compare` and one page for each product at
   `/docs/compare/<product>`. The blog keeps the other long-form content.
4. **One data file.** `site/comparisons.json` holds every fact. `<ComparisonTable />` renders the
   hub matrix and `<ComparisonTable product="<slug>" />` renders the table of one page. The agent
   Markdown export renders the same tables as Markdown. A page does not state a cell fact in its own
   text that the data file does not hold.
   `llms.txt` lists the comparison pages, but `llms-full.txt` leaves them out. An agent that
   integrates Workhorse does not need the product matrices, and each new page would make every
   download of the full file larger.
5. **Sources and versions.** Each competitor cell has a value, a source URL, the competitor version,
   and a short quote or code reference from the source. The source is the competitor's own
   documentation or source code. A GitHub source names a release tag or a commit, not a branch. All
   cells of one product use the version of that product, and the page shows that version and the
   date of the last check.

   One exception applies. If the OpenTelemetry project publishes an instrumentation package for a
   product, the OpenTelemetry cell of that product can cite the package. The note of the cell must
   name the OpenTelemetry project as the publisher. No other third-party source is permitted.

   One status rule applies to every OpenTelemetry cell, also when the product supplies the support
   itself. If the cited source shows traces and metrics, the status is "Supported". If it shows
   traces only, the status is "Partial", and the note starts with "Traces only."

6. **The Workhorse column.** Each Workhorse status uses the status words of `docs/features.md` and
   `docs/parity.md`, and names the row that it restates. The schema test fails when the two
   disagree.
7. **Fairness.** Each page has three sections in this order: the evaluation, "When X is the better
   choice", and "Move from X". The rows include facts where the other product is stronger. A
   competitor cell says "Not supported" only when its source shows the absence. The text uses no
   superlatives.
8. **Wording.** The pages follow ADR 0051. They describe Workhorse as a durable task queue with its
   three claims. They do not use "durable execution" or "exactly-once" for Workhorse. A page for a
   workflow platform starts with the difference between the two categories and does not call
   Workhorse a substitute.
9. **Upkeep.** Each published page has a recurring quarterly check issue in Linear. The check
   confirms every cell against the newest release, then changes the version and the date. No test
   checks the date.
10. **Free and paid editions.** A competitor cell states the free edition of the product. If a paid
    edition, a paid license, or a managed service of the product reaches a higher status, the cell
    also names it in a `paid` field with its status. The tables and the Markdown export show both,
    for example "Partial; Supported with Sidekiq Enterprise". The note of the cell names the paid
    edition, and the cell source supports it. The license note of each product names each paid
    edition or managed service, or says "No paid edition". The schema test fails when a paid status
    is not higher than the free status, or when a note does not name the edition.
11. **Status rules for the limit rows.** The rows "Concurrency limits" and "Rate limits" use four
    rules. Each limit cell note states its scope: one process, one queue, or each key.
    - A limit that applies to one process only is "Not supported", because the row compares limits
      across all workers.
    - "Supported" needs a limit for a queue and a limit for each key, both across all workers. A
      product with only one of the two scopes is "Partial". A constant key is not a queue limit.
    - A limiter that the job code calls itself is "Partial", also when it works across all workers.
      The task starts first, and then it fails or reschedules.
    - Rule 10 applies to all rows: a cell states the free edition. Thus, a cell is "Not supported"
      when only a paid edition has the feature, and the `paid` field gives the status of that
      edition.

## Considered options

- **Keep all names private.** This keeps the old rule, but a reader then compares the products
  without our facts and without sources.
- **Publish comparisons as blog posts.** A post is dated and does not get a schedule for checks. The
  facts in it become false and nothing shows it.
- **Permit names everywhere.** A name in a guide or in code is where a benchmark result starts to
  leak. Two permitted places are easy to check.

## Consequences

A comparison page is one MDX file and one entry in `site/comparisons.json`. The hub and the sidebar
read the data file, so a new page needs no other shared change. Each page costs one check each
quarter. A product with a hub row and no page has a planned entry that names the Issue for its page.
