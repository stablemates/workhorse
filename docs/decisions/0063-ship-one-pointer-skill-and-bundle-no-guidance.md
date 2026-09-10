# ADR 0063: Ship one pointer skill and bundle no guidance

- **Status:** Accepted
- **Date:** 2026-09-10
- **Related:** [ADR 0049](0049-publish-one-agent-documentation-layer.md),
  [ADR 0061](0061-record-the-agent-docs-eval-through-the-claude-cli.md),
  [ADR 0062](0062-negotiate-markdown-on-accept-and-publish-the-machine-readable-surfaces.md),
  SM-15,
  SM-566
- **Amends:** the ADR 0049 clause "Per-harness packaging stays undecided"

## Context

ADR 0049 left per-harness packaging undecided because no neutral page existed to package. The page
exists now. SM-582 rewrote `site/content/docs/for-ai-agents.mdx` as the playbook, and SM-583 gave
its prose identifiers a check that runs inside `pnpm typecheck`.

Two recorded eval runs measure the layer. The 2026-09-05 run met every pass-bar line: four of four
sessions reached an agent surface by their third fetch, resolved every install command, and
committed none of the three known mistakes. The 2026-09-09 run, recorded after ADR 0062, shows an
agent that sends `Accept: text/markdown` reading the twin on its first fetch. The URL layer works
for an agent that starts at the site or at the root README.

The eval measures no other start point. An agent working inside a repository that already depends
on Workhorse, asked to add a job and handed no URL, has nothing on the site to find it with. That is
the case a skill exists for: a harness loads it by its description when the task matches, before
any fetch. The survey recorded on SM-566 found every peer shipping one, six of seven through the
`npx skills add` registry, and none with evidence that it changed an outcome.

The freshness answers the peers found split by mechanism. Trigger.dev bundles guidance inside its
SDK package, so an upgrade carries the guidance with it. That works because one npm package holds
one language, and the installed skill is a pointer into `node_modules`. Restate syncs its skill
repository from its docs on a schedule. Convex compares installed files with remote hashes.
Workhorse publishes to three registries, only npm gives an agent a path into an installed package,
and every install surface it already governs is swept from one `support.json` catalog.

Generated site files are not tracked. `site/scripts/gen-docs-index.ts` writes `llms.txt`, `404.md`,
and the twins into `site/public/` at build time. A registry fetches the repository tree, so a file
that has to exist there cannot live in `site/public/`. `dashboard/v1/openapi.json` shows the
repository's pattern for that: a generator writes a tracked artifact, and a check fails when the
tracked file differs from what the generator produces.

Verified today, the playbook still states that a canonical HTML URL does not negotiate on `Accept`,
which ADR 0062 reversed. One source page drifted in five days. A second copy of its prose would
drift on its own schedule.

## Decision

**One skill ships, and it is a pointer.** `skills/workhorse/SKILL.md` is tracked in this repository
and installs with `npx skills add stablemates/workhorse`, which writes into every harness's skill
directory. The body carries the trigger description, the instruction to fetch
`/docs/for-ai-agents.md` first, the `.md` rule and the `Accept` rule, and the router's URL. It names
no SDK identifier, no install command, and no version. The playbook stays the one place that says
what to write.

**The generator writes it, and a check keeps the tracked file honest.** `gen-docs-index.ts` renders
the skill from the same page records that produce `llms.txt` and `404.md`, so it cannot name a page
nobody ships. The tracked file is the generator's output, and a check inside `pnpm typecheck` fails
when the two differ, the way `dashboard-spec:check` covers `openapi.json`. The skill joins the
governed list in `scripts/install-commands.test.ts` with no commands, so the no-version rule
reaches it. The identifier sweep from SM-583 stays bound to the page, because the skill names no
identifier for it to check. The owner is the site generator and `site/scripts/agent-surfaces.test.ts`.

**Freshness is the registry's hash and nothing of ours.** A pointer holds nothing that a release
changes. The only content that can go stale is a URL, and the generator resolves every URL against
a page record at build. The skills registry records a content hash in its lock file, which is the
mechanism Convex built by hand. This repository runs no sync and no scheduled job for the skill.

**No guidance is bundled inside an SDK package, and no managed `AGENTS.md` block ships.** Bundling
reaches one of three ecosystems and adds a copy per package. A managed block needs a CLI that writes
into the user's repository, and the `workhorse` CLI is TypeScript-only. Per-harness copies, a
Claude Code plugin marketplace entry, or Cursor rules add surfaces without evidence. An MCP server
stays out of scope, as SM-566 decided.

**The eval gains the start point the skill is for.** A fifth task starts inside a repository that
depends on the SDK and hands the session no URL, once without the skill and once with it. Its
result is the evidence this decision lacks. If the half without the skill already reaches the
playbook, the skill is kept because it costs one generated file. If the half with the skill fails,
this decision is reopened, and bundling into `@stablemates/workhorse` is the recorded next
candidate.

## Consequences

The three lines SM-566 held as not yet specified are answered. Packaging is a pointer skill through
the `npx skills add` registry. The drift check beyond the page is the generator check plus the
install sweep, and the identifier sweep is not extended to the READMEs or to the skill, because
neither names an identifier. The freshness mechanism is the registry hash.

An agent that installs the skill still pays one fetch to read the playbook. That is the trade: one
fetch against a second copy of the prose that would need its own sweep.

The tracked skill file is the first generated artifact under `skills/`. `oxfmt` either ignores it
or the generator writes what `oxfmt` accepts.

Execution is SM-702, which generates, checks, and publishes the skill; SM-704, which records the
repository start point with and without it; and SM-703, which corrects the stale `Accept` sentence
found while deciding this.
