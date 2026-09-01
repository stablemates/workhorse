# ADR 0045: Stage the first public beta release

- **Status:** Accepted
- **Date:** 2026-08-25
- **Related:** [Plane WH-440](https://ontrack.sh/projects/WH/issues/WH-23)

## Context

Python, npm, and Go publish independently, but users encounter them as one Workhorse beta. A
concurrent release would remove the chance to stop after one registry exposes a problem.

Each registry has different recovery limits. Test registries also use different identities and do
not prove that production provenance works.

## Decision

Publish the beta as one release train from the same source commit. Complete the train in one
controlled release window, but publish each language line separately.

Python publishes first because its single distribution provides the smallest production test of
trusted publishing. npm follows, with `@stablemates/workhorse` before its eight peer dependents.
Go publishes last because public module proxies can retain a tag permanently.

Rehearse only after public CI passes for the candidate commit. Manually dispatch
`.github/workflows/release.yml` and `.github/workflows/release-python.yml` with `dry-run` enabled.
Download and inspect every archive from those runs. Install every npm tarball and both Python
distribution formats into clean consumers. Build the Go external consumer from the same commit.
Do not use test registries.

After each publication, verify the version through its production registry. Verify provenance or
the module checksum, install the exact public version in a clean environment, and run a minimal
enqueue-and-worker smoke test against a fresh PostgreSQL database. All nine npm packages must pass
before the Go stage starts. Any failure stops the train.

Never reuse a published version. For an ordinary defect, leave the artifact available and publish
a higher fix. For a security, secret, privacy, or legal exposure, remove or disable distribution
where possible and rotate or revoke affected credentials. Also deprecate the npm release, yank the
PyPI release, or retract the Go version as appropriate.

## Consequences

The public beta can be temporarily incomplete if a stage fails. This is preferable to exposing the
same defect through all three registries.

Registry removal does not reverse prior access. Incident response treats every published artifact
as permanently observable, even when its registry later hides it.
