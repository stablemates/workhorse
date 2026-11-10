# Contributing

Workhorse is licensed under the Apache License, Version 2.0. See `LICENSE` and
`NOTICE`.

## Contributor agreement

The first pull request from a person or company must include the signature block
from `CLA.md`. Stablemates will not merge copyrightable Contributions without it.
The agreement assigns copyrightable Contributions to Stablemates and licenses them
back to you under Apache-2.0, so the core stays ownable.

## Development environment

The repository pins its development tools in `mise.toml`. In an interactive shell, activate
`mise` once so commands such as `pnpm` resolve from the pinned toolchain:

```bash
eval "$(mise activate bash)"
```

Use `mise exec --` for scripts, Git hooks, CI, and remote or non-interactive shells. Those shells
do not read the interactive startup configuration:

```bash
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm test:unit
```

When Git creates a linked worktree, the `post-checkout` hook installs dependencies and runs
`pnpm worktree:setup` through `mise`. That setup provisions databases owned by the worktree.

Repository commands refuse to run on a tool that does not answer as itself, because a check that
runs on a substituted tool reports a pass without doing the work. `pnpm check` and the `pre-push`
hook additionally refuse a version that disagrees with its `mise.toml` pin. Nothing turns either
refusal off; it names the `mise` command that repairs the toolchain instead. Run
`pnpm toolchain:verify` to see the state of your own PATH.

## Local checks

The repository has three levels of local check. Each one covers more suites than the one before it.

- `pnpm test:unit` runs the Vitest unit tests and the Python and Go unit tests.
- `pnpm test` runs all the Vitest tests and the Python, Go, Ruby, JVM, and .NET suites. It does not
  run the Rust suite. It needs the build outputs of `pnpm build:runtime`, and it stops before a test
  runs if one is missing.
- `pnpm check` is the full local gate. It builds the repository, then runs the format, lint, type,
  API, and security checks, `pnpm test`, the Rust gates, and the packed, site, and demo smoke tests.

If you change Rust code, run `pnpm rust:gates`, because `pnpm test` does not run the Rust suite. It
runs the Rust format check, clippy, `pnpm rust:test`, and the Rust conformance check.

## Generative tooling

You may use an assistant to draft a patch. You still review every line before you
submit, and you still sign `CLA.md`. If the tool’s terms would block Apache-2.0
publication, do not submit the output.

When a model produced a substantial part of the patch, end the commit message
with one `Co-Authored-By:` trailer per model, naming the exact model ID, for
example `Co-Authored-By: claude-fable-5-1 <noreply@anthropic.com>`. That is the
same trailer `AGENTS.md` asks of an agent's own commits. It does not replace the
review or the agreement.

Do not include third-party code the tool copied unless you can license it here.
Disclose that material in the pull request if it remains.

## Outbound licence

Do not add a Contribution under a different outbound licence. Apache License
section 5 already treats an unmarked submission as Apache-2.0; `CLA.md` is the
separate agreement on top of that.
