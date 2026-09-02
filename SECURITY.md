# Security policy

This policy states how to report a vulnerability in Workhorse privately, what to expect after a
report, and which versions receive fixes. It is limited to what the project can honour today.

## Report a vulnerability

Report a vulnerability through
[GitHub private vulnerability reporting](https://github.com/stablemates/workhorse/security/advisories/new).
The report opens a private advisory that only the maintainers can read. Do not open a public
Issue, a pull request, or a discussion for a suspected vulnerability.

Include the affected package and version, the steps that reproduce the problem, and its impact.
A proof of concept helps but is not required.

The maintainers acknowledge a report within five business days. The acknowledgement names the
maintainer who owns the report and the next step. Please give the maintainers time to ship a
fix before disclosing the problem publicly. The maintainers agree a disclosure date with the
reporter, and credit the reporter in the advisory unless the reporter asks otherwise.

## Supported versions

Workhorse is a public beta on the `0.x` line. Only the latest `0.x` minor release of each package
line receives security fixes: the nine `@stablemates/workhorse*` npm packages, the
`stablemates-workhorse` Python distribution, and the `github.com/stablemates/workhorse/go` module.
An older minor does not receive a fix. Upgrade to the latest minor to receive one.
[`docs/compatibility.md`](docs/compatibility.md) defines the supported runtimes and the release
process.

## How a fix ships

A fix ships as a new, higher version. A published version is never re-tagged or replaced. When a
release carries a security, secret, privacy, or legal exposure, the maintainers also deprecate the
npm release, yank the PyPI release, or retract the Go version, and rotate or revoke any affected
credential. Removal does not reverse prior access, so treat every published artifact as
permanently observable. Each fix is recorded in the affected changelog and in a published GitHub
security advisory.

## Scope

The policy covers the published packages and this repository's source. Reports about a
deployment of Workhorse belong to the operator of that deployment, not to this project.
