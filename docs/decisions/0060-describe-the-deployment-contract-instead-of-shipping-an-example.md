# ADR 0060: Describe the deployment contract instead of shipping a deployment example

- **Status:** Accepted
- **Date:** 2026-09-03
- **Related:** [ADR 0053](0053-start-migrations-at-0-1-0-and-keep-them-additive.md),
  [WH-640](https://ontrack.sh/projects/WH/issues/WH-640),
  [WH-641](https://ontrack.sh/projects/WH/issues/WH-641),
  [WH-645](https://ontrack.sh/projects/WH/issues/WH-645)
- **Supersedes in part:** the ADR 0044 clause "Keep parameterized examples and generic deployment
  guidance in this repository"

## Context

ADR 0044 extracted the live Kamal configuration into a private operations repository and kept
parameterized copies here. The copies were meant to show a reader how the applications are
deployed without exposing the topology that deploys them.

They did not read as copies. `scripts/deploy.sh`, `scripts/deploy-site.sh`,
`scripts/deploy-demo.sh`, `scripts/kamal-env.sh`, `scripts/setup-kamal.sh`, `config/deploy.yml`,
`config/deploy.site.yml`, `.kamal/secrets`, `.kamal/hooks/demo/pre-deploy`, and a pinned Kamal
bundle sat in the ordinary places, under the ordinary names, executable, and complete. Nothing in
any of them said they deploy nothing.

The cost came due in WH-640. A documentation fix landed on `main` and the deploy that followed
republished the previous revision, because the source checkout it built from was one commit behind.
The fix for that gap was first written against `scripts/deploy-site.sh` in this repository, which
cannot affect any deployment, before the live path in the operations repository was found. A reader
looking for the deploy finds the copy first, because the copy is what a deploy looks like.

The copies had also begun to drift. The two `pre-deploy` hooks differed in their commentary and in
the configuration path they passed to Kamal, and nothing compared them. A drifting example is worse
than none, because it still reads as authoritative.

The live deploy consumes only `Dockerfile`, `Dockerfile.site`, and the files they copy. Its Kamal
configuration points `context` and `dockerfile` at the source checkout and overrides `secrets_path`
and `hooks_path` to the operations repository's own. Every other deployment file here was inert.

## Decision

Delete the deployment orchestration from this repository. Keep `Dockerfile`, `Dockerfile.site`, and
`deployment/site.conf`, which the live deploy builds.

Document the deployment contract rather than an implementation of it.
`typescript/demo/DEPLOYMENT.md` states what an image must contain, what the schema step requires,
and what configuration a deployment must supply. It ships no runnable deployment configuration, so
there is nothing to mistake for the live path and nothing to drift.

Assert a contract where it is executed. The ADR 0053 rule that the schema step runs from the
pipeline is verified against the hook that actually runs, in the operations repository. This
repository keeps the half of that rule it owns: the demo's container entry point does not prepare
its own schema.

## Consequences

A reader who wants to deploy Workhorse gets requirements instead of a file to copy. That is more
work for them and it is honest: the copy they would have taken was never exercised by any
deployment, so its correctness was never established.

Deployment changes stop being possible in this repository. Anything that alters how the
applications are deployed happens in the operations repository, and a change here reaches a
deployment only through `Dockerfile`, `Dockerfile.site`, and what they copy.

The exposure boundary ADR 0044 drew gets stronger rather than weaker. Fewer files here describe
production shape, so there is less to review for topology leaks and less to keep parameterized.

ADR 0044's other decisions stand. Only its instruction to keep parameterized deployment examples is
superseded.
