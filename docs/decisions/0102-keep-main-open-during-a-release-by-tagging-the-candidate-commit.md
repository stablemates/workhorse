# ADR 0102: Keep main open during a release by tagging the candidate commit

- **Status:** Accepted
- **Date:** 2026-10-13
- **Amends:** [ADR 0059](0059-assemble-the-1-0-0-specification.md) (the release train rule that no
  commit lands on `main` between the first tag and the last)
- **Issue:** SM-1293

## Context

The release train publishes one version from one source commit, the candidate commit. ADR 0059 and
`docs/compatibility.md` said that no commit lands on `main` between the first tag and the last. The
purpose of that rule was that every tag names the candidate commit.

No script or workflow needs `main` to stay closed:

1. `release.yml` and `release-python.yml` build and publish `$GITHUB_SHA`, the commit that the tag
   points to. They require a successful `main` CI push run for that commit.
2. `scripts/release-go.sh` builds and tags `HEAD` of the local checkout.
3. No release script reads the tip of `main`.

During the 0.8.0 release, `main` stayed closed for some hours. Pull requests that were ready could
not merge.

## Decision

Every tag of the release train points to the candidate commit, which is a commit on `main`. Other
commits can land on `main` during the release.

1. The maintainer creates each tag on the candidate SHA, for example
   `git tag --annotate vX.Y.Z <sha>`. The maintainer does not tag the current tip of `main`.
2. The maintainer runs `scripts/release-go.sh` from a clean, detached checkout of the candidate
   commit.
3. Before its long checks, `scripts/release-go.sh` fetches `main` from origin. It refuses to
   continue if `HEAD` is not an ancestor of `origin/main`.
4. It also refuses to continue if `vX.Y.Z` or `python/vX.Y.Z` on origin is missing, or points to a
   commit other than `HEAD`. It peels an annotated tag to its commit.
5. Nobody may cancel the `main` CI push run of the candidate commit, because the release workflows
   require that run to succeed.

The other options were a release branch and a workflow that pushes the Go tag. A release branch
adds a second line of commits that CI and the release check must also cover. A Go tag workflow
moves a step that works now. Neither was necessary to keep `main` open.

## Consequences

`main` stays open during a release. The Go tag cannot name a commit other than the one that the
npm and Python tags name, because the script compares the three. The npm and Python tags still
depend on the maintainer giving the correct SHA. Their workflows refuse a commit without a
successful `main` CI push run, and the Go step refuses tags that do not agree.
