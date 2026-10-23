# Workhorse for .NET

Workhorse is a durable task queue for PostgreSQL. It is a set of versioned SQL functions in the
database that your application already uses, so it needs no broker and no server beside PostgreSQL.

## Packages

- `Workhorse`: the client, the worker, and the operator client `Admin`.
- `Workhorse.Hosting`: dependency injection, options, the hosted worker, and health checks for the
  Generic Host.
- `Workhorse.EntityFrameworkCore`: the Npgsql connection and the transaction of an EF Core
  `DbContext` for Workhorse calls.
- `Workhorse.AspNetCore`: the embedded dashboard backend for ASP.NET Core.

All four packages have the same version. Use the same version for each package that you add.

## Install

```bash
dotnet add package Workhorse
dotnet add package Workhorse.Hosting
dotnet add package Workhorse.EntityFrameworkCore
dotnet add package Workhorse.AspNetCore
```

Add only the packages that your application uses. Each package other than `Workhorse` depends on
`Workhorse`.

## Documentation

- Documentation: https://workhorse.run/docs
- Installation: https://workhorse.run/docs/installation
- Source code and issues: https://github.com/stablemates/workhorse
- License: Apache-2.0, https://github.com/stablemates/workhorse/blob/main/LICENSE
