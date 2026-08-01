# `@workhorse/dashboard`

Embeddable React operator dashboard for Workhorse. The package owns the UI, data contracts, theme,
styles, browser bundle, oRPC client, and provider-neutral server read model. It has no dependency on
the demo application.

For supported frameworks, prefer their complete mount adapter. For example,
`mountWorkhorseDashboard` from `@workhorse/hono` serves the package below `/workhorse` without the
host building its own dashboard or transport adapter.

The React surface remains available for custom integrations:

```tsx
import { Dashboard, WorkhorseThemeProvider } from "@workhorse/dashboard";
import { createDashboardClient } from "@workhorse/dashboard/client";
import "@workhorse/dashboard/styles.css";

const client = createDashboardClient("/workhorse/rpc");
root.render(
  <WorkhorseThemeProvider>
    <Dashboard client={client} basePath="/workhorse" />
  </WorkhorseThemeProvider>,
);
```

Set `eventsUrl={null}` when a custom host does not expose server-sent refresh events. The demo's
job-seeding menu is not part of the required client contract. Opt into it with `demoTools` only when
a host intentionally supplies demo fixtures. All sample and seed data remain owned by the demo
project, never this package.
