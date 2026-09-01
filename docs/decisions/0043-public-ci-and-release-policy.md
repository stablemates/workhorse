# ADR 0043: Run latest-version CI continuously and compatibility checks on schedules

- **Status:** Accepted
- **Date:** 2026-08-25
- **Related:** [Plane WH-438](https://ontrack.sh/projects/WH/issues/WH-278)

## Context

The public repository must accept pull requests from forks without exposing secrets or trusted
runners. The support contract spans Node.js, Python, Go, and PostgreSQL. Its full cross-product
would make pull request feedback slow, while shared runners cannot produce trustworthy benchmarks.

Standard GitHub-hosted runners are free and unlimited for public repositories. Artifact and cache
storage still use the repository quota, so free compute does not justify retaining every artifact.

## Decision

`.github/workflows/ci.yml` runs on pull requests to `main`, pushes to `main`, daily and weekly
schedules, and manual dispatches. Pull requests and pushes test each language at its newest
supported version against the newest PostgreSQL. The weekly schedule tests every language and
PostgreSQL combination in `support.json`. The daily schedule runs only the packed-install test on
the newest Node.js version. A manual dispatch runs the latest-version lanes and the packed test.

Fork pull requests use `pull_request`, standard GitHub-hosted runners, and a read-only
`GITHUB_TOKEN`. CI receives no secrets and never uses `pull_request_target`. GitHub must require
maintainer approval before any outside collaborator's workflow runs.

The branch ruleset for `main` requires a pull request and the single `CI / required` check. That
aggregate job fails when any job selected for that trigger fails. It accepts deliberately skipped
jobs, so packed installs can stay out of pull requests and pushes while language lanes stay out of
the daily packed run. Demo and site smoke tests are temporarily excluded because their full build
dominates CI time. This stable name keeps matrix changes from invalidating branch protection.

Each language matrix runs at most two lanes concurrently. The cap limits database contention during
the weekly compatibility run without affecting the single-lane pull request and push feedback.

`.github/workflows/benchmark.yml` runs smoke benchmarks weekly and on manual dispatch. It is
informational and is not a required check because timing on shared hardware is not comparable. The
benchmark selects workspace source exports so the adapter and core share one telemetry provider.

npm and Python publication run only from matching version tags. Separate `npm` and `pypi`
environments require an explicit review, disallow administrator bypass, and accept only their
release tag patterns. When two eligible maintainers exist, the reviewer must differ from the person
who pushed the tag and the environment must disallow self-review. While only one eligible maintainer
exists, the environment may allow that maintainer to approve their own deployment so the review
gate remains usable. Manual dispatches build and validate artifacts but never publish them.
Maintainers create release tags; repository rules must prevent other actors from creating or
updating them.

The Python workflow first requires a successful `main` push CI run for the tagged commit. Its
focused release gate checks the Python version contract, embedded dashboard bundle, format, lint,
types, dependencies, and complete test suite against PostgreSQL. It builds the wheel and source
distribution once, tests those exact files in clean consumers, and passes the unchanged artifacts
to the protected publication job. Go, TypeScript database, documentation, parity, site, and demo
checks remain merge gates in CI and do not run again during Python publication.

Go stays local through `scripts/release-go.sh`. A Go module becomes public when its tag is pushed,
so a workflow triggered by that tag cannot gate publication. The script runs the full release gate
before it creates and pushes the annotated tag.

## Consequences

Pull requests and pushes get fast latest-version feedback rather than exhaustive support proof. The
weekly run checks older supported combinations, and the daily packed run detects assembly or clean
consumer installation regressions without adding ten minutes to every change.

GitHub Actions remain disabled until the repository is public. When it becomes public, maintainers
must enable Actions, create the two protected environments, add the branch and tag rulesets, and
set outside-collaborator workflow approval before accepting external pull requests or release tags.

## References

- [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Managing GitHub Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
- [Deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
