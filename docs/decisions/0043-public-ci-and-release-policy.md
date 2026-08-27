# ADR 0043: Run boundary CI before merge and the full support matrix on main

- **Status:** Accepted
- **Date:** 2026-08-25
- **Related:** [WH-438](https://app.plane.so/techprogress/browse/WH-438/)

## Context

The public repository must accept pull requests from forks without exposing secrets or trusted
runners. The support contract spans Node.js, Python, Go, and PostgreSQL. Its full cross-product
would make pull request feedback slow, while shared runners cannot produce trustworthy benchmarks.

Standard GitHub-hosted runners are free and unlimited for public repositories. Artifact and cache
storage still use the repository quota, so free compute does not justify retaining every artifact.

## Decision

`.github/workflows/ci.yml` runs on pull requests to `main`, pushes to `main`, a nightly schedule,
and manual dispatches. Pull requests test the oldest language against the oldest PostgreSQL and
the newest language against the newest PostgreSQL. Go has one supported language line, so its pull
request lane runs against the newest PostgreSQL. Pushes, schedules, and manual runs test every
language and PostgreSQL combination in `support.json`.

Fork pull requests use `pull_request`, standard GitHub-hosted runners, and a read-only
`GITHUB_TOKEN`. CI receives no secrets and never uses `pull_request_target`. GitHub must require
maintainer approval before any outside collaborator's workflow runs.

The branch ruleset for `main` requires a pull request and the single `CI / required` check. That
aggregate job fails unless static checks, unit tests, every trigger-specific matrix lane, runtime
smoke tests, packed installs, and demo and site smoke tests pass. This stable name keeps matrix
changes from invalidating branch protection.

`.github/workflows/benchmark.yml` runs smoke benchmarks after pushes to `main` and nightly. It is
informational and is not a required check because timing on shared hardware is not comparable.

npm and Python publication run only from matching version tags. Separate `npm` and `pypi`
environments require a reviewer other than the person who pushed the tag, disallow self-review and
administrator bypass, and accept only their release tag patterns. Manual dispatches build and
validate artifacts but never publish them. Maintainers create release tags; repository rules must
prevent other actors from creating or updating them.

Go stays local through `scripts/release-go.sh`. A Go module becomes public when its tag is pushed,
so a workflow triggered by that tag cannot gate publication. The script runs the full release gate
before it creates and pushes the annotated tag.

## Consequences

Pull requests get bounded feedback rather than exhaustive support proof. A merge to `main` runs
the full matrix, and the nightly run detects dependency or runner-image drift without a source
change.

GitHub Actions remain disabled until the repository is public. When it becomes public, maintainers
must enable Actions, create the two protected environments, add the branch and tag rulesets, and
set outside-collaborator workflow approval before accepting external pull requests or release tags.

## References

- [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Managing GitHub Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
- [Deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
