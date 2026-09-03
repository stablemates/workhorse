# Committed public API snapshots

Each file here records one language's public surface as it stands on this commit. A pull request
that removes a name, renames one, or narrows a type changes a file here, so the change is visible in
review and the check names it. [ADR 0054](../docs/decisions/0054-define-what-1-0-0-promises.md)
defines the three surfaces, and Gate 1 of
[ADR 0056](../docs/decisions/0056-set-the-1-0-0-exit-criteria.md) requires the checks.

| File             | Surface                                                         | Check                       | Generator                      |
| ---------------- | --------------------------------------------------------------- | --------------------------- | ------------------------------ |
| `typescript.txt` | Every published package's `exports` map and shipped `.d.ts`     | `pnpm typescript-api:check` | `pnpm typescript-api:generate` |
| `python.txt`     | Every public `workhorse` module's `__all__`                     | `pnpm python-api:check`     | `pnpm python-api:generate`     |
| `go.txt`         | Exported identifiers of the Go module's non-`internal` packages | `pnpm go-api:check`         | `pnpm go-api:generate`         |

These are generated artifacts. Do not edit one by hand: run its generator and commit what it wrote.

## Reading a failure

The check prints the lines that went and the lines that arrived. A line that went is the interesting
half, because a removal, a rename, and a narrowing all read as a line disappearing. A line that only
arrived is an addition, which is not breaking, and running the generator is the whole fix.

## Why the Go file has a different shape

`typescript.txt` and `python.txt` describe the surface. `go.txt` describes the accepted **breaks**
in it, because Go's standard for a break is what `apidiff` reports and `apidiff` compares two
module versions rather than reading a description. So the file pins the published tag the comparison
starts from and lists every incompatible change accepted since it. While the line is `0.x` a minor
may break, so an accepted list is what honesty looks like; a break that is not listed fails the
check. Publishing a `go/vX.Y.Z` tag and running the generator re-pins the baseline and empties the
list.

The baseline is pinned as data rather than looked up because CI checks out without tags. The
generator is the only half that reads Git, and it refuses to write a file with no baseline: a
comparison against nothing would pass every removal silently, which is what these checks exist to
prevent.

## What the snapshots do not cover

A declaration a dependency owns is named without its members. `Pool` comes from `pg`, and its shape
moves with a dependency range rather than with a release here; "Moving a dependency range" in
[`docs/compatibility.md`](../docs/compatibility.md) governs that move. Nothing here says whether an
API is experimental either — the Experimental table in that document is the only authority.
