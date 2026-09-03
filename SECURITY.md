# Security policy

This policy states how to report a vulnerability in Workhorse privately, what happens after a
report, and which versions receive fixes. It is limited to what the project can honour today.
[ADR 0058](docs/decisions/0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md)
records the decisions behind it.

## Report a vulnerability

Report a vulnerability through
[GitHub private vulnerability reporting](https://github.com/stablemates/workhorse/security/advisories/new).
The report opens a private advisory that only the maintainers can read. Do not open a public
Issue, a pull request, or a discussion for a suspected vulnerability.

Include the affected package and version, the steps that reproduce the problem, and its impact.
A proof of concept helps but is not required.

There is no bug bounty. The maintainers credit the reporter in the advisory unless the reporter
asks otherwise.

## What happens after a report

1. **Acknowledgement, within five business days.** The acknowledgement names the maintainer who
   owns the report and the next step.
2. **Triage, within ten business days.** The maintainers confirm or reject the report, assign a
   severity, and tell the reporter both. Severity is CVSS v4.0 as scored on the advisory.
3. **Fix.** The targets below are targets, not commitments. When one is missed, the maintainers
   tell the reporter and say why rather than letting the date pass in silence.

   | Severity         | Target                                             |
   | ---------------- | -------------------------------------------------- |
   | Critical or High | A release within 14 days of triage                 |
   | Medium           | The next scheduled release                         |
   | Low              | Recorded, and fixed when that code is next touched |

4. **Disclosure.** The maintainers agree a disclosure date with the reporter. The embargo runs
   until the fix is published, and the maintainers cap it at 90 days from acknowledgement: after
   that the advisory is published whether or not a fix has shipped, so an unfixed problem is not
   hidden indefinitely. A reporter who wants to disclose earlier should say so at triage.
5. **Advisory.** GitHub is the CVE Numbering Authority for this repository, so publishing the
   advisory requests a CVE. One vulnerability gets one CVE and one advisory per affected
   ecosystem, because a GitHub advisory names a single ecosystem and Workhorse publishes to npm,
   PyPI, and the Go module proxy. Each fix is also recorded in the affected changelog.

No third-party security audit of Workhorse has taken place. Every review referenced by this project
is a maintainer review.

## Supported versions

**A fix ships on the highest published minor of the current major of each affected line, and
nowhere else.** There are no maintenance branches, no backports, and no long-term-support
designation. An older minor does not receive a fix; upgrade to the current line to receive one.

The affected lines are the ones that contain the vulnerable code. A problem in the SQL schema or
the protocol is fixed on all three lines as one release train. A problem in one SDK ships on that
line alone.

The three lines are the nine `@stablemates/workhorse*` npm packages, released in lockstep; the
`stablemates-workhorse` Python distribution; and the `github.com/stablemates/workhorse/go` module.
[`docs/compatibility.md`](docs/compatibility.md) defines the supported runtimes and the release
process.

This single-line policy is affordable because every Workhorse upgrade is an ordinary rolling
deployment. A minor adds, a major adds, and the one destructive act is a contract step the operator
runs on their own schedule
([ADR 0057](docs/decisions/0057-retain-superseded-functions-and-contract-on-the-operators-schedule.md)).
Upgrading to receive a fix therefore asks for a package bump and a `workhorse schema migrate` that
only adds.

## How a fix ships

A fix ships as a new, higher version. A published version is never re-tagged or replaced. When a
release carries a security, secret, privacy, or legal exposure, the maintainers also deprecate the
npm release, yank the PyPI release, or retract the Go version, and rotate or revoke any affected
credential. Removal does not reverse prior access, so treat every published artifact as
permanently observable.

## Safe harbour

The maintainers will not pursue a reporter who investigates in good faith against an installation
the reporter controls, stays within that installation, and reports privately through the form
above.

That does not extend to the public demo host or to `workhorse.run`. Those are single shared
installations, and traffic against them is indistinguishable from an attack on the project's own
service. Run your testing against your own database.

## Scope

The policy covers the published packages and this repository's source.

Out of scope, so that nobody spends effort on it:

- **A third party's deployment of Workhorse.** Reports about a running installation belong to the
  operator of that installation, not to this project.
- **A dependency advisory with no reachable path through Workhorse's own code.** Open an ordinary
  Issue; the maintainers move the range in a normal release.
- **Resource exhaustion an operator can produce against their own database** with credentials they
  already hold. Workhorse gives an operator the database; it does not defend the database from
  them.
