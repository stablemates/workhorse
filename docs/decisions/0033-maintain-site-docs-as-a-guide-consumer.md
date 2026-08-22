# ADR 0033: Maintain site documentation as a guide consumer

- **Status:** Accepted
- **Date:** 2026-08-16
- **Related:** [ADR 0028](0028-flat-per-language-repository-layout.md)

## Context

Workhorse has a precise reference in `docs/architecture.md` and beginner guides in
`docs/guides/`. The site also contains hand-written MDX pages for the published documentation.

The site pages use web navigation, frontmatter, public links, and examples that differ from the
repository guides. Generating those pages would either discard that structure or require a
second template language inside the guides.

Nothing previously required a new guide to reach the site. The site fell behind by a full feature
wave while its build and type checks continued to pass.

## Decision

The site remains hand-written. It is a required presentation of the two source layers rather than
a third owner of product behavior.

`site/guide-coverage.json` maps every guide to a site page. A guide may instead name a
tracked exclusion while its site coverage is pending.

`typescript/core/test/site-guide-coverage.test.ts` compares the manifest with the guide directory.
It rejects missing guides, stale entries, duplicate entries, absent pages, and exclusions without
a Linear issue identifier and reason.

If a change affects behavior described by a mapped guide, the same commit updates its mapped site
page. If a contributor adds a guide, the same commit adds a mapping or a temporary tracked
exclusion.

## Consequences

- New guides cannot silently disappear from the published documentation backlog.
- Site authors keep layouts and examples that fit the web reader.
- Reviewers must enforce content parity for existing mappings because a structural test cannot
  prove that two explanations mean the same thing.
- Tracked exclusions make known gaps explicit, but the linked issue must remove them when it adds
  the corresponding pages.
