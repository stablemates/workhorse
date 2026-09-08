# Workhorse dashboard application

The shared Workhorse operator application. Its browser source and compiled static artifact live
outside any language SDK; `@stablemates/workhorse-dashboard-server` supplies the current Node.js backend, and
`typescript/dashboard` publishes the compatibility package.

The UI uses owned shadcn/ui components, Radix interaction primitives, Tailwind CSS, Recharts,
and Sonner notifications. Shared components live in `src/ui`; `src/styles.css` owns the neutral
light/dark theme and the responsive dashboard layout. `components.json` configures shadcn for
future additions. Keep controller behavior and refresh blockers outside visual components.

Both build targets compile Tailwind into `dist/library/styles.css`, so embedding applications
can import the dashboard stylesheet without installing Tailwind. Run `pnpm build:dashboard`
from the repository root to regenerate the shared browser bundle for all language hosts.
