# Release process

A release publishes one version of every Workhorse package line to its registry. This page is the
maintainer procedure for that work. It states the checks that stop a defective candidate, the steps
for each registry, and the recovery from a release that stops part way.

[Compatibility and support boundary](compatibility.md) states what a release supports, and
[What SemVer governs](versioning.md) states what a version number promises.

Every release is a tag that points to a green public CI commit. Each tag then runs the focused gate
for the distribution being published.

## Main CI run that planned every CI lane

The release workflows publish a commit only after a full `main` CI run checked it. A push run on
`main` plans only the CI lanes that its changed files select, so a successful push run can skip CI
lanes. A release candidate commit changes release files. Thus its push run plans every CI lane
that a push runs, and also the weekly `packed` CI lane. A changelog entry under `## Unreleased`
alone is not a release change.

**Example.**

1. A maintainer tags a commit that changed only Python files, by mistake.
2. The `main` push run of that commit planned only the Python CI lane and the always-run CI lanes,
   and it passed.
3. The build job of `release.yml` reads the plan of that run. It fails before it builds a release
   artifact, and it names the run and each CI lane that the run skipped.

The `plan` CI job of each push run uploads the plan that the run used as the `lane-plan` artifact.
The build job of `release.yml` and of `release-python.yml` runs `scripts/check-main-ci-plan.ts`
before any publish step. A dry run does the same. The check reads the plan of the run. It does not
compute the plan again from the changed files. `scripts/release-go.sh` uses the same check, and it
runs the full `pnpm check` when the check fails.

The artifact expires after the artifact retention period of the repository. Tag the release
candidate commit before then, or make a new release candidate commit.

<details>
<summary>Reference: when the release check of the main CI run fails</summary>

The check fails, and the release publishes nothing, in each of these conditions:

1. GitHub cannot list the `CI` runs of the commit.
2. No successful, completed `CI` run on `main` with the `push` event exists for the commit.
3. The `lane-plan` artifact of each such run is missing, expired, or cannot be downloaded.
4. The plan file `lane-plan.json` is not JSON, has a `version` other than 1, or names an `event`
   other than `push` or a `sha` other than the commit.
5. The plan names another run in `runId`. Or its `runAttempt` is newer than the successful attempt
   of the run, because a later attempt replaced the plan after GitHub listed the result.
6. The plan gives no boolean for a CI lane in `LANE_NAMES`, or names a CI lane that `LANE_NAMES`
   does not hold.
7. No run gives `true` for each CI lane of `RELEASE_PUSH_LANES` in `scripts/ci-lanes.ts`. These
   are all CI lanes except the weekly CI lanes, and the weekly `packed` CI lane.

The error output names each run and the reason, or the CI lanes that the run did not plan.

More detail: [ADR 0083](decisions/0083-run-each-language-suite-once-per-change.md)

</details>

## Release train

Every release publishes the same version from one source commit, in one controlled window, in a
fixed order. The registries are npm, PyPI, the Go module proxy, crates.io, RubyGems, Maven
Central, and nuget.org. Dates go into the changelogs before the
candidate is cut, and a slipped date means a new candidate. The candidate commit is a commit on
`main`, and every tag of the train points to it, so every tag names the candidate commit. Other
commits can land on `main` during the release. Thus the maintainer must create each tag on the
candidate SHA, for example `git tag --annotate vX.Y.Z <sha>`, not on the current tip of `main`.
Nobody may cancel the `main` CI push run of the candidate commit, because each release workflow
requires that run to succeed and to have
[planned every CI lane](#main-ci-run-that-planned-every-ci-lane).

The rule does not change at a major release. If the defect is in one SDK, the fix ships in a
release train like any other release. Each other line publishes the same version with no change, a
version-only release. The changelog of that line states that it has no changes.
[ADR 0106](decisions/0106-keep-the-release-lines-in-lockstep-after-1-0-0.md) records the decision.

The Rust crate and the Ruby gem have no tag of their own. Each rides the npm `v*` tag and publishes
after npm, as [Rust crate](#rust-crate) and [Ruby gem](#ruby-gem) describe. The three JVM artifacts
ride the same tag and publish to Maven Central after npm, as [JVM artifacts](#jvm-artifacts)
describes.

1. Rehearse. The candidate commit's `main` push run must show a green `CI / required`.
   `.github/workflows/release.yml` and `.github/workflows/release-python.yml` are dispatched
   manually with `dry-run` enabled, and every npm and Python archive is downloaded and inspected.
   All ten npm tarballs, the Python wheel, and the Python source distribution are installed in
   clean consumers. The Python dry run's `attestation-rehearsal` job must pass, which proves that
   the attestation files exist and that the pinned uv uploads them. The Go external consumer, the Rust packaged-crate consumer, the Ruby
   packaged-gem consumer, and the JVM consumers of the staged artifacts are built from the same
   commit.
   Test registries are not part of the rehearsal.

   Each dry run must test the candidate SHA. A dispatched run builds the head of the branch that it
   starts on, not a SHA, and other commits can land on `main` after the candidate. A dry run on a
   later commit proves nothing about the candidate. Python publishes first, so a candidate that
   fails the `release.yml` build job after the tag stops the train partly published. Do these
   steps:
   1. Before you dispatch, compare the tip of `main` with the candidate SHA. If they are equal,
      dispatch both dry runs on `main`.
   2. If the tip of `main` moved after the candidate, push a branch that points at the candidate
      SHA, for example `git push origin <sha>:refs/heads/release-candidate-X.Y.Z`. Then dispatch
      both dry runs on that branch. A push to this branch starts no CI run.
   3. When each dry run ends, run `gh run view <run-id> --json headSha`. The `headSha` must equal
      the candidate SHA. If it does not, the dry run does not count. Dispatch it again on a branch
      that points at the candidate SHA.
   4. After the train, delete the candidate branch with
      `git push origin --delete release-candidate-X.Y.Z`.

2. Publish Python first. One distribution is the smallest production test of trusted publishing.
   `pnpm release:verify python` checks its PEP 740 attestations on PyPI before the train continues.
3. Publish npm second. Each package goes after the published packages it requires, so
   `@stablemates/workhorse-dashboard-contract` precedes `@stablemates/workhorse`, and the dashboard
   server precedes the dashboard facade.
   [ADR 0085](decisions/0085-publish-npm-packages-in-dependency-order.md) records this order. Every
   package's provenance is verified. The same run then publishes the Rust crate and the Ruby gem,
   and uploads the three JVM artifacts to Maven Central. Each of these versions is verified on its
   registry before the train continues. The same run also pushes the four .NET packages to
   nuget.org. The run creates the public GitHub release last, after the `crates-io`, `rubygems`,
   `maven-central`, and `nuget` jobs succeed.
4. Publish Go last. The `go/vX.Y.Z` tag is pushed after the gate passes, and the version is
   verified through the public module proxy.

Each verification checks registry visibility, provenance or the module checksum, and installation
of the exact public version in a clean environment. It then runs a minimal enqueue-and-worker smoke
test against a fresh PostgreSQL database. Any failure stops the release train: the defect is filed,
the remaining stages stay blocked, and the fix ships as a new candidate.

The release check stops a candidate that leaves one line behind. In `release.yml`, if the version
of the crate, the gem, the JVM artifacts, or the .NET packages differs from the tag, they skip
publication. The run still succeeds. So the check must refuse the candidate before the first
registry receives it. The check also reads `dotnet/Directory.Build.props`, so it refuses a .NET
version that differs from the tag.

The release check reads no secret. If the JVM or .NET version matches the tag and a secret of its
environment is missing, the `maven-central` or `nuget` job fails before any upload. The error
names each missing secret, and `github-release` does not run. A dry run and a run without a `v*`
tag do not start the `maven-central` and `nuget` jobs. `pnpm release:check
<npm|python|go> <tag>` runs the same checks for each tag. `pnpm npm:release-check`,
`pnpm python:release-check`, and `pnpm go:release-check` call it first. It fails, and lists each problem, if one of these is true:

1. A file does not carry the release version. The files are every published `package.json`,
   `typescript/core/src/version.ts`, `python/pyproject.toml`, `python/src/workhorse/_version.py`,
   `python/uv.lock`, `go/version.go`, `rust/Cargo.toml`, `Cargo.lock`,
   `ruby/lib/stablemates/workhorse/version.rb`, each Ruby lockfile, `jvm/gradle.properties`, and
   `dotnet/Directory.Build.props`.
2. A peer range on a published package does not cover the release. For a `0.x` release, the range
   is the release's minor line. From the first major release, the range is its major line. The
   check reads every published `package.json` and `dashboard/app/package.json`.
3. An `install` command in `support.json` names another version.
4. A changelog has no `## X.Y.Z` entry for the release. The changelogs are `CHANGELOG.md`,
   `python/CHANGELOG.md`, `go/CHANGELOG.md`, `rust/CHANGELOG.md`, `ruby/CHANGELOG.md`,
   `jvm/CHANGELOG.md`, `dotnet/CHANGELOG.md`, and the changelog of each published npm package that
   has one.
5. `sql/releases/<NNNN>.sql` does not exist for `WORKHORSE_SCHEMA_VERSION`. This applies to every
   release kind. If a release ships a schema version above the newest file in `sql/releases/`, the
   release must add the file for that version. A patch release can ship a migration, so it can also
   need a new file. A release without a migration ships a schema version that an earlier release
   froze. The first major release adds no migration, so the last `0.x` minor already froze its
   artifact.

The Python files and `python/CHANGELOG.md` use the PEP 440 spelling of a prerelease, and the other
files use the SemVer spelling. The check changes no publication step of a workflow.

`pnpm release:verify <python|npm|crate|go|maven|nuget> X.Y.Z` holds the version checks as exact commands and
the output each must print. After each stage publishes, the handoff runs that stage's target
instead of restating commands. Each target installs the public version into a fresh scratch
directory:

- `python` installs `stablemates-workhorse==X.Y.Z` into a virtual environment on the oldest
  supported Python. It checks both `workhorse.__version__` and the installed distribution metadata.
  It then reads PyPI's integrity API for every file of the release. Each file needs an attestation
  bundle whose publisher is `stablemates/workhorse` `release-python.yml`.
- `npm` checks every published package's version, then installs `@stablemates/workhorse` and runs
  `npm audit signatures` and `workhorse --version`.
- `crate` resolves `workhorse = "=X.Y.Z"` from crates.io and checks the locked package ID.
- `go` resolves the module through `proxy.golang.org` with no direct fallback and runs
  `go mod verify`.
- `maven` builds the Java consumer of `run.workhorse:workhorse` and the Kotlin consumer of
  `run.workhorse:workhorse-kotlin` from `jvm/release-consumer` against Maven Central. Each
  consumer runs one task in the database that `WORKHORSE_VERIFY_DATABASE_URL` names, and checks
  that it succeeded. That database must have the Workhorse schema. Each consumer prints the file
  name of the jar it loaded, which must name the version, and the id of the task.
- `nuget` restores `dotnet/release-consumer` with the four .NET packages from nuget.org into an
  empty package folder, with no HTTP cache. Each package must come from nuget.org. The consumer
  prints the version of each package assembly. It then runs one task in the database that
  `WORKHORSE_VERIFY_DATABASE_URL` names, and checks that it succeeded.

The script covers registry visibility, signatures or checksums, and clean installation. It also
covers PyPI provenance. The maintainer still reviews provenance on the npm, crates.io, and RubyGems
pages and runs the enqueue-and-worker smoke test.

Every release check also runs its target before anything is tagged or published. Each rehearsal
substitutes the artifact about to ship for the registry release:

- `--wheel <file>` installs the dry-run wheel. It skips the PyPI provenance check, which only the
  registry can answer. The attestation rehearsal covers that path before the tag.
- `--tarballs <directory>` installs all ten packed tarballs and checks each installed version.
  It skips `npm view` and `npm audit signatures`, which only the registry can answer.
- `--crate <directory>` depends on the unpacked `.crate` archive by path and checks its package ID.
- `--go-proxy <directory>` serves a file module proxy ahead of `proxy.golang.org`. It skips the
  checksum database for this module only, which has never seen the unpublished version, and uses a
  scratch module cache.
- `--maven-repo <directory>` makes the consumers take `run.workhorse` only from the staging
  directory that `pnpm jvm:package-check` writes. They take every other module from Maven Central.
- `--nuget-feed <directory>` makes the .NET consumer take the four packages only from the packed
  files that `pnpm dotnet:package-check` writes. It takes every other package from nuget.org.

A check the artifact cannot satisfy therefore fails the rehearsal, not the train after the tag.

A published version is never reused. An ordinary defect stays available and receives a higher
fix. A security, secret, privacy, or legal exposure triggers credential rotation and removal where
the registry permits it. The response also deprecates the npm release, yanks the PyPI release, or
retracts the Go version as appropriate, and yanks the crates.io and RubyGems versions. Removal does not make prior
public access reversible. Maven Central never deletes a published version, so a defective JVM
version stays available. A higher fixed version replaces it, and a published advisory names it.
[`SECURITY.md`](../SECURITY.md) states how to report a vulnerability privately and which versions
receive fixes.

The first public beta did not run this way: fix-forwards spread it across three source commits.
The dated entries in [`CHANGELOG.md`](../CHANGELOG.md),
[`python/CHANGELOG.md`](../python/CHANGELOG.md), and [`go/CHANGELOG.md`](../go/CHANGELOG.md) name
those commits.
The Ruby gem keeps its own [`ruby/CHANGELOG.md`](../ruby/CHANGELOG.md), which the
[Ruby gem](#ruby-gem) checklist bumps with every release. The three JVM artifacts keep one
[`jvm/CHANGELOG.md`](../jvm/CHANGELOG.md), which the [JVM artifacts](#jvm-artifacts) checklist bumps
with every release.
The four .NET packages keep one [`dotnet/CHANGELOG.md`](../dotnet/CHANGELOG.md). The release
candidate moves its `## Unreleased` entries under a `## X.Y.Z` heading, as for the JVM artifacts.
For the first release, the candidate also removes `unpublished` from the .NET line in
`site/lib/releases.ts`.

## npm packages

1. Update all TypeScript package versions in lockstep and add the `CHANGELOG.md` entry for the release,
   including upgrade notes for any breaking change.
2. Tag the candidate SHA with `git tag --annotate vX.Y.Z <sha>`, then push the tag. The workflow
   requires a [main CI run that planned every CI lane](#main-ci-run-that-planned-every-ci-lane) for
   that commit. It refuses a tag that fails the [release check](#release-train) for any line.
3. `pnpm npm:release-check` validates generated package assets, lint, dependencies, types, and unit
   behavior. It builds every tarball once, then installs and exercises those exact files in clean
   consumers against PostgreSQL. It then runs `pnpm release:verify npm` against those tarballs, so
   a post-publish check the packages cannot satisfy fails before anything is published.
4. The build job uploads the unchanged tarballs without publication credentials. It runs on Depot
   like the rest of CI; the publish task that follows does not. npm verifies the Sigstore provenance
   bundle against the runner environment and rejects anything it reads as `self-hosted`, which is
   how it classifies a Depot runner, so the publish task runs GitHub-hosted. That is the only task in
   the repository that does.
5. The protected `npm` environment requires approval. `scripts/publish-npm.ts` then confirms that
   this runner can authenticate at all, and checks every target version against the registry,
   before it writes anything. It publishes each package with `npm publish --provenance`, which
   exchanges the job's OIDC identity for the credential that write uses. `@stablemates/workhorse`
   goes first because the other packages declare it as a peer. A failure partway through prints the
   ledger described in
   [Recovering a partially published release](#recovering-a-partially-published-release).

**Provenance.** Every published tarball carries an npm provenance attestation linking it to this
repository, the commit it was built from, and the workflow that built it. Verify a downloaded
release with `npm audit signatures` in a project that depends on it, or inspect the "Provenance"
section on the package's npm page. A release without an attestation did not come from this
pipeline.

## Python distribution

1. Update `python/pyproject.toml` and add the same version to `python/CHANGELOG.md`.
2. Tag the candidate SHA with `git tag --annotate python/vX.Y.Z <sha>`, then push the tag. The
   workflow requires a [main CI run that planned every CI lane](#main-ci-run-that-planned-every-ci-lane)
   for that commit.
3. `pnpm python:release-check` runs the [release check](#release-train). It rebuilds the embedded
   dashboard bundle, checks Python format, lint, types, and dependencies, then runs every Python
   test against PostgreSQL. It builds the wheel and source distribution once and tests those exact
   files.
   It then runs `pnpm release:verify python` against that wheel, so a post-publish check the
   package cannot satisfy fails the rehearsal before `python/vX.Y.Z` is tagged.
4. The `attestation-rehearsal` job runs on every run, dry runs included, without the `pypi`
   environment. It generates PEP 740 attestations for the unchanged artifacts with the publish
   job's action and uv. `scripts/check-attestation-upload.ts` then runs `uv publish` against a
   loopback endpoint. It fails unless every distribution arrives with its attestation. `uv publish`
   uploads attestations only from uv 0.9.12, and an older uv still exits 0. That is how 0.6.0
   reached PyPI without provenance.
5. After the rehearsal passes, the `pypi` environment generates attestations again and publishes
   both distributions and their attestations through trusted publishing.
6. `pnpm release:verify python X.Y.Z` fails unless PyPI shows an attestation for every file.

`workhorse.__version__` is public Python API from the release after 0.4.0, and `api/python.txt`
records it. The post-publish Python check therefore fails against 0.4.0, which predates the
attribute. For 0.4.0, `importlib.metadata.version("stablemates-workhorse")` is the check.

## Go module

1. Add the intended version to `go/CHANGELOG.md`. Then re-pin the Go API baseline:
   1. Fetch the tags with `git fetch origin --tags`.
   2. Run `pnpm go-api:generate`. It pins `api/go.txt` to the newest `go/v*` tag and lists only
      the breaks since that tag. Without this step, `pnpm go-api:check` compares the module with an
      older release, and a new break is hard to see in review.
   3. Commit `go/CHANGELOG.md` and `api/go.txt` with the release candidate.
2. Fetch origin. Then check out the candidate commit in a clean worktree with
   `git switch --detach <sha>`. Do not use the current tip of `main`, because other commits can
   land on `main` during the release.
3. Run `scripts/release-go.sh X.Y.Z` from that checkout. Before the long checks, the script fetches
   `main` from origin. It refuses to continue in these conditions, and names the tag or commit:
   1. The version has no PEP 440 spelling for the Python tag.
   2. The worktree is not clean.
   3. `HEAD` is not an ancestor of `origin/main`.
   4. `vX.Y.Z` or `python/vX.Y.Z` does not exist on origin. The Python tag uses the PEP 440
      spelling of a prerelease.
   5. One of those tags points to a commit other than `HEAD`. The script peels an annotated tag to
      its commit.
   6. `go/vX.Y.Z` already exists locally or on origin.
4. The script runs `pnpm go:release-check X.Y.Z`, which runs the [release check](#release-train).
   Next, it stages a file module proxy that serves `HEAD:go` as `vX.Y.Z`. It then runs
   `pnpm release:verify go` against that proxy, so a post-publish check the module cannot satisfy
   fails before the tag.
5. The script asks GitHub with `gh api` for a successful run of the `CI` workflow on `main` for
   exactly `HEAD`, with the `push` event. ADR 0043 and ADR 0102 make that run the release gate. The
   query names the github.com repository of the `origin` URL, so `GH_REPO` cannot change it.
   1. If such a run exists, the script runs `scripts/check-main-ci-plan.ts`. If a successful run
      [planned every CI lane](#main-ci-run-that-planned-every-ci-lane), the script runs only
      `pnpm go:test` and `pnpm go:vuln`.
   2. If no such run exists, or no run planned every CI lane, the script runs the full
      `pnpm check`. A canceled, failed, or unfinished run does not count. The script also runs the
      full check in these conditions: `gh` is missing or fails, `origin` is not one github.com URL,
      or `origin` has a different or a second push URL.
6. The script creates `go/vX.Y.Z` on `HEAD`, and pushes the tag only after the gate passes.

## Rust crate

The Rust SDK publishes one crate, `workhorse`, from `rust/`
([ADR 0074](decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md)). It has no tag of its
own and publishes from the npm `v*` tag. The crate joined the release train at `0.4.0`. Before that
release, crates.io held only the `0.0.0` placeholder that reserved the name.

1. Set `version` in `rust/Cargo.toml` to the release version and commit it with the candidate.
2. Use the `vX.Y.Z` tag that the [npm packages](#npm-packages) step creates on the candidate SHA.
   Do not create another tag. The build job of `.github/workflows/release.yml` runs
   `pnpm rust:release-check`. It packages the crate with verification and builds a clean consumer
   from the packaged archive. With PostgreSQL available, that consumer enqueues one task. It then
   runs `pnpm release:verify crate` against the unpacked archive, so a post-publish check the
   crate cannot satisfy fails before anything is published.
3. After npm publishes, the `crates-io` job compares the crate version with the tag. A mismatch
   writes a notice and publishes nothing, so a release that leaves the crate behind still succeeds.
   The [release check](#release-train) in the build job refuses that tag before npm publishes.
4. On a match, the job packages the crate with `cargo package`. `scripts/check-registry-version.ts`
   then asks crates.io for the version. If crates.io serves it with the SHA-256 checksum of the
   packaged crate, the job uploads nothing and succeeds. If the checksum differs, the job fails. Thus
   a re-run finishes after an earlier run uploaded the crate, as
   [Re-run a failed crates-io or rubygems job](#re-run-a-failed-crates-io-or-rubygems-job) states.
5. If crates.io does not serve the version, the job exchanges its OIDC identity for a crates.io
   token and runs `cargo publish --package workhorse --locked`, which verifies the package again
   before the upload.

The job can publish only after a crate owner registers the workflow on crates.io:

1. Sign in to crates.io as an owner of `workhorse` and open workhorse → Settings → Trusted Publishing.
2. Add a GitHub publisher with owner `stablemates`, repository `workhorse`, and workflow filename
   `release.yml`.
3. Enter the environment `crates-io`. The field is optional, but it makes crates.io refuse a token
   to any job outside that environment. Protect the `crates-io` environment on GitHub with required
   reviewers, as `npm` and `pypi` are.

`skyeagle` (Anton Orel) is the only owner. An owner adds another in workhorse → Settings → Owners,
or with `cargo owner --add <github-login> workhorse` using a token that carries the
`change-owners` scope. crates.io sends the new owner an invitation, and ownership starts when they
accept it.

## Ruby gem

The Ruby SDK publishes one gem, `stablemates-workhorse`, from `ruby/`
([ADR 0075](decisions/0075-shape-the-ruby-sdk-as-one-gem-with-an-active-job-adapter.md)). Like the
crate, it has no tag of its own and publishes from the npm `v*` tag. It joined the release train at
0.6.0, its first release.

1. Set `VERSION` in `ruby/lib/stablemates/workhorse/version.rb` to the release version. Move the
   `## Unreleased` entries of `ruby/CHANGELOG.md` under a `## X.Y.Z` heading, and commit both with
   the candidate.
2. Use the `vX.Y.Z` tag that the [npm packages](#npm-packages) step creates on the candidate SHA.
   Do not create another tag. The build job of `.github/workflows/release.yml` runs
   `pnpm ruby:release-check`.
   It runs the Ruby gates, then builds the `.gem` once with `gem build --strict`. It installs that
   archive into an empty gem home and runs a clean consumer project without Bundler. With PostgreSQL
   available, that consumer enqueues one task and runs it through a worker.
3. After npm publishes, the `rubygems` job compares the gem version with the tag. A mismatch writes a
   notice and publishes nothing, so a release that leaves the gem behind still succeeds.
   The [release check](#release-train) in the build job refuses that tag before npm publishes.
4. On a match, the job builds the gem with `gem build`. `scripts/check-registry-version.ts` then
   asks RubyGems.org for the version. If RubyGems.org serves it with the SHA-256 checksum of the
   built gem, the job uploads nothing and succeeds. If the checksum differs, the job fails. Thus a
   re-run finishes after an earlier run pushed the gem, as
   [Re-run a failed crates-io or rubygems job](#re-run-a-failed-crates-io-or-rubygems-job) states.
5. If RubyGems.org does not serve the version, `rubygems/release-gem` exchanges the job's OIDC
   identity for a RubyGems API key and runs `rake release` in `ruby/`. That task builds the gem and
   pushes it with a Sigstore attestation. It finds the train tag already in place, so it pushes no
   tag. The action then waits until RubyGems.org serves the new version.
6. Verify the public version with `gem install stablemates-workhorse -v X.Y.Z` in an empty gem home,
   and review the attestation on the gem's RubyGems.org page.

Both jobs install the locked bundle beside the release credentials. A frozen bundle pins each gem
version, and the `CHECKSUMS` section of each committed Ruby lockfile pins that version's bytes.
Bundler compares every downloaded gem with its SHA-256 digest and refuses a mismatch.
`scripts/ruby-lockfile-checksums.test.ts` fails when a lockfile resolves a gem without a checksum,
or when CI, the release workflow, or a hook disables the comparison. After changing a Gemfile,
regenerate the lockfile with the pinned Bundler, which keeps the section current.

A maintainer set up publication on 2026-09-30 with these steps. Nothing in this repository performs
them.

1. Reserve the name. The maintainer took the placeholder route and pushed `stablemates-workhorse`
   `0.0.0` by hand. The placeholder is not a release, and the first release supersedes it. The other
   route, a pending trusted publisher, reserves nothing until the first release publishes within
   its 12-hour expiry.
2. Choose the owners. The maintainer is the only owner for now. An owner adds another with
   `gem owner stablemates-workhorse --add <email>` or in the gem's settings on RubyGems.org.
3. Register the trusted publisher on the gem: owner `stablemates`, repository `workhorse`, workflow
   filename `release.yml`, and environment `rubygems`. The maintainer registered it. RubyGems.org
   does not publish trusted publishers, so only an owner can check it.
4. Create the `rubygems` environment on GitHub with required reviewers and a policy that admits only
   the `v*` tags, as `npm`, `pypi`, and `crates-io` have. Turn off administrator bypass. The
   environment exists with these settings.

The gem's `rubygems_mfa_required` metadata does not block this job. RubyGems.org accepts a push with
a trusted publisher's API key without an OTP.
[ADR 0075](decisions/0075-shape-the-ruby-sdk-as-one-gem-with-an-active-job-adapter.md) also makes the
Ruby competitor benchmark a release gate. That gate has to pass before the first release publishes the
gem.

## JVM artifacts

The JVM SDK publishes three artifacts to Maven Central from `jvm/`: `run.workhorse:workhorse`,
`run.workhorse:workhorse-kotlin`, and `run.workhorse:workhorse-spring-boot-starter`
([ADR 0103](decisions/0103-shape-the-jvm-sdk-as-a-java-core-with-kotlin-and-spring-boot-modules.md)).
The three always carry one version. Like the crate and the gem, they have no tag of their own and
publish from the npm `v*` tag. The first version that Maven Central serves is `0.9.0`. The
maintainer steps at the end of this section came before that first publish.

[Supported versions](compatibility.md#supported-versions) gives the Gradle and Maven coordinates
and the optional dependencies of the core.

1. Set `version` in `jvm/gradle.properties` to the release version. Move the `## Unreleased`
   entries of `jvm/CHANGELOG.md` under a `## X.Y.Z` heading, and commit both with the candidate.
   For the first release, also remove `unpublished` from the JVM line in `site/lib/releases.ts`,
   because the site build refuses an unpublished line whose changelog records a release.
2. Use the `vX.Y.Z` tag that the [npm packages](#npm-packages) step creates on the candidate SHA.
   Do not create another tag. The build job of `.github/workflows/release.yml` runs
   `pnpm jvm:release-check`. It runs the JVM gates, then `pnpm jvm:package-check`, the dry run:
   1. Gradle writes the three artifacts, with `-sources.jar`, `-javadoc.jar`, and checksums, to
      `jvm/build/staging-deploy`. A throwaway key that the check generates signs every file. The
      throwaway key has the shape of the release key: an ed25519 primary key that signs, with no
      subkey. Thus each dry run tests the signature path of the release.
   2. The check refuses a module other than the three artifacts, a version other than
      `jvm/gradle.properties`, a missing file, signature, or checksum, and a POM without the
      metadata that Central requires. It also refuses a `-javadoc.jar` without an `index.html`.
      The `workhorse-kotlin` module has no Java sources, so its `-javadoc.jar` holds the Dokka HTML
      of its KDoc.
   3. It builds a Java, a Kotlin, and a Spring Boot consumer from the staging directory. With
      PostgreSQL available, each consumer enqueues one task and runs it. It then runs
      `pnpm release:verify maven` against the staging directory.
      The dry run uploads nothing and reads no secret. The CI `jvm` job runs it on the Java floor on
      every change.
3. After npm publishes, `scripts/check-release-line.ts` in the `maven-central` job compares the
   version in `jvm/gradle.properties` with the tag. A mismatch writes a notice and publishes
   nothing, and the `maven-central` job still succeeds. On a match, the job fails if one of the
   four secrets of the `maven-central` environment is missing. The error names each missing
   secret. Add the secret to the environment, then re-run the job.
   The [release check](#release-train) in the build job refuses a mismatched tag before npm
   publishes.
4. On a match, the job stages and signs the artifacts with the release key, and runs the same
   checks. It refuses a version that differs from the tag, and a signing key whose fingerprint is
   not the one that [Publication credentials](#publication-credentials) states. It then zips the
   staging directory without `maven-metadata.xml` files.
5. A second step gets no secret. It runs the Java, Kotlin, and Spring Boot consumers and
   `pnpm release:verify maven` from the same staging directory, with
   `pnpm jvm:package-check --consumers-only`. Thus the stage uploads the jars that its consumers
   ran, not a second build.
6. `scripts/upload-maven-central.ts` first asks the Central Publisher Portal whether Maven Central
   has each of the three artifacts at the version. If Maven Central has all three, the script
   uploads nothing and the `maven-central` job succeeds. This lets a re-run finish after a late
   publish. If Maven Central has some of the three but not all, the `maven-central` job fails and
   uploads nothing. If it has none, the script uploads the bundle to the Portal with
   `publishingType=AUTOMATIC`. The Portal validates the deployment and, if it passes, publishes it
   to Maven Central. No person selects Publish in the Portal. The job waits until the Portal
   reports the deployment as `PUBLISHED`. It fails if the Portal reports `FAILED` or a state that
   the Portal API does not document. It also fails if the deployment is not `PUBLISHED` after 60
   minutes. The script retries a status request that fails with a network error, HTTP 429, or
   HTTP 5xx, and fails after five such failures in a row.
7. Verify the public version with `pnpm release:verify maven X.Y.Z`. Set
   `WORKHORSE_VERIFY_DATABASE_URL` to a database with the Workhorse schema first.
   `repo1.maven.org` can serve the version some minutes after the Portal reports `PUBLISHED`.

Maven Central never deletes a published version. Thus the person who approves the `maven-central`
environment is the human check before a version becomes permanent. After that approval, three
checks stop a defective bundle before the Portal publishes it: the release check of the build job,
the release consumers on the bytes of the bundle, and the Portal validation. For 0.9.0 and 0.10.0
the stage used `publishingType=USER_MANAGED`, and the maintainer selected Publish in the Portal.
Both releases were clean, so SM-1837 changed the stage to `AUTOMATIC`.

The `github-release` job waits for the `maven-central` job. A failed upload, a failed validation, a
failed publish, or a publish that did not end in 60 minutes therefore ends the run before the GitHub
release exists.
[Recover from a failed Maven Central upload](#recover-from-a-failed-maven-central-upload) states
what to do then.

A maintainer did these steps before the first publish, and SM-1384 records them. Nothing in this
repository performs them.

1. Verify the namespace `run.workhorse` in the Central Portal with a DNS TXT record on the domain
   `workhorse.run`.
2. Generate a Portal user token.
3. Generate an OpenPGP key for signing only, and publish its public key to `keyserver.ubuntu.com`
   and `keys.openpgp.org`.
4. Create the `maven-central` environment on GitHub with a required reviewer and a policy that
   admits only the `v*` tags, as `rubygems` has. Turn off administrator bypass. Do this before
   step 5. A tag that runs the job before the environment exists makes GitHub create the
   environment without protection.
5. Add the four environment secrets: `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`,
   `MAVEN_SIGNING_KEY`, and `MAVEN_SIGNING_PASSWORD`. [Publication credentials](#publication-credentials)
   describes each one.

## .NET packages

The .NET SDK has four packages for nuget.org: `Workhorse`, `Workhorse.Hosting`,
`Workhorse.EntityFrameworkCore`, and `Workhorse.AspNetCore`
([ADR 0107](decisions/0107-shape-the-dotnet-sdk-as-a-csharp-core-with-hosting-ef-core-and-asp-net-core-packages.md)).
The four always carry one version, the train version that `dotnet/Directory.Build.props` sets. Like
the crate, the gem, and the JVM artifacts, they have no tag of their own and publish from the npm
`v*` tag. nuget.org serves them from `0.10.0`. The `nuget` job of `.github/workflows/release.yml`
publishes them from each `v*` tag that has the version of `dotnet/Directory.Build.props`.

`pnpm dotnet:package-check` is the dry run. It publishes nothing and reads no secret. The CI
`dotnet` job runs it on the first entry of its matrix on every .NET change.

1. `dotnet pack` of `dotnet/Workhorse.slnx` writes the four packages and their `.snupkg` symbol
   packages after a full build with `ContinuousIntegrationBuild`. Each other project sets
   `IsPackable` to `false`, so the demo worker, the tools, the consumers, and the tests pack nothing.
2. Package validation runs in the pack. Before the first publish, nuget.org has no version of the
   packages, so validation checks each package against its own target framework. After the first
   publish, the check sets `PackageValidationBaselineVersion` to the newest published version below
   the train version, and validation fails on a breaking change from it. The check refuses the
   packages if their newest published versions differ.
3. The check refuses a file other than the four packages and their symbol packages, and a version
   other than the train version or the `--tag` version. It also refuses a dependency on another
   Workhorse package at another version. Each nuspec must have the license expression `Apache-2.0`,
   the README `dotnet/PACKAGE.md`, the project URL, and the repository URL and the commit of the
   build. Each PDB must have a SourceLink map to that commit and no path in the checkout.
4. The check runs `pnpm release:verify nuget` with `--nuget-feed` and the packed files, in a scratch
   database. The hosted worker of `Workhorse.Hosting` runs the task of the consumer, and the check
   reads the task back. Without PostgreSQL, the check skips the consumer.

`pnpm dotnet:release-check` runs `pnpm dotnet:lint`, `pnpm dotnet-api:check`, `pnpm dotnet:vuln`,
and then the dry run.

The `nuget` job runs in the protected `nuget` environment. No step starts until the required
reviewer of that environment approves the run. The version check is a step, so each `v*` run waits
for the reviewer, even a run that pushes nothing. After npm publishes and the reviewer approves, the
`nuget` job works in this sequence:

1. `scripts/check-release-line.ts` compares the version in `dotnet/Directory.Build.props` with
   the tag. A mismatch writes a notice and publishes nothing, and the `nuget` job still succeeds.
   On a match, the job fails if the `nuget` environment has no `NUGET_USER` secret. The error
   names the secret. Add the secret to the environment, then re-run the job.
2. It runs `pnpm dotnet:package-check` with the tag, and keeps the packages that the consumer ran.
3. `NuGet/login` exchanges the OIDC identity of the `nuget` job for a nuget.org API key that is valid for
   one hour. nuget.org mints it only for the trusted publishing policy of this repository,
   `release.yml`, and the `nuget` environment. The repository stores no key.
4. `dotnet nuget push --skip-duplicate` pushes `Workhorse` first and then the other three packages.
   Each push also sends the symbol package. nuget.org signs each package, so the `nuget` job adds no
   author signature.
5. Verify the public version with `pnpm release:verify nuget X.Y.Z`. Set
   `WORKHORSE_VERIFY_DATABASE_URL` to a database with the Workhorse schema first.

nuget.org never deletes a published version. It can only unlist one. The required reviewer of the
`nuget` environment is therefore the person between the push and a permanent version.

The `github-release` job needs the `nuget` job, so the GitHub release announces a version only after
nuget.org has the packages. A version mismatch ends the `nuget` job with success, so the GitHub
release still appears. If the version matches and the `NUGET_USER` secret is missing, the `nuget`
job fails, and the GitHub release does not appear (SM-1861). If the reviewer rejects the run, the
`nuget` job fails, and the GitHub release does not appear. SM-1441 records the maintainer setup: the
nuget.org organization `stablemates`, the prefix `Workhorse.*`, the trusted publishing policy, and
the protected `nuget` environment with the `NUGET_USER` secret. Nothing in this repository performs
it.

## Release tags

Each tag prefix publishes a fixed set of packages:

| Tag         | Publishes                                                                                     | Workflow                                |
| ----------- | --------------------------------------------------------------------------------------------- | --------------------------------------- |
| `v*`        | The ten npm packages, the crate, the gem, the three JVM artifacts, and the four .NET packages | `.github/workflows/release.yml`         |
| `python/v*` | The PyPI distribution                                                                         | `.github/workflows/release-python.yml`  |
| `go/v*`     | The Go module, through the module proxy                                                       | None; `scripts/release-go.sh` pushes it |

Two repository tag rulesets cover `refs/tags/v*`, `refs/tags/python/v*`, and `refs/tags/go/v*`.

- "Protect release tags" (ruleset 21888197) restricts creation to organization administrators. The
  `OrganizationAdmin` role is its only bypass actor.
- "Lock release tags" (ruleset 24047194) blocks update, deletion, and non-fast-forward pushes. It has
  no bypass actor, so a published tag cannot move or disappear.

The Ruby gem, the JVM artifacts, and the .NET packages publish from `v*`, which both rulesets
already cover. If one of them ever moves to a different tag prefix, add that prefix to both
rulesets in the same change.

The public repository requires pull requests and `CI / required` on `main`. Outside collaborators
require workflow approval. The protected `npm`, `pypi`, `crates-io`, `rubygems`, `maven-central`,
and `nuget` environments require review, and all six prevent administrator bypass. The
repository has one maintainer. That maintainer is the only required reviewer of each environment,
and can approve a run of their own tag. Thus the review is a second step of that maintainer, not a
check by a second person.

## Publication credentials

Six of the seven registries hold no credential that this repository stores, and none of those six
holds one that can expire. Maven Central is the exception, as the last paragraph of this section
describes.

npm publication uses trusted publishing. `npm publish` exchanges the publish job's GitHub Actions
OIDC identity for a short-lived registry credential, and npm mints it only for the trusted publisher
each package names: this repository and `.github/workflows/release.yml`. Those two names are the
credential. Renaming the workflow file or the repository breaks publication until a maintainer
updates every `@stablemates/workhorse*` package on npmjs.com, so a maintainer who changes one of
them updates npm in the same change. The exchange needs npm 11.5.1 or later, which is why the
publish job runs Node 24.

That exchange happens inside `npm publish`, so nothing before it can prove the credential works.
`scripts/publish-npm.ts` checks the two conditions the exchange needs instead: the runner's npm
version, and the OIDC identity GitHub offers only to a job holding `id-token: write`. Both are
readable before the first write, and each failure names what to fix.

PyPI publication stores no credential. The `pypi` environment mints a short-lived token through
trusted publishing, and PyPI issues that token only for this repository, this workflow file, and
this environment name. Nothing expires, so nothing needs rotating. Those three names are the
credential instead. Renaming `.github/workflows/release-python.yml`, renaming the `pypi`
environment, or renaming the repository breaks publication until someone updates the trusted
publisher on PyPI. A maintainer who changes one of them updates PyPI in the same change.

crates.io publication stores no credential. `rust-lang/crates-io-auth-action` exchanges the
`crates-io` job's OIDC identity for a short-lived token. crates.io mints that token only for the
trusted publisher registered on the `workhorse` crate: this repository, `release.yml`, and the
`crates-io` environment. The action revokes the token when the job ends. Renaming the workflow
file, the environment, or the repository breaks publication until an owner updates the trusted
publisher on crates.io. The `0.0.0` placeholder was published by hand, because crates.io accepts
a trusted publisher only for a crate that already exists.

RubyGems publication stores no credential. `rubygems/release-gem` exchanges the `rubygems` job's OIDC
identity for a short-lived API key. RubyGems.org mints that key only for the trusted publisher
registered on the `stablemates-workhorse` gem: this repository, `release.yml`, and the `rubygems`
environment. Renaming the workflow file, the environment, or the repository breaks publication until
an owner updates the trusted publisher on RubyGems.org.

nuget.org publication stores no credential. `NuGet/login` exchanges the `nuget` job's OIDC identity
for an API key that is valid for one hour. nuget.org mints that key only for the trusted publishing
policy of the `stablemates` organization: this repository, `release.yml`, and the `nuget`
environment. The `NUGET_USER` secret of the `nuget` environment holds the nuget.org profile name
that `NuGet/login` sends with the exchange. It is a user name, not a credential, and it does not
expire. Renaming the workflow file, the environment, or the repository stops publication until an
owner updates the trusted publishing policy on nuget.org.

The Go module proxy needs no credential at all. `scripts/release-go.sh` pushes a tag, and the proxy
serves what the public repository already holds.

Maven Central has no trusted publishing, so its stage reads four GitHub Actions secrets of the
`maven-central` environment. `MAVEN_CENTRAL_USERNAME` and `MAVEN_CENTRAL_PASSWORD` are the Central
Portal user token. `MAVEN_SIGNING_KEY` is the ASCII-armored private OpenPGP key, and
`MAVEN_SIGNING_PASSWORD` is its passphrase. Only the step that signs receives the key, and only the
step that uploads receives the token. The token and the key do not expire by themselves, so the
maintainer rotates them: generate a new token in the Portal, or a new key, and replace the secret.
A new signing key must be on a public key server before the next release.

The release key is an ed25519 primary key that signs, with no subkey. Its fingerprint is
`B933E2F16C3FA58E5414849A024210DB67A17773`. Use this fingerprint to check a `.asc` file of a
`run.workhorse` artifact on Maven Central. `releaseKeyFingerprint` in
`scripts/check-jvm-release.ts` pins the same value, and the `maven-central` job refuses a signing
key with another fingerprint. To rotate the key, change both values in the change that the new
key signs. The check imports only the public part of the key to verify the signatures, so no
GnuPG home on the runner holds the secret key.

## Recovering a partially published release

npm publishes one package at a time. Ten packages cannot be published atomically, so a failure in
the middle leaves some at the new version and the rest at the old one.

npm's immutable unit is the name@version pair. npm refuses a pair that has ever existed, so the
packages that did publish keep this version permanently. Unpublishing is available only within 72
hours, and only while nothing depends on the version, so it is not a recovery plan.

The packages that published stay installable. `scripts/packages.ts` orders the train so each package
follows the published packages it requires. A stopped run therefore never leaves a package that
needs one it skipped.

The publish step reports the split. It names every package npm confirmed, every package it never
attempted, and the version each one carries. It reports the package that failed as unknown, because
npm can store an upload and still fail before it confirms it. The next run's preflight reads the
registry and settles that package. The report goes to the task log and to the run summary. Read that
report. Do not infer registry state from whichever npm command logged last.

Recover by re-cutting the whole train at the next patch version. That is this project's policy, not
npm's constraint: npm would still accept the packages that did not publish at this version.
Completing a partial train from the same commit is not an allowed recovery. `pnpm npm:publish`
refuses to resume a version the registry partly holds, and no other path publishes npm packages.
[ADR 0050](decisions/0050-release-0-1-0-without-a-prerelease-suffix.md) requires one version across
the seven registries, so every package moves, not only the ones that failed. The packages that did
publish stay published, because removal is unavailable and would break anyone who installed them.
Deprecate each with `npm deprecate <name>@<version>` so an installer is pointed at the version that
replaces it.

Python has already published by then, because the train publishes PyPI first. That distribution is
not defective, so it stays available and the higher version supersedes it. The Go tag was never
pushed, because the Go stage runs last and a stopped train never reaches it. One version number can
therefore end up complete on PyPI, partial on npm, and absent from the module proxy.

The half-published version is never completed and never reused. Its number is spent. Record what
happened in [`CHANGELOG.md`](../CHANGELOG.md) under the version that replaces it, so a reader who
finds the orphaned packages on npm can tell why they exist.

### Re-run a failed crates-io or rubygems job

crates.io and RubyGems.org never accept a version twice. The `crates-io` or `rubygems` job can fail
after the registry accepts the upload, for example in the wait step of `rubygems/release-gem` or at
the job timeout. The `github-release` job then does not run.

Re-run the failed job. Its environment asks for a review first. The job builds the crate or the gem
from the tag again, and `scripts/check-registry-version.ts` asks the registry for the version:

1. If the registry does not serve the version, the job uploads the artifact.
2. If the registry serves the version with the SHA-256 checksum of the new build, the job uploads
   nothing and succeeds. `cargo package` and `gem build` make the same bytes from the same tag, so
   this is the case after an upload of an earlier run. The run summary names the checksum.
3. If the registry serves the version with a different checksum, the job fails and uploads nothing.
   The registry has bytes that this tag did not build. Do not re-run the job again. Compare the
   published artifact with a build of the tag before you continue the release.

If a request to the registry fails with a network error, HTTP 429, or HTTP 5xx, the script tries
again, up to five requests in a row. Each other failure stops the job before the upload. The
`github-release` job runs after the re-run, if the other publication jobs of the run succeeded.

A re-run uses the workflow and the scripts of the tag, not of `main`. SM-1860 adds the check before
0.11.0 is tagged, so a re-run of an earlier tag still fails on a published version.

### Recover from a failed Maven Central upload

The `maven-central` job runs after npm publishes. If it fails after the Central Portal accepted the
bundle, the Portal keeps that deployment. The upload uses `publishingType=AUTOMATIC`, so the Portal
can still publish the deployment after the job ends. The log of the failed run names the deployment
in the line "The Portal accepted deployment". Each line "Deployment ... is" gives a state that the
`maven-central` job read, and the last of these lines gives the last known state.

Do not re-run the `maven-central` job before you know the state of each deployment of the
version. If Maven Central has the version, a re-run uploads nothing. While the Portal still works
on a deployment, a re-run uploads a second deployment, and Maven Central refuses it when the first
publishes. Do these steps:

1. Open <https://central.sonatype.com/publishing/deployments>. Find the deployment by the ID in the
   log. If the log has no line "The Portal accepted deployment", look for a deployment with the name
   `workhorse-jvm-vX.Y.Z` that the Portal created during the failed run. The Portal can accept the
   bundle while the `maven-central` job fails before it reads the ID. If the Portal has no
   deployment of the version, re-run the failed `maven-central` job. The `maven-central`
   environment asks for a review first.
2. If the state is `PENDING`, `VALIDATING`, `VALIDATED`, or `PUBLISHING`, the Portal still works on
   the deployment. Wait, and read the state again. Do not re-run the `maven-central` job in one of
   these states. You cannot drop a deployment in `PUBLISHING`.
3. If the state is `PUBLISHED`, Maven Central has the version permanently. Re-run the failed
   `maven-central` job. The `maven-central` environment asks for a review first. The `maven-central`
   job runs its checks again, finds the three artifacts on Maven Central, and uploads nothing. Then
   the `github-release` job runs, if the `publish`, `crates-io`, `rubygems`, and `nuget` jobs of the
   run succeeded. Run `pnpm release:verify maven X.Y.Z`, as step 7 of
   [JVM artifacts](#jvm-artifacts) describes.

   A re-run uses the workflow and the scripts of the tag, not of `main`. SM-1838 adds the check
   before 0.11.0 is tagged. 0.11.0 is the first tag that uploads with `publishingType=AUTOMATIC`, so
   each such tag has the check. The tags 0.9.0 and 0.10.0 upload with `USER_MANAGED`, so the Portal
   publishes nothing for them without the maintainer.

   If the re-run fails because Maven Central has only some of the three artifacts, do not re-run
   it again. Ask Central Support with the deployment ID.

4. If the state is `FAILED`, read the `errors` of the deployment in the log or in the Portal.

If the errors name a defect of the bundle, for example a missing signature or a POM without the
required metadata, a re-run cannot fix it. The failure is a defect of the candidate, and
[Release train](#release-train) states what to do with a defect. If the errors name no defect of
the bundle, ask Central Support with the deployment ID. Do not drop the deployment before you ask,
because Central Support uses its files. When Central Support confirms that the Portal published
nothing, drop the deployment and re-run the failed `maven-central` job. The `github-release` job
runs after the re-run succeeds.
