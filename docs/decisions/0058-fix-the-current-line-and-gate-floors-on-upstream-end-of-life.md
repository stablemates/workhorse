# ADR 0058: Fix the current line only, and gate every floor on upstream end-of-life

- **Status:** Accepted
- **Date:** 2026-09-02
- **Related:** [ADR 0054](0054-define-what-1-0-0-promises.md),
  [ADR 0056](0056-set-the-1-0-0-exit-criteria.md),
  [ADR 0057](0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md),
  [ADR 0043](0043-public-ci-and-release-policy.md),
  [WH-583](https://ontrack.sh/projects/WH/issues/WH-583),
  [WH-576](https://ontrack.sh/projects/WH/issues/WH-576),
  [WH-584](https://ontrack.sh/projects/WH/issues/WH-584)

## Context

ADR 0054 named seven governed surfaces and said what breaking means on each. ADR 0056 set the six
gates that hold the tag. ADR 0057 settled how long a superseded function is retained and who removes
it. Between them, three questions a reader asks about a stable release are still unanswered, and all
three are about what the project owes a version that is already installed.

The first is which released versions receive fixes. `SECURITY.md` answers it for the beta — the
latest `0.x` minor of each line, nothing older — but that sentence is written against a line with no
compatibility promise. At 1.0.0 the reader is invited to pin, and "upgrade to get the fix" stops
being obviously free.

The second is what happens when a floor rises. Node.js 22, Python 3.12, Go 1.25, and PostgreSQL 15
are today's minimums, and `pg`, Psycopg, asyncpg, and pgx carry declared ranges. None of these is one
of ADR 0054's seven surfaces. Raising a floor makes no caller's code stop compiling, so the
TypeScript, Python, and Go surface tests all say "not breaking"; and yet it makes the release
uninstallable for somebody. A rule that answers "not breaking" to a question the reader is actually
asking is not an answer.

The third is the disclosure process itself. `SECURITY.md` states where to report and that the
maintainers acknowledge within five business days. After the acknowledgement it says nothing: no
severity scale, no fix target, no embargo limit, no statement about CVEs, no statement about what
the reporter may safely test, and no statement about what is out of scope. A reporter reading it
cannot tell whether their report will be answered in a week or a year.

WH-576's peer survey is the evidence base. Six of seven peers patch the latest line only, and the one
maintenance line in the set — pg-boss `v10` — exists because the upgrade path out of it had been
removed. Only Temporal states a support window at all. So a multi-line policy is not the expected bar
for a 1.0; the bar is stating the single-line policy plainly and making the upgrade that carries the
fix cheap enough that a single line is honest.

## Decision

### A fix ships on the current line, and only there

A fix ships as a new patch or minor on the **highest published minor of the current major** of every
affected language line. No other version receives it. There are no maintenance branches, no
backports, and no long-term-support designation, before or after 1.0.0.

This is affordable here for a reason peers do not have. ADR 0057 made every upgrade in the product's
life an ordinary rolling deployment: a minor adds, a major adds, and the one destructive act is a
contract step the operator runs on their own schedule. "Upgrade to the current line to receive the
fix" therefore asks for a package bump and a `workhorse schema migrate` that only adds — the same
procedure every other release uses — and never for the fleet-stopping event that forced pg-boss to
keep `v10` alive.

That reasoning is also the tripwire. A maintenance line is created only if this project ever ships a
release that an operator cannot take by rolling deployment. ADR 0054 and ADR 0057 forbid such a
release, so the condition is a check on those promises rather than a plan.

Scope across the three lines follows where the defect lives. A defect in the SQL schema, the
protocol, or anything else all three SDKs share is fixed on all three lines and published as one
release train. A defect in one SDK ships on that line alone, and the other two do not move.

### Raising a floor is a minor, and only upstream end-of-life may raise it

The runtime support matrix is **not** an ADR 0054 governed surface, and this ADR does not make it
one: the seven surfaces stay seven, and ADR 0056's first gate still asks for seven checks. The matrix
is governed by the rule below instead.

Raising the Node.js, Python, Go, or PostgreSQL floor is a **minor** release. It is never a major, and
never a patch. A floor rises only when the runtime being dropped has reached its **upstream end of
life**, as published by that project:

- **Node.js** and **Python** — the version is past its published end-of-life date.
- **PostgreSQL** — the major is past its community end-of-life date.
- **Go** — the release is older than the two the Go project supports, which is Go's own definition
  of unsupported.

The upstream schedule is the authority and this repository does not keep a competing one. Convenience
is not a reason: a runtime that is still supported upstream keeps its place in the matrix even when
dropping it would simplify the code.

Notice is what makes the minor honest. Before the minor that drops a version, the compatibility table
names it as scheduled for removal with the upstream date, and at least one published minor's
changelog says so. PostgreSQL takes two published minors of notice rather than one, because a
PostgreSQL major upgrade is a database migration the operator schedules rather than a package bump.

A floor raise is a minor because it cannot reach code that already runs. The operator on the dropped
runtime keeps the version they installed, which keeps working against the database it was built for;
what they lose is future releases, and every package manager in the three ecosystems already reports
that as a resolution result rather than a crash. Calling it a major would spend the whole 1.0-to-2.0
apparatus — a contract step, a twelve-month retention window — on a release that removes no API.

### Every dependency range moves in a minor, under the same rule

`pg`, Psycopg, asyncpg, and pgx move by the rule above, whichever direction they move in. Raising a
floor inside the declared major range is a minor. Widening the range to admit a new upstream major is
a minor, once CI exercises it. Narrowing the range to drop an upstream major is also a minor, and is
allowed only when that major is end-of-life upstream or is unusable — an unfixed advisory in that
major, for instance — with the same one-minor notice a runtime floor takes.

Narrowing a **peer** range is the same event as a floor raise and is treated the same way. The
consumer who cannot move keeps the version they installed; only the next release stops resolving for
them. Treating a peer narrowing as a major and a Node.js drop as a minor would be incoherent, because
the operator experiences one thing in both cases.

One dependency move is a major, and it is a major for an ordinary ADR 0054 reason rather than a new
one. `NewWorker(pool *pgxpool.Pool, options WorkerOptions)` puts a pgx type in the Go module's
exported signature, so moving to pgx v6 changes an exported identifier and requires
`github.com/stablemates/workhorse/go/v2`. The rule is general: a dependency whose types appear in a
governed surface moves that surface when it changes incompatibly, and the surface's own definition of
breaking decides the release. No equivalent exists on the TypeScript or Python lines, where `pg` and
Psycopg are bundled dependencies that a caller never names.

### The disclosure process is written down to the end

`SECURITY.md` states the whole path from report to advisory, not just the first step. It gains: a
severity scale and a fix target for each severity; a triage decision within ten business days; an
embargo that the reporter and the maintainers agree and that the maintainers cap at 90 days from
acknowledgement; a statement that GitHub is the CNA and that publishing the advisory requests a CVE;
a statement that one CVE gets one advisory per affected ecosystem, because a GitHub advisory names a
single ecosystem and Workhorse publishes to three; a plain statement that there is no bug bounty; a
safe-harbour paragraph naming what a reporter may test; and an out-of-scope list.

The fix targets are the honest ones for a project this size, stated as targets and not as
commitments: Critical and High within 14 days of triage, Medium in the next scheduled release, Low
recorded and fixed when the affected code is next touched. A missed target is reported to the
reporter with a reason rather than passed over.

Safe harbour covers testing against an installation the reporter controls. It does not cover the
demo host or `workhorse.run`, because those are single shared installations and load against them is
indistinguishable from an attack on the project's own service.

Out of scope, and stated so a reporter does not spend effort on it: any report about a third party's
deployment of Workhorse, which belongs to that operator; a dependency advisory with no reachable path
through Workhorse's own code, which is an ordinary Issue; and a resource-exhaustion result an
operator can produce against their own database with credentials they already hold.

### The dashboard-server review stays a gate, and gains a re-walk trigger

ADR 0056's fifth gate already requires a written review of
`@stablemates/workhorse-dashboard-server` against a committed checklist, with every High finding
resolved, every Medium resolved or accepted in writing, and `SECURITY.md` stating that no
third-party audit has taken place. That is confirmed here rather than reopened, and WH-625 executes
it.

What this ADR adds is what happens after the review, because a review that is true once and never
again is a date rather than a property. A pull request that changes authentication, session or
credential handling, the transport surface, or `dashboard/v1` procedure dispatch re-walks the
checklist rows that cover what it touched, and says so in the pull request. The checklist is
committed for exactly this reason, so the re-walk costs reading rather than rediscovery.

### The site gets one releases page, and no second security page

The site gets one new page that shows the three lines together: the current version of each line,
its release date, and which versions receive fixes. It exists because the support policy is
unreadable without it — "the highest published minor of the current major" is a rule, and a reader
cannot apply it without knowing what those three versions are, which today means visiting npm, PyPI,
and the Go module proxy.

The page is generated at build time from `CHANGELOG.md`, `python/CHANGELOG.md`, and
`go/CHANGELOG.md`. It is not hand-maintained, because a stale version table turns the published
security policy into a false statement, and the changelogs are already updated in the same commit
that cuts a tag.

The site gets no security page. Reporting happens through GitHub's private advisory form, which is on
GitHub, and `SECURITY.md` is rendered there beside it. A second copy on the site would be a second
place to drift. The releases page links to it.

## Consequences

An operator who pins a version and stops upgrading receives no fixes, and the policy now says so in
one sentence instead of implying it. That is the same position every peer but Temporal takes, and it
is the position this project can actually staff.

The support matrix now shrinks on a schedule the project does not control. Node.js and PostgreSQL
end-of-life dates decide when Workhorse may drop a version, so the matrix's future shape is knowable
in advance and is not a maintainer's choice. Recording those dates as data is the follow-up work
below; until it lands, the matrix is correct but its removals are undated.

A 2.x line becomes cheaper to reach and less frightening to take. Between ADR 0057 and this ADR,
neither a major release nor a floor raise stops a fleet, so the only event that removes anything is a
contract step the operator runs. The version number stops being the thing an operator fears.

Naming pgx v6 a Go `/v2` is a real constraint on the Go line and is worth stating before it is
urgent. `NewWorker` is the only exported signature carrying a pgx type today, so the cost of the
constraint is one function; a future export that takes or returns a pgx type widens it, and should be
weighed against that.

## Follow-up work

Filed `ready-for-agent` and tagged `release-1.0`. None of it is a 1.0 gate; ADR 0056's six gates are
unchanged and this ADR adds no seventh.

- The site releases page generated from the three changelogs.
- Node.js, Python, and PostgreSQL end-of-life dates recorded in `support.json` with a check that
  fails once a listed version is past its date and still in the matrix.
- Dependency vulnerability scanning for the npm packages, which today have none while
  `pnpm python:vuln` and `pnpm go:vuln` cover the other two lines.

One item needs a maintainer rather than an Agent and is filed in Backlog: Dependabot alerts, secret
scanning, and push protection are disabled on a public repository, and only a maintainer can enable
them.

## Rejected alternatives

### Give the previous major security fixes for twelve months

This mirrors ADR 0057's retention window and would give an operator one number to remember. It is
rejected because the two windows pay for different things. Retaining `claim_v1` beside `claim_v2`
costs schema size and nothing else, which is why ADR 0057 could promise it. Backporting a fix costs a
branch, a second build and test matrix across three languages, and a judgement call on every fix
about whether it applies — the support organisation ADR 0054 explicitly declined to imply. A promise
the project would quietly break is worse than the absence of one.

### Make a floor raise a major

This is the strict reading of "a major release may break the public API", and it is what a reader who
equates "uninstallable" with "breaking" would expect. It is rejected because it would make the major
number report the Node.js release cadence rather than this project's API. Under it, Node.js 22's
end of life in 2027 alone would force a major, complete with a contract step and a twelve-month
retention clock, for a release that removes nothing. The major number would then say less about
compatibility than it does today, not more.

### Let the compatibility table drop a version whenever CI cost justifies it

This is today's implicit position, and it is what makes the matrix a maintainer's convenience rather
than a promise. It is rejected because the operator cannot plan against it: they would learn that
their runtime is gone by reading a changelog after the fact. The upstream end-of-life date is public,
years ahead, and decided by someone with no interest in this project's CI bill, which is exactly what
makes it usable as a bound.

### Publish a security page on the site that duplicates `SECURITY.md`

Rejected on the repository's own one-owner rule. The reporting button lives on GitHub, the policy
renders next to it, and a marketing-site copy would be the version that goes stale. The releases page
links to the canonical file.
