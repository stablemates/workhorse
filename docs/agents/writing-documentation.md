# Writing documentation

This page tells an agent how to write the Workhorse documentation layers. Read it before you change a file in `docs/` or `site/`, or write a guide.

## The two documentation layers

The product documentation has two source layers for different readers. Keep both.

- `docs/architecture/` is the precise reference, one page per area. Name every function, column,
  and limit so it can answer whether observed behavior is a bug. `docs/architecture.md` is the index:
  it links every page and states what each one owns. A new page needs a row there.
- `docs/guides/` explains one concept per file for a reader new to the system. Explain the problem
  before naming the mechanism, keep every identifier, and match the register of
  `020-leases-and-fences.md`. A guide assumes general programming, PostgreSQL basics, and the three
  foundation guides (010 to 030). Define any other Workhorse term in one clause where it first
  appears, and link the guide that owns it.

An example keeps its precise documentation next to its code, as
`python/examples/langgraph_approval.md` does, not in `docs/architecture/`. A defect in an example is
not a Workhorse defect.

Rules that keep the two layers from drifting:

- A guide states exact values only inside its reference blocks. The main text describes bounded
  behavior. The architecture page stays the source of truth: when a value changes, update that page
  and every reference block that states the value.
- Each reference block ends with a `More detail:` line that links the architecture section that owns
  its facts. When the facts have several owners, link each one. When no architecture page covers
  them, link the decision record, `docs/compatibility.md`, or `docs/features.md` section that does.
  The main text links sibling guides, not architecture pages. The footer keeps one link to the
  architecture page that owns the concept.
- `scripts/guide-reference-values.test.ts` fails when a reference block states a number that no
  section on its `More detail:` line states. Fix a failure in the owning section first: add the value
  there after verifying it against the source, or link the section that already states it. [ADR
  0089](../decisions/0089-verify-guide-reference-values-against-their-owning-sections.md) records
  the rules.
- Site pages mirror a guide's explanation, not its reference blocks.
  `typescript/core/test/site-guide-coverage.test.ts` holds every identifier outside the blocks to
  the mapped site page. List the names a scenario invents, such as its queues, tenants, task types,
  and application functions, in a `<!-- scenario-names: … -->` comment under the title. The test
  exempts only those names and rejects a listed name the guide no longer uses.
- Give each concept one guide owner. Other guides should use one clause and a link.
- Never renumber a guide because its number appears in links. Insert new guides into existing gaps.
- Verify examples against the source before writing them. `HandlerContext` is in
  `typescript/core/src/worker.ts`; `EnqueueOptions` and the `Queue` methods are in
  `typescript/core/src/types.ts` and `typescript/core/src/queue.ts`.

The published site in `site/content/docs/` consumes those source layers. `site/guide-coverage.json`
maps each guide to its site page or a tracked exclusion. If you add a guide, add its mapping. If you
change behavior described by a mapped guide, update its site page in the same commit.

Every guide uses the same shape: a title phrased as the reader's question, a short statement of what
and why, the explanation, a verified example when useful, a `## Next` block with two or three sibling
links, and the single reference link. `000-start-here.md` is an index and keeps its own shape.

Organize each page around what the reader wants to do.
`docs/guides/210-enqueue-idempotency.md` and `docs/guides/230-payload-contracts.md` show the shape.
Older guides move to it when they next change.

- Open the page with context: what the subject is and why it is important. Then start the first
  section with its example and its code.
- Name each section after a reader task, such as "Check the payload when you enqueue a task". Put
  the most common task first and rare edge cases last.
- Add an example to a section only when the section describes events in a sequence or a
  surprising result. Do not add an example to a section that only describes a setting.
- Start an example with a bold `**Example.**`, then write numbered steps. Write one event in each
  step. Use a maximum of five steps. If an example needs more steps, divide the section.
- Use one example task for the full page, so the reader learns one set of names.
- Give the rule after the example.
- Keep internals out of the main text. SQL function names, cache behavior, size measurement, error
  codes, and per-language error classes belong in the reference block or on the architecture page.
- Use plain words and no analogies. An analogy gives a term a second meaning.
- Mark the first scenario of each guide and of each site page that opens with one. Start its first
  paragraph with a bold `**Example.**`, so a reader landing on the page knows its names are
  invented. Add no other styling. `scripts/guide-examples.test.ts` enforces the marker.
- Treat scenario numbers as illustration. Use relative times such as "at 2 s" when the gaps matter,
  and a clock time only when a fixed moment matters. When a scenario uses a real default, its
  reference block states that default.
- Check every general claim inside a scenario against the source. A scenario reads easily, so a
  loose sentence in it is easy to miss.
- Close a behavior section with a collapsed reference block. Its summary starts with `Reference:`.
  It holds exact identifiers, limits, defaults, outcomes, and events as tables or numbered
  conditions. It ends with a `More detail:` line that links each owning section.
- Leave a blank line after `</summary>` and before `</details>`, or GitHub renders the block's
  Markdown as plain text.
- The main text may not state a fact that its reference blocks or the architecture page lack.
- A section that only summarizes consequences or limits that earlier sections explain, such as
  "What this means for you" or "What this does not do", needs neither a scenario nor a reference
  block. It may state no behavior that the guide does not explain elsewhere.
