# Commits and pull requests

This page tells an agent how to make commits and pull requests in Workhorse. Read it before you commit, open or update a pull request, or write a review brief.

## Sign agent commits with the model

A commit an agent makes ends with one `Co-Authored-By:` trailer per model that produced the change,
naming the exact model ID. That trailer is the message's only agent attribution: it names no
harness, product, or session.

```
Co-Authored-By: <exact-model-id> <noreply@anthropic.com>
```

## Keep an agent pull request to one commit

A squash merge puts every commit message on the branch into the body of the commit on `main`. One
commit keeps that body a single current message with correct trailers.

An agent's pull request branch holds exactly one commit on top of its base. Review, CI, and
follow-up changes amend that commit. When the base moves, rebase onto it and keep one commit.

On each amend, rewrite the message to describe the whole change, not the first iteration. Keep
one trailer per model that produced any part of the change.

After an amend or rebase, the agent may push with `git push --force-with-lease` to its own pull
request branch. Never force-push `main` or another contributor's branch. If someone else pushed to
the branch, ask a maintainer before rewriting it.

Never put the skip-CI marker in a pull request commit, title, or description, or in a release
candidate commit. The only place for it is the squash message of a docs-only merge. See
[`ci-and-releases.md`](ci-and-releases.md).

Amending discards the intermediate commits. Record verification evidence in the pull request
description instead.

## Write commit messages and pull request descriptions as documentation

Commit messages and pull request descriptions follow
[Simplified Technical English](simplified-technical-english.md). They use the terms `GLOSSARY.md`
defines and follow
[Keep benchmark comparisons private](demo-deployment-and-benchmarks.md#keep-benchmark-comparisons-private).

A commit message has no Markdown headings, because the squash merge copies it into `git log` on
`main`. The subject is a plain imperative summary, about 72 characters long.
The body wraps at 72 columns and states why first, as a short scenario when behavior changes. Then
it states what changes. Verification and review stay out of the message, in the pull request
description. The trailers follow the body.

A pull request description uses these headings in order, as `.github/pull_request_template.md`
lays out:

1. `Why`: the problem, as a short scenario in time order when behavior changes.
2. `What changes`: the change as a whole.
3. `Verification`: the exact commands and results, and what was not run and why.
4. `Review`: each review round and its outcome.
5. `Follow-ups`: the work this change leaves for later issues.

An agent's attribution line comes last. When a follow-up change amends the commit, update the
description so it describes the whole change.

## Ask each review for the differences between the SDKs

Workhorse has seven SDKs, and they must keep one behaviour. A review of a diff does not find a
difference in code that the diff does not change. For example, after SM-1934 three groups of SDKs
logged a failed expiry request in three ways. A table in `docs/architecture/lifecycle.md` recorded
the difference. Three review rounds and the Greptile review did not question it.

This rule applies to a change to an SDK, a shared fixture, or a document about SDK behaviour. Put
this question in each review brief for such a change:

> List each place where the seven SDKs still differ after this change. Include behaviour, log
> records, errors, and documentation. For each difference, say whether a decision record, `docs/parity.md`,
> or the issue makes it intended.

Ask the question in each round, not only in the first round. A round that checks only the fixes of
the round before does not read the whole change again.

If a change documents a difference between SDKs, name that difference in the review brief. Also name
it under `What changes` in the pull request description. A reviewer reads a documented difference as a decision and does not
question it.
