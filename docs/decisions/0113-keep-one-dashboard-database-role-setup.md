# ADR 0113: Keep one dashboard database role setup

- **Status:** Accepted
- **Date:** 2026-10-24
- **Related:** [ADR 0022](0022-built-in-dashboard-authentication.md)
- **Issue:** SM-1710, after SM-1667 (SEC-02)

## Context

ADR 0022 keeps direct PostgreSQL access outside dashboard authorization. SM-1667 added the database
role guidance in [Operations: Database roles](../architecture/operations.md#database-roles). That
guidance gives a read-only dashboard role `USAGE` on the `workhorse` schema and `SELECT` on each
table in it.

An operator can want a narrower role that reads only what the dashboard shows.

**Example.**

1. An operator creates a role with `USAGE` on the `workhorse` schema and `SELECT` on the 24
   `dashboard_*_v1` views only.
2. The dashboard calls the read function `dashboard_queues_v1`.
3. PostgreSQL refuses the call with "permission denied", because the function reads base tables
   and runs with the privileges of the role that calls it.
4. To make the dashboard work, the operator gives `SELECT` on the base tables. These tables hold
   raw payloads, results, checkpoints, and human-wait context.

The SM-1667 worker checked this on a PostgreSQL 18 scratch database, with the schema of `main` at
`12b98123f`:

- All 237 `workhorse` functions are `SECURITY INVOKER`. The schema has no `GRANT` or `REVOKE`, so
  PostgreSQL gives `EXECUTE` on each function to `PUBLIC`.
- With `SELECT` on the views only, the read functions `dashboard_queues_v1`, `dashboard_system_v1`,
  `dashboard_settings_v1`, `dashboard_human_waits_v1`, `dashboard_task_groups_v1`, and
  `queue_health_v1` fail. On an empty database, they succeed only after `SELECT` on 31 base tables.

The views are not the cause. A view reads its base tables with the privileges of the view owner.
The cause is the read functions. Each one is `SECURITY INVOKER`, and it reads base tables with the
privileges of the caller. Thus PostgreSQL cannot limit a dashboard role to the governed views with
the installed schema. A narrower role needs a schema change.

## Decision

**Workhorse does not offer a separate, narrower dashboard read role.**

1. The product keeps one documented role setup: the four roles of
   [Operations: Database roles](../architecture/operations.md#database-roles). That guidance is the
   documented answer for dashboard database access.
2. The read-only dashboard role keeps `SELECT` on each table in the `workhorse` schema.
3. The schema adds no `SECURITY DEFINER` function for the dashboard, and it installs no
   `GRANT` or `REVOKE`.

The reason is setup cost. Each extra role is one more step to create, grant, and repeat after each
migration. More setup steps make adoption harder, and they can make users leave the product. One
documented setup is easier to follow and to test.

## Consequences

- The dashboard role can read each raw payload, result, checkpoint value, progress value, and
  human-wait context as stored. The payload and result redaction keys change only what the
  dashboard shows. Thus operators must treat the credentials of each dashboard role as
  confidential, at the same level as the stored task data.
- The read-only dashboard mode stays an application check. The read-only grants add a second check
  in PostgreSQL that refuses writes. They are not a redaction boundary.
- `typescript/dashboard-server/test/database-roles-integration.test.ts` continues to run the
  documented SQL on a scratch database. No migration, schema, grant, or dashboard host changes.

## Alternatives considered

- **`SECURITY DEFINER` read functions owned by the installation role.** The views already use the
  privileges of their owner, so they need no change. The dashboard read functions would run with
  the privileges of the owner. Then a role with `SELECT` on the views and `EXECUTE` on these
  functions could use the dashboard. This was not chosen for three reasons:
  1. Each definer function must set a safe `search_path`. It must also not expose other privileges
     of the owner. Thus each change to a dashboard read needs a security review.
  2. The schema must revoke `EXECUTE` from `PUBLIC` on these functions. Thus each existing
     installation needs a migration and new grant steps.
  3. The operator gets one more role to set up and keep current.
- **Explicit grants in the schema.** The installation would give the privileges to roles with
  fixed names. This was not chosen, because Workhorse creates no database role, and the operator
  chooses the role names. Fixed names add setup steps for each installation that does not use
  them, and the operator must still create the roles.
