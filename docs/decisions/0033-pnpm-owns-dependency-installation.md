# ADR 0033: Let pnpm own dependency installation

- **Status:** Accepted
- **Date:** 2026-08-16
- **Related:** [ADR 0028](0028-flat-per-language-repository-layout.md)

## Context

Workhorse uses `pnpm-workspace.yaml`, pnpm workspace filters, and pnpm directory commands.
Those commands define how the repository installs and runs its packages.

Bun can run a package script, but `bun install` creates `bun.lock` and can migrate the pnpm lockfile.
That changes the dependency layout without changing a product dependency.

## Decision

pnpm owns dependency installation. Developers run `pnpm install` to create `node_modules` and
update `pnpm-lock.yaml`.

The root `preinstall` script rejects a Bun package-manager user agent and names the required
pnpm command. It is plain JavaScript run by `node`, because `preinstall` runs before any
devDependency exists. The repository ignores `bun.lock` and `bun.lockb`, then a failed Bun attempt is
removed before the next pnpm install.

Bun and pnpm both run repository scripts. `bun run <script>` and `pnpm run <script>` are supported.
Scripts retain their pnpm workspace commands so each command keeps its existing package selection.

## Consequences

- A Bun install fails with a command that tells the developer to run `pnpm install`.
- A pnpm install remains the only operation that changes the tracked lockfile.
- A developer can use Bun as a script runner without changing the package manager.
- A future change that makes Bun own installation must replace the pnpm workspace commands and
  record a new decision.

## Rejected alternatives

### Let either package manager install dependencies

The package managers use different lockfiles and installation layouts. Allowing both makes a
routine local install change the repository state unexpectedly.

### Allow Bun installs and ignore its lockfile

Ignoring the lockfile hides the change but does not stop Bun from replacing the dependency layout.
The next pnpm install still needs to repair it.
