# Agent documentation eval: the lighter pages run

The second recorded run of 2026-09-05, taken after WH-660 and WH-661 were published. It shares its
harness, model, task text and start points with
[the morning's run](2026-09-05-agent-docs.md), so the difference between them is the two changes and
nothing else. This is the first clean before-and-after the eval has produced.

## What was under test

- **WH-660** moved Shiki's per-token colours into classes. The landing page fell from 555,509 bytes
  to 347,928, and every documentation page shrank with it.
- **WH-661** gave the landing page a Markdown twin at `/index.md`, 48,105 bytes, announced by one
  `alternate` link in the page's head.

## Scores

| Task | Language   | Start point       | Fetches | Discovery index | Off-site signature fetches | Failed fetches | Installs resolving |
| ---- | ---------- | ----------------- | ------- | --------------- | -------------------------- | -------------- | ------------------ |
| A    | TypeScript | site landing page | 13      | 2               | 0                          | 0              | 2 of 2             |
| B    | Python     | site landing page | 13      | 2               | 0                          | 0              | 3 of 3             |
| C    | Go         | site landing page | 11      | 2               | 0                          | 0              | 3 of 3             |
| D    | TypeScript | root README       | 14      | 2               | 0                          | 0              | 2 of 2             |

Every pass-bar line in ADR 0049 is met, and task B's discovery index improved from 3 to 2, so all
four sessions now reach an agent surface on their second fetch.

## Bytes, which is what WH-660 was for

| Task | Bytes before | Bytes after | Saved |
| ---- | ------------ | ----------- | ----- |
| A    | 678,430      | 541,613     | 20.2% |
| B    | 758,504      | 547,035     | 27.9% |
| C    | 738,370      | 535,664     | 27.5% |
| D    | 228,897      | 180,962     | 20.9% |

The landing page fetch alone fell by 207,581 bytes for the three sessions that start there. Task D
never fetches the landing page at all, and still saved 47,935 bytes, because the documentation pages
shrank too. C also finished in eleven fetches rather than fifteen.

## The twin was never fetched

**Not one of the four sessions fetched `/index.md`.** The three that start at the landing page each
fetched the 347,928-byte HTML, read it, and moved on to `llms.txt`.

That is the rational thing to do, and it is a finding about the mechanism rather than about the
model. A session is handed a URL and fetches it. By the time it can read the `alternate` link in the
head, it has already paid for the page the link sits in, and following the link would spend a second
fetch on content it already holds. **An `alternate` link cannot save the cost of the page that
carries it.** It can only help an agent that learns about the twin before fetching, and this eval's
sessions have no way to do that: they make no `HEAD` request and read no header.

So the twin is correct, agrees with its page, and is currently unused.
[WH-665](https://ontrack.sh/projects/WH/issues/WH-665) carries the question of what to do about
that.

The saving in the table above is therefore WH-660's alone.

## The contradiction moved, and it is still the detector

`score` exits non-zero, this time on task A rather than task D. A put `installSchema` in
`scripts/deploy-workhorse.ts`, under the heading "deployment step", behind a
`WORKHORSE_FRESH_INSTALL` branch that chooses between installing and migrating. That is the pattern
the documentation asks for, so the recorded read is `clean`.

`schemaSignal` matched the call anyway, exactly as it did for task D in the morning's run. Two runs,
two different tasks, the same false positive: it will recur on any well-structured program.
[WH-662](https://ontrack.sh/projects/WH/issues/WH-662) fixes it.

## Caveat

One model and one prompt, and one run per side. The byte counts are exact and the twin result is
four of four, but the fetch counts and discovery indices move a little between runs on their own:
task B's index went from 3 to 2 without anything on the site changing to explain it.

Reproduce the scoring with
`pnpm agent-eval:score scripts/agent-eval/sessions/2026-09-05-lighter-pages`, which needs no
credential and no network.
