# ADR 0083: Run each language suite once per change and every variation weekly

- **Status:** Accepted
- **Date:** 2026-09-28
- **Amended by:** [SM-1138](https://linear.app/stablemates/issue/SM-1138)
  (Ruby's package check runs on every change),
  [SM-1548](https://linear.app/stablemates/issue/SM-1548)
  (a pull request runs a lane only when it changes an input of that lane),
  [SM-1681](https://linear.app/stablemates/issue/SM-1681)
  (a docs-only pull request runs only the lanes that check the documentation),
  [SM-1877](https://linear.app/stablemates/issue/SM-1877)
  (a pull request runs only the static steps that it needs),
  [SM-1878](https://linear.app/stablemates/issue/SM-1878)
  (a push to `main` runs only its lanes, except for a release file),
  [SM-1886](https://linear.app/stablemates/issue/SM-1886)
  (a release needs a push run that planned every lane),
  [SM-1887](https://linear.app/stablemates/issue/SM-1887) and
  [SM-1893](https://linear.app/stablemates/issue/SM-1893)
  (a changelog entry under `## Unreleased` is not a release change, and a release push also runs
  the `packed` lane)
- **Related:** [ADR 0043](0043-public-ci-and-release-policy.md),
  [ADR 0079](0079-govern-the-rust-api-as-an-eighth-surface.md),
  [SM-970](https://linear.app/stablemates/issue/SM-970)

## Context

ADR 0043 gives pull requests the newest supported combination and leaves the full matrix to a
weekly schedule. The language lanes applied that rule unevenly.

The Go lane ran its suite twice on every change: plainly and under the race detector. The Rust lane
ran its database suite twice, once with default features and once with `opentelemetry` and
`dashboard`. It also built and verified the crate package on every change. The Rust lane had no
PostgreSQL matrix, so the weekly run never tested it against older servers.

A change waits for its slowest lane. Each repeated run added minutes to that wait without testing
different product code on the newest combination.

## Decision

Pull requests and pushes run each language suite exactly once. That run uses the newest supported
language version, the newest PostgreSQL, and every optional feature the SDK offers. Format, lint,
type, API snapshot and generated-file checks still run on every change.

Every variation of a suite runs on the weekly compatibility schedule:

- the full language and PostgreSQL matrix for TypeScript, Python, Go and Rust;
- Go's suite under the race detector, through `pnpm go:test:race`;
- Rust's suite without optional features, through `pnpm rust:test:no-features`;
- a package check for each language.

A package check builds the artifact a registry would receive and installs it in a clean consumer.
TypeScript runs the packed-install test, Go runs `pnpm go:package-check`, and Rust runs
`pnpm rust:package-check`. These checks moved from the daily schedule and from pull requests. The
daily schedule is gone.

Python needs no separate weekly step. Its suite already builds the wheel and source distribution
and installs each in a clean environment, once bare and once per driver extra. That also covers
its only optional feature: none of those installs has OpenTelemetry, so the examples run on the
no-op telemetry path. Go and TypeScript make OpenTelemetry a required dependency, so they have no
variation without it.

_Amended by [SM-1138](https://linear.app/stablemates/issue/SM-1138)._ Ruby's package check,
`pnpm ruby:package-check`, runs on every change as well as weekly. It builds the gem and loads it
from a clean gem home within seconds, so it never sets the wait for a pull request. The development
bundle can supply a gem that the gemspec omits. The weekly run on 2026-10-04 found that the
published gem could not load on Ruby 4.0, because `logger` had left the default gems. The release
job checks the gem only on the Ruby that `mise.toml` pins. So without this step, no check before
publication loaded the gem on the newest supported Ruby.

_Amended by [SM-1548](https://linear.app/stablemates/issue/SM-1548)._ A pull request runs a
language lane only when it changes an input of that lane. Before this amendment, a change to one
guide ran the Go, Rust, Ruby, and JVM suites, and none of them read that guide.

`scripts/ci-lanes.ts` holds the lane-input map. The `plan` job of `ci.yml` reads it, lists the files
that the pull request changes, and gives each job one value that decides whether the job runs. The
map has these parts:

- Shared inputs run every lane. They are `.github/`, `scripts/`, `protocol/`, `sql/`,
  `dashboard/v1/`, `typescript/core/`, `api/telemetry.txt`, the generated SQL and dashboard
  catalogues of each SDK, the toolchain pins, `support.json`, and the root package files.
- Each filtered lane names its own inputs. A lane that builds the TypeScript packages also names
  `typescript/` and `dashboard/`.
- The `static`, `unit`, `npm-release-scope`, and `demo` lanes run on every change, because they
  check every language at once.
- Documentation, the site, and static-lane configuration run only those four lanes, unless a
  filtered lane names the file. For example, the Python lane names the guides and the site pages,
  because its tests import each Python example in them.

The map fails open. If the map names no entry for a changed file, every lane runs. If the plan
cannot list the changed files, every lane runs. A push to `main`, `workflow_dispatch`, and the
weekly schedule run every lane that their event runs, whatever changed.

The `required` job stays the one required check. It holds the result of each job to the plan. A
lane that the plan selects must succeed, and a lane that the plan skips must be skipped. A failed,
canceled, or unexpectedly skipped lane fails the check, and so does a failed plan.

`scripts/ci-lanes.test.ts` holds the map to `ci.yml` and to the repository. Each job of the
workflow must have an entry, and each entry must name tracked files. The test also scans the source
files of each filtered lane, and the scripts that the lane runs. Each tracked path that a source
writes in full must be an input of the lane. If that path is a TypeScript program, each module
that it imports must also be an input. If a source uses `docs`, `site`, or `benchmarks` as a
path part, the test lists the globs that the source reads, and the lane must name them. The scans
cannot find every read, for example a path that code builds from a variable. A contributor who adds
such a read must add the file to the lane's inputs.

A lane does not need to name an input of a check that an always-run lane also runs. For example,
the Rust lane runs `pnpm parity:check`, and the static lane runs the same check on every change.

_Amended by [SM-1681](https://linear.app/stablemates/issue/SM-1681)._ A docs-only pull request
runs only the always-run lanes that check the documentation. A change is docs-only if every file
matches `DOC_PATHS` in `scripts/ci-lanes.ts`: `docs/**`, `site/**`, a root `*.md` file, or
`api/README.md`. These lanes run, as `DOC_CHECK_LANES` names them:

- `static` runs `pnpm format:check`, `pnpm lint`, and `pnpm typecheck`, which read the site and
  the Markdown files.
- `npm-release-scope` runs the documentation tests of the unit scope, such as the guide reference
  values, the guide examples, the glossary, the comparison names, and the site guide coverage.
- `demo` builds the site, which checks the language examples of the guides and the site pages,
  and runs the site smoke test.

The `unit` lane runs only the unit tests that spawn the Python toolchain. None of them reads the
documentation, so a docs-only pull request skips it. A filtered lane that names a changed file as an
input still runs, for example the Python lane for a guide. A change that also has a file outside
`DOC_PATHS` runs every always-run lane. `scripts/ci-lanes.test.ts` holds the steps of each skipped
lane to a list, and fails when a test of the `unit` lane names the documentation.

The `packed` lane keeps `docs/**` and `site/**` as inputs, because its full build builds the site.
It is a weekly lane, so no pull request runs it.

The `required` job stays the one required check, and every pull request still runs CI. A pull
request never uses `[skip ci]`, because then `required` never reports. The squash commit of a
docs-only merge to `main` can contain `[skip ci]`, because its pull request already ran each check
that reads the documentation. It must not on a release candidate commit, because the release
workflows require a successful push run of CI for the tagged commit. AGENTS.md states the
procedure.

`pnpm rust:test` runs the whole Rust workspace once with `--all-features`. It replaces the pair of
runs that `rust:test` and `rust:integration` made in CI. `pnpm rust:integration` stays as a focused
local command and as the list of targets that parity evidence may cite. Every target it names also
runs under `rust:test`.

`pnpm check` still runs the race detector, and the release workflows still run their full release
checks. Neither gates pull request feedback. `pnpm go:release-check` now runs the release tag and
changelog checks, then the same staged-proxy check as `pnpm go:package-check`.

_Amended by [SM-1878](https://linear.app/stablemates/issue/SM-1878)._ A push to `main` plans its
lanes from the files that it changes, with the same map as a pull request. Before this amendment,
each push ran every lane. A maintainer then canceled most of these runs by hand to decrease the
cost. This amendment replaces the sentences above that say a push to `main` runs every lane and
every static step.

The `plan` job reads the `before` and `after` SHAs of the push event. It fetches the last 50 commits
of the pushed history and makes sure that the `before` commit is an ancestor of the pushed commit.
Then it lists the files that differ between the two commits. The rest of the plan is the same as
for a pull request. Thus a push runs only the lanes and static steps that its files select. A
docs-only push runs only the lanes that check the documentation.

The release workflows require a successful push run of CI for the tagged commit. They do not check
which lanes that run ran. Thus a push runs every lane in these conditions:

- The push changes a release file, as `RELEASE_FILES` in `scripts/ci-lanes.ts` names them. These are
  each `CHANGELOG.md`, each `package.json`, each file that `scripts/check-release.ts` reads for the
  release version, `sql/releases/`, and the release workflows. A release candidate commit changes
  every changelog, so its push run is always a full run.
- The `before` SHA is missing, is all zeros, or is not a commit SHA.
- The push creates the branch or is a force push.
- The `after` SHA of the event is not the commit that the job checked out.
- The `before` commit is not an ancestor of the pushed commit in the fetched history.
- The plan cannot read the event, fetch the history, or list the changed files.

A missed lane costs more than an extra lane, so each failure path runs every lane.
`scripts/ci-lanes.test.ts` plans the files of the 0.11.0 release candidate commit and each kind of
release file, and holds each file that `scripts/check-release.ts` names to a full run.

_Amended by [SM-1877](https://linear.app/stablemates/issue/SM-1877)._ The `static` lane still runs
on every change, but a pull request runs only the static steps that the change can affect. Before
this amendment, a Python-only change set up Java, .NET, Rust, and Ruby, and ran the JVM and .NET
lint, the JVM, .NET, Go, and Ruby API checks, and each vulnerability scan.

A static step that reads the files of one language has a step-level `if:` on the plan output. It
runs only when the plan selects the filtered lane of that language: `python`, `go`, `ruby`, `jvm`,
or `dotnet`. `pnpm rust:vuln` and the cargo-deny setup run only with the `rust` lane. The Java,
Gradle, .NET, and Ruby setup steps run only with their lanes. Thus the inputs of a filtered lane
must also hold each file that the static steps of its language read. For example, the `rust` lane
names `deny.toml`, because cargo-deny reads it.

The static job runs the parts of `pnpm format:check` and `pnpm lint` as separate steps, so that
the part of one language can skip. The cross-language checks run on every change: oxfmt, oxlint,
knip, the generated SQL and dashboard catalogues, the TypeScript API, and `pnpm typecheck`. The
catalogues format their Go, Rust, and Python output, so the Go, Rust, and uv setup steps also run on
every change. `pnpm go:fmt:check` and `pnpm go:lint` also read
`benchmarks/connection-budget/go-probe`, which the `go` lane does not read, so they run on every
change. A shared input selects every lane, so it runs every static step.

The `jvm-verification-metadata` lane runs only for a change to the files that decide which plugins
and libraries Gradle resolves: each `*.gradle.kts` file under `jvm/`, `jvm/gradle/`,
`jvm/gradle.properties`, and `jvm/release-consumer/`. A change to a JVM source cannot change that
set, and the `jvm` lane builds and checks the sources.

`scripts/ci-lanes.test.ts` holds each static step to its lane, holds each part of `pnpm lint`,
`pnpm format:check`, and `pnpm typecheck` to a step, and checks that each file a language step reads
selects the lane of that step.

_Amended by [SM-1886](https://linear.app/stablemates/issue/SM-1886)._ A successful push run that
skipped lanes did not check every line. Before this amendment, the release workflows accepted that
run for the tagged commit. Now the release workflows also require that the run planned every lane
that a push runs, `FULL_PUSH_LANES` in `scripts/ci-lanes.ts`.

The `plan` job of each push run writes the plan that the run uses to `lane-plan.json`. It uploads
the file as the `lane-plan` artifact. If the upload fails, the run fails. The build job of
`release.yml` and of `release-python.yml` runs `scripts/check-main-ci-plan.ts` before it builds an
artifact for publication. The script downloads the artifact of each successful push run of the
tagged commit and reads the plan. It does not compute the plan again from the changed files. The
release fails in these conditions, and the message names each run and its missing lanes:

- GitHub cannot list the runs, or no successful push run on `main` exists for the commit.
- The artifact is missing, expired, or cannot be downloaded.
- The plan is not JSON, has another version, or is for another event or commit.
- The plan is for another run, or for an attempt newer than the successful attempt of the run.
- The plan gives no boolean for a lane that the commit knows, or names a lane that it does not know.
- No run planned each lane of `FULL_PUSH_LANES`.

`scripts/release-go.sh` uses the same check before it reuses a main CI run. If the check fails, the
script runs the full `pnpm check`. `scripts/check-main-ci-plan.test.ts` holds the check to these
conditions and holds the workflows to the step.

_Amended by [SM-1887](https://linear.app/stablemates/issue/SM-1887) and
[SM-1893](https://linear.app/stablemates/issue/SM-1893)._ A push to `main` runs the release lanes
only for a release change, and the release lanes include the `packed` lane. Before this amendment,
each changelog edit ran every lane, and most fixes add a changelog entry. Also, no push ran the
`packed` lane. The `main` run of the release candidate `9e73e758` passed without it. Then the npm
dry run of the release rehearsal failed on the packed OpenTelemetry smoke (SM-1891).

This amendment replaces the first condition of the SM-1878 list. It also replaces `FULL_PUSH_LANES`
in the SM-1886 list with `RELEASE_PUSH_LANES`.

The release lanes are `RELEASE_PUSH_LANES` in `scripts/ci-lanes.ts`. They are each lane of
`FULL_PUSH_LANES` and each lane of `RELEASE_WEEKLY_LANES`, which holds only `packed`. A push runs
the release lanes when it changes a release file of `RELEASE_FILES`. A release file is a version
file, a `package.json`, or a lockfile that `scripts/check-release.ts` reads. `sql/releases/` and the
release workflows are also release files. A changed `CHANGELOG.md` is a release file only for a
change outside its `## Unreleased` section.

The `plan` job reads each changed changelog in the `before` commit and in the pushed commit. It
removes the `## Unreleased` section from each text: the heading and each line up to the next
heading of level 1 or 2. It finds the headings as CommonMark does, so a heading in a fenced code
block does not count. If the two texts that remain are
different, the change is a release change. Thus:

1. A fix commit that adds, changes, or removes an entry under `## Unreleased` runs only its lanes.
   So does the first fix after a release, which adds the `## Unreleased` heading.
2. A release candidate moves the notes under a dated heading, so it runs the release lanes. It
   also changes the version files, which run the release lanes alone.
3. A change to a dated entry or to the introduction of a changelog runs the release lanes. For
   example, the 0.11.0 tag is on a commit that changed the dated 0.11.0 entries.

If the plan cannot decide, the push runs the release lanes. This occurs in these conditions:

- The plan cannot read a changed changelog in both commits, for example because the push adds or
  deletes it.
- The plan cannot parse a changed changelog. It has more than one `## Unreleased` section or a
  fenced code block that does not close. Or the Unreleased section has a line that can underline a
  Setext heading.
- The plan cannot list the changed files, in each condition of the SM-1878 list after the first.

A push that runs every lane for another reason runs only `FULL_PUSH_LANES`, without `packed`. These
reasons are a shared input, a file that the map does not name, and a push without files. The
release check refuses such a run, and its message names `packed`.

The other weekly lanes stay weekly:

- `ruby-rails` tests the Ruby adapter on Rails 8.0. This is a variation of the Ruby suite. A push
  run does not run the language and PostgreSQL variations either, so this lane stays with them.
- `ruby-rails-main` and `spring-boot-snapshot` test previews of upstream releases. They have
  `continue-on-error`, and the `required` job does not need them. Thus they cannot stop a release.

The CI cost of this decision comes from the weekly runs of 2026-10-18 and 2026-10-25 and from the
push run of the 0.11.0 candidate `f9d483da9`:

| Lane                                       | Runner time on one runner           |
| ------------------------------------------ | ----------------------------------- |
| A full push run, `FULL_PUSH_LANES`         | 3,835 s in 24 jobs, 432 s wall time |
| `packed`, which joins the release lanes    | 165 s and 177 s                     |
| `ruby-rails`, which stays weekly           | 43 s and 47 s                       |
| `ruby-rails-main`, which stays weekly      | 52 s and 53 s                       |
| `spring-boot-snapshot`, which stays weekly | 81 s and 129 s                      |

Thus `packed` adds about 5% of runner time to a release push run. It takes less time than the
`static` lane, which took 391 s in that run, so the run does not take more wall time. The three
other lanes together would add about 3 to 4 more minutes of runner time to each release run.

`scripts/ci-lanes.test.ts` plans the 0.11.0 candidate shape and a fix commit with only an
`## Unreleased` entry. It also plans a change to a dated entry, an unreadable changelog, and a
changelog that the plan cannot parse. `scripts/check-main-ci-plan.test.ts` holds the release check to the
`packed` lane.

## Consequences

A change gets one result per language, and the Rust and Go lanes stop setting the wait for every
pull request.

A regression that only a variation exposes surfaces up to a week later. Examples are a data race,
Rust code that compiles only with a feature on, or a file a package leaves out. Before this
decision, the packed-install run found packaging regressions within a day. Every release path
still runs its package check before it publishes, so a broken artifact cannot ship. The scheduled-failure issue from ADR 0043 reports
it. A contributor who touches concurrent Go code or feature-gated Rust code should run
`pnpm go:test:race` or `pnpm rust:test:no-features` before asking for review.

_Amended by [SM-1548](https://linear.app/stablemates/issue/SM-1548)._ A pull request that changes
only one SDK waits only for the lanes of that SDK and the four lanes that check every language.
Each run also costs less. If the map omits an input that a lane reads, a change to that input skips
the lane. A push to `main` runs every lane, but a maintainer can cancel that run, so the weekly run
is the last check that reports the failure. The scans and the shared inputs make this omission less
likely.

_Amended by [SM-1681](https://linear.app/stablemates/issue/SM-1681)._ A docs-only pull request
costs one lane less. A docs-only merge that skips its push run costs no `main` run. The pull request
tested its merge commit on the base of that time. If another change lands first and makes a doc
check fail, such as a guide reference value that no longer matches its architecture page, the next
full run on `main` or the weekly run reports it.

_Amended by [SM-1877](https://linear.app/stablemates/issue/SM-1877)._ A pull request that changes
one language skips the static steps and the setup of the other languages, and a change to a JVM
source skips the JVM verification metadata lane. A file that a language step reads and that its
lane does not name hides a failure until a run that selects every lane. Pushes to `main`, the
weekly run, and a change to a shared input run every static step.

_Amended by [SM-1878](https://linear.app/stablemates/issue/SM-1878)._ A push to `main` that changes
only one language costs about as much as its pull request run. Nobody has to cancel it by hand.
A change that adds a changelog entry changes a release file, so its push still runs every lane.
On 2026-10-28, 20 of the last 60 commits on `main` changed a changelog. A push run no longer runs
the lanes that its pull request skipped. Thus an input that the map omits
hides a failure until the next release candidate, the next change to a shared input, or the weekly
run. A tag on a commit that is not the release candidate commit can have a push run that skipped
lanes.

_Amended by [SM-1886](https://linear.app/stablemates/issue/SM-1886)._ The release workflows refuse
a tag whose push runs did not plan every lane, so a tag on another commit fails before any publish.
The artifact expires after the artifact retention period of the repository. Then the check cannot
read the plan, and the release fails. A `workflow_dispatch` run of CI does not replace the push
run, because the check accepts only a push run. Thus a maintainer must tag the release candidate
commit before its artifact expires, or make a new release candidate commit.

_Amended by [SM-1887](https://linear.app/stablemates/issue/SM-1887) and
[SM-1893](https://linear.app/stablemates/issue/SM-1893)._ A change that adds a changelog entry
under `## Unreleased` runs only its lanes. Of the last 60 commits on `main` on 2026-10-30, 9 commits
changed a changelog and no other release file or shared input. Before this amendment each of them
ran every lane, and now each runs only its lanes. A change to a version file still runs the release
lanes. The version files include `package.json`, `python/pyproject.toml`, and the lockfiles that the
release check reads, so a dependency update also runs them.

A release push costs about 3 more minutes of runner time for the `packed` lane. In exchange, the
`main` run of a release candidate installs and tests the packed npm packages before a release
workflow starts. A regression of the Rails 8.0 adapter or of an upstream preview still surfaces only
in the weekly run.
