# CI and releases

This page tells an agent how CI runs on `main`, when to cancel or skip a run, and how to read a failure. Read it before you merge, cancel a run, or investigate a CI failure.

## Expect canceled CI runs on main

CI costs money for each run. Maintainers and agents cancel CI runs on `main` to decrease that cost.
CI cancels an older run automatically only on a pull request, so each push to `main` starts a run.

A push to `main` that is not a release runs only its lanes. The plan uses the files that the push
changes, as it does for a pull request (ADR 0083). A push runs the release lanes when it changes a
release file: a `package.json`, a version file, `sql/releases/`, or a release workflow.
`RELEASE_FILES` in `scripts/ci-lanes.ts` lists them. A `CHANGELOG.md` is a release file only for a
change outside its `## Unreleased` section. Thus a fix that adds an entry under `## Unreleased` runs
only its lanes. The release lanes are every push lane and the weekly `packed` lane, as
`RELEASE_PUSH_LANES` lists them. A push also runs the release lanes when the plan cannot decide. For
example, the plan cannot list the files after a force push, or it cannot parse a changelog.

The release workflows publish a commit only after a successful `main` push run that planned every
release lane. The plan job of each push run uploads its plan as the `lane-plan` artifact.
`scripts/check-main-ci-plan.ts` reads that artifact before any publish step. If the run skipped a
release lane, or the plan cannot be read, the release fails. Thus tag only the release candidate
commit.

- A canceled CI run on `main` is not a failure. Do not report it as a failure.
- Do not start a canceled run on `main` again, and do not wait for it.
- Use the checks of the pull request before the merge as the CI evidence for a merged change.
- If you merge a pull request and expect to merge more pull requests soon, you can cancel the CI
  run that the merge starts on `main`. Use `gh run cancel` with the ID of that run.
- Cancel only runs of the `CI` workflow on `main`. Never cancel a pull request run or a release
  workflow run, because a canceled publish can leave a release incomplete.
- Nobody may cancel the `main` CI run of a release candidate commit, because the release workflows
  require that run to succeed. Other commits can land on `main` during a release. Thus, check the
  commit SHA of a run before you cancel it.

Skip the `main` CI run of each docs-only merge. A docs-only change is a change in which every file
matches `DOC_PATHS` in `scripts/ci-lanes.ts`: `docs/**`, `site/**`, a root `*.md` file, or
`api/README.md`. Its pull request already ran each check that reads those files.

1. List the files of the pull request, with both paths of a renamed file:
   `gh api repos/{owner}/{repo}/pulls/<number>/files --paginate --jq '.[] | .filename, (.previous_filename // empty)'`.
2. Send that list to `pnpm --silent exec tsx scripts/ci-lanes.ts --docs-only`. It prints
   `docs-only` and exits 0 only for a docs-only change.
3. If the change is docs-only, put a `[skip ci]` line in the squash commit message, above the
   trailers. Do this for each docs-only merge.

Never add `[skip ci]` to a pull request, because then the `required` check never reports. Never add
it when the merge changes a file outside those paths or a `CHANGELOG.md` file. Never add it to a
release candidate commit, because the release workflows require a successful `main` CI run for the
tagged commit. If you do not know whether a maintainer will tag the commit, do not add it.

GitHub skips every push and `pull_request` workflow when the head commit message contains a skip
marker: `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`, or
`skip-checks: true`. Do not quote a marker in a commit message unless you want to skip CI. Keep
markers out of a pull request title and description too, because the squash message can copy them.
Write "the skip-CI marker" instead.

## Read a failed scheduled CI run

A scheduled CI run can fail at a commit that passed on push. The usual cause is a date-based test,
a flaky test, or a runner download error. Read the failed log before you change code:
`gh run view --job <id> --log-failed`.

## See the lanes that a change selects

`planLanes` in `scripts/ci-lanes.ts` decides which CI lanes run for a list of changed files. To see
the lanes for your local changes in a pull request, write a script outside the repository with the extension `.mts`. `scripts/ci-lanes.ts` uses top-level `await`, so the script
must be ESM.

```ts
import { planLanes } from "<checkout>/scripts/ci-lanes.ts";

const { plan, reason } = planLanes("pull_request", "", process.argv.slice(2));
console.log(reason);
console.log(
  Object.keys(plan)
    .filter((lane) => plan[lane])
    .join(" "),
);
```

Run it with the changed files: `pnpm exec tsx <script>.mts $(git diff --name-only origin/main)`.

A change to a file in `typescript/core/test` is a shared input
(`SHARED_INPUTS`), so it selects every lane that the event runs.
