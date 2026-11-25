# `@stablemates/workhorse-dashboard-contract`

The type-only contract shared by the Workhorse CLI and standalone dashboard implementation.

> Workhorse follows Semantic Versioning from 1.0.0. A 1.x minor or patch release does not break a
> governed surface, such as the API of this package. Read [what 1.0.0
> promises](https://workhorse.run/docs/compatibility#know-what-100-promises) and the changelog
> before you upgrade. A release does not make you create your database again. Migrations are
> ordered, and inside a major line a migration only adds. Thus, a running deployment upgrades in
> place.
> Migration 0025 is the one exception. If your database is from a release before 0.5.0, upgrade it
> offline with [these steps](https://workhorse.run/docs/installation#upgrade-a-04x-database-offline).

## Install

```bash
npm install --save-dev @stablemates/workhorse-dashboard-contract
```

## Use the contract

```ts
import type {
  DashboardCommandOptions,
  DashboardStandaloneModule,
} from "@stablemates/workhorse-dashboard-contract";

declare const dashboard: DashboardStandaloneModule<Database>;
declare const database: Database;

const options: DashboardCommandOptions = {
  port: 3000,
  hostname: "127.0.0.1",
  allowMutations: false,
  actor: "local-operator",
};

await dashboard.startDashboardServer(database, options);
```

## Package boundary

This package contains declarations only. It owns no server, browser bundle, database connection, or
schema, and closing a conforming dashboard never closes the caller's database. Most applications
should install `@stablemates/workhorse-dashboard` and use its public server APIs instead.

## Next

- Read the [dashboard guide](https://workhorse.run/docs/dashboard) and
  [API reference](https://workhorse.run/docs/api).
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
