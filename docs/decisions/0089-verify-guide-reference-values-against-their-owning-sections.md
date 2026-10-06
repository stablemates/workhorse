# ADR 0089: Verify guide reference values against their owning sections

- **Status:** Accepted
- **Date:** 2026-10-06
- **Related:** [ADR 0033](0033-maintain-site-docs-as-a-guide-consumer.md)
- **Issue:** SM-1148

## Context

SM-1146 rewrote the guides scenario-first. A guide now states exact values only inside collapsed
`Reference:` blocks. Each block ends with a `More detail:` link to the section that owns its facts,
and the architecture page stays the source of truth. Nothing checked that a block still agreed with
that section. A changed limit or default could leave a guide stating the old value.

Two designs were considered:

- **Generate.** Mark sections of the architecture pages and generate each guide block from them,
  with a `--check` mode like the other `scripts/generate-*.ts` scripts.
- **Verify.** Keep blocks hand-written and check each value a block states against the sections it
  links.

A block is not a copy of an architecture section. It selects the facts one guide section needs,
orders them for that reader, and often draws on two or three architecture sections. Generating
blocks would need a selection and layout language inside the architecture pages. That is the second
template language ADR 0033 declined for site pages. It would also tie the precise reference to
the structure of the guides.

The first run of a verify check found 80 of 220 blocks with a value that the linked section did not
state. Some linked a section that owned only part of the block's facts. Others stated a value that
no architecture section held, so the guide was the only record of it.

## Decision

Keep reference blocks hand-written and verify their values.

`scripts/guide-reference-values.test.ts` reads every guide in `docs/guides/`. For each `Reference:`
block it parses the Markdown and reads the text a reader sees, including code such as `max(100, n)`.
It collects every number in that text. It ignores ordered-list markers, link destinations, and the
digits of a name such as `UTF-8` or `retry_v1`. Letters after a number are its unit, as in `999ms`,
a version such as `0.200.0`, `v0.200.0`, or `1.0.0-rc.1` is one value, and `0..100` states both ends
of a range. A number keeps its minus sign, so `-1` and `1` are different values. Each number must
appear with the same sign in one of the sections that the block's `More detail:` line links. The
check reads that section with the same rules. A section runs from its heading to the next heading at
the same level or above. Thousands separators do not count, so `1,000` matches `1000` and `1_000`.
Emphasis markers around a number do not count either. Text after the `More detail:` line is checked
like the rest of the block.

The check also fails in these cases:

1. A block has no `More detail:` link.
2. A block links a section that does not exist.
3. A guide has a `Reference:` summary that the check cannot read as a block.

A `More detail:` line may link several sections when the block's facts have several owners. Every
value a block states must have one of them as its owner. When no section states a value, the fix is
to add the value to the owning section, verified against the implementation. The architecture page
stays the source of truth.

The check runs in `pnpm test`, so `pnpm check` and the CI unit lanes run it.

## Consequences

- Changing a value on an architecture page fails every guide block that still states the old value
  and links that page's section. The change and its guide updates land together.
- The check compares presence, not meaning. A block that states `100` passes when its section states
  `100` for an unrelated limit. Linking the narrowest owning section keeps that risk small.
- Identifiers are out of scope. A renamed identifier is not a value. The guides' identifiers outside
  reference blocks are held to the site pages by `site-guide-coverage.test.ts`.
- Values in the main text of a guide are scenario numbers, not product values, and are not checked.
- The architecture pages can still drift from the implementation. This check does not cover that.
