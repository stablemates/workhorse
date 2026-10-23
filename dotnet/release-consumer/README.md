# .NET release consumer

`scripts/check-dotnet-release.ts` (`pnpm dotnet:package-check`) copies this project to a temporary
directory and builds it against the packed packages. The copy gets a `nuget.config` that takes
`Workhorse` and `Workhorse.*` only from the local feed of the packed files, and every other package
from nuget.org. The restore uses an empty package folder, so no package from an earlier run takes
the place of a packed file.

- Without an argument, the program prints the informational version of each of the four package
  assemblies.
- With an Npgsql connection string, the program also enqueues one task, runs it through the hosted
  worker of `Workhorse.Hosting` on the Generic Host, and prints the task id. The check then reads
  the task row back.

`Directory.Build.props` and `Directory.Packages.props` in this directory stop MSBuild before it
reaches the files in `dotnet/`, so the consumer builds as an application does.

The consumer uses the public API as an application does. A change to that API updates this
program too.
