# `@stablemates/workhorse-dashboard`

The React operator dashboard and compatibility facade for Workhorse dashboard server APIs.

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
npm install @stablemates/workhorse @stablemates/workhorse-dashboard react react-dom
```

## Mount the dashboard

```ts
import { createDashboardHost } from "@stablemates/workhorse-dashboard/server";

const host = createDashboardHost({
  path: "/workhorse",
  database: pool,
  authorize: (request) => (isApplicationAdmin(request) ? { actor: "admin" } : false),
});

const response = (await host.handle(request)) ?? new Response("Not found", { status: 404 });
```

## Package boundary

This facade packages the React application and preserves the public server, client, wire, presentation,
and standalone subpaths. The server remains responsible for schema compatibility checks and never
installs schema or owns the caller's database. [Workhorse core](https://workhorse.run/docs/installation) owns schema
installation and changes. The embedding application owns authentication, authorization, routing, and
the browser-visible origin.

Applications rendering the React components directly must include
`@stablemates/workhorse-dashboard/styles.css` and wrap `Dashboard` in `WorkhorseThemeProvider` so
operator results remain visible.

## Next

- Read the [dashboard guide](https://workhorse.run/docs/dashboard) and
  [API reference](https://workhorse.run/docs/api).
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
