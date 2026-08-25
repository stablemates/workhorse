import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defaultClientConditions, defineConfig } from "vite";
import { renderDashboardHtml } from "@stablemates/workhorse-dashboard-server/server";

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

export default defineConfig({
  root: "browser",
  base: "./",
  plugins: [
    react(),
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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/@mantine/charts/")) return "mantine-charts";
          if (id.includes("/node_modules/@mantine/notifications/")) return "notifications";
          if (id.includes("/node_modules/@mantine/")) return "mantine";
          if (id.includes("/node_modules/@phosphor-icons/")) return "icons";
          if (id.includes("/node_modules/react") || id.includes("/node_modules/scheduler")) {
            return "react";
          }
          return undefined;
        },
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
