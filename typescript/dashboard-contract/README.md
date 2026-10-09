# `@stablemates/workhorse-dashboard-contract`

The type-only contract shared by the Workhorse CLI and standalone dashboard implementation.

> **Public beta:** Workhorse is usable for evaluation and early production adoption. A 0.x minor
> release may change behaviour, so read the changelog before you upgrade. It will not ask you to
> recreate your database: migrations are ordered, and inside a major line a migration only adds, so
> a running deployment upgrades in place.

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
