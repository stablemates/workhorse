# .NET release consumer

`pnpm release:verify nuget` (`scripts/verify-release.ts`) copies this project to a scratch directory
and restores it into an empty package folder. Without `--nuget-feed`, the copy gets a `nuget.config`
that takes every package from nuget.org. With `--nuget-feed`, the copy takes `Workhorse` and
`Workhorse.*` only from that feed, and every other package from nuget.org. The target checks the
source of each of the four packages. `scripts/check-dotnet-release.ts` (`pnpm dotnet:package-check`)
runs the target with the feed of the packed files.

- Without an argument, the program prints the informational version of each of the four package
  assemblies.
- With an Npgsql connection string, the program also enqueues one task, runs it through the hosted
  worker of `Workhorse.Hosting` on the Generic Host, and prints the task id. After the rehearsal,
  `pnpm dotnet:package-check` reads the task row back.

`Directory.Build.props` and `Directory.Packages.props` in this directory stop MSBuild before it
reaches the files in `dotnet/`, so the consumer builds as an application does.

The consumer uses the public API as an application does. A change to that API updates this
program too.
