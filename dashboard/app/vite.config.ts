import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defaultClientConditions, defineConfig } from "vite";
import { renderDashboardHtml } from "@stablemates/workhorse-dashboard-server/server";
import { WORKHORSE_VERSION } from "@stablemates/workhorse/version";
import { dashboardThirdPartyNotices } from "./third-party-notices.js";

/**
 * Build and development configuration for the dashboard's own browser application.
 *
 * `vite build` produces the packaged bundle that `createDashboardHost` serves. `vite` (dev) runs
 * the same entry from source with HMR and proxies the private oRPC transport to a backend that
 * already speaks it — a running demo, or `workhorse dashboard`.
 *
 * The harness lives here rather than in an application because it points at this package's own
 * source. An application consuming the published package cannot reach `src/`, so a harness that
 * lived there would demonstrate an integration nobody could copy.
 */
const apiOrigin = process.env.WORKHORSE_DASHBOARD_API ?? "http://127.0.0.1:3000";
const port = Number(process.env.PORT ?? 4173);
/**
 * The harness talks to a real backend, so its audit attribution has to match what that backend
 * records. Hardcoding a different actor here would mean the same action wrote a different name
 * depending on which port an operator happened to have open.
 */
const auditActor = process.env.WORKHORSE_DASHBOARD_ACTOR ?? "dashboard-dev";
const demoTools = process.env.WORKHORSE_DASHBOARD_DEMO_TOOLS !== "false";
const reactGrabEntry = resolve(import.meta.dirname, "browser/react-grab.ts");

/**
 * Matches a module inside one of the named npm package directories, and nothing else.
 *
 * A prefix test such as `/node_modules/react` also matches `react-redux`, `react-is`, and every
 * other `react-*` package. Ending the match at the directory separator keeps each group to the
 * packages it names. pnpm keeps the package directory name under `.pnpm/<id>/node_modules/`, so
 * the same pattern works for both layouts.
 */
function packageDirectories(...names: readonly string[]): RegExp {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  return new RegExp(`[\\\\/]node_modules[\\\\/](?:${escaped.join("|")})[\\\\/]`);
}

/**
 * The named vendor chunks of the browser bundle, highest priority first.
 *
 * Rolldown also puts each captured module's dependencies into its group. A higher priority makes
 * a group capture its own packages before a lower group takes them as dependencies. React has the
 * highest priority, so React, React DOM, and the scheduler stay in the eager `react` chunk and no
 * Mantine or icon chunk holds them. The icon group holds every icon package, including the
 * Hugeicons glyphs of the Graphical components. The Base UI group holds the primitives of those
 * components, which the shell loads at once; without it, they and the Graphical source made one
 * chunk above the 500 KB limit of `scripts/generate-dashboard-bundle.ts`. The motion group holds the
 * animation library of those components. The chart group takes Recharts and its Redux store as its
 * dependencies, so that code loads only with the lazy activity chart. Every module that no group
 * matches, such as the page modules, stays in Rolldown's default chunking.
 * `src/bundle-architecture.test.ts` builds the bundle and pins the contents of each chunk.
 */
const dashboardVendorChunks = [
  { name: "react", test: packageDirectories("react", "react-dom", "scheduler"), priority: 50 },
  { name: "mantine", test: packageDirectories("@mantine/core", "@mantine/hooks"), priority: 40 },
  {
    name: "icons",
    test: packageDirectories("@hugeicons/react", "@hugeicons/core-free-icons", "lucide-react"),
    priority: 30,
  },
  { name: "base-ui", test: packageDirectories("@base-ui/react", "@base-ui/utils"), priority: 35 },
  {
    name: "motion",
    test: packageDirectories("motion", "motion-dom", "motion-utils", "framer-motion"),
    priority: 25,
  },
  { name: "notifications", test: packageDirectories("@mantine/notifications"), priority: 20 },
  { name: "mantine-charts", test: packageDirectories("@mantine/charts"), priority: 10 },
] as const;

export default defineConfig({
  root: "browser",
  base: "./",
  plugins: [
    react(),
    dashboardThirdPartyNotices(),
    {
      name: "workhorse-dashboard-development-runtime",
      enforce: "pre",
      apply: "serve",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          // The production host fills this same template through the same function, so developing
          // against source cannot drift from what a consumer is served.
          return renderDashboardHtml(html, {
            runtime: {
              basePath: "",
              rpcUrl: "/rpc",
              auditActor,
              workhorseVersion: WORKHORSE_VERSION,
              authentication: null,
              demoTools,
              workspaces: [],
              workspace: null,
            },
            browserModules: [`/@fs/${reactGrabEntry}`],
          });
        },
      },
    },
  ],
  build: {
    outDir: "../dist/app",
    emptyOutDir: false,
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [...dashboardVendorChunks] },
      },
    },
  },
  // The workspace packages expose their TypeScript source under `workhorse-source`, so this
  // harness compiles them from source instead of waiting for a build. The published packages keep
  // resolving to `dist`, because nothing outside this repository asks for that condition.
  resolve: {
    alias: { "/src": new URL("./src", import.meta.url).pathname },
    conditions: ["workhorse-source", ...defaultClientConditions],
  },
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: {
      "/rpc": apiOrigin,
    },
  },
});
