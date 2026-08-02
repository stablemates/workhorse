import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const workspaceRoot = resolve(import.meta.dirname, "..");
const dashboardBrowserRoot = resolve(workspaceRoot, "packages/dashboard/browser");
const dashboardSource = resolve(workspaceRoot, "packages/dashboard/src");
const reactGrabEntry = resolve(import.meta.dirname, "browser/react-grab.ts");
const publicPort = Number(process.env.PORT ?? 3000);
const apiPort = Number(process.env.WORKHORSE_API_PORT ?? publicPort + 1);
const basePath = "";
const legacyBasePath = "/workhorse";

export default defineConfig({
  root: dashboardBrowserRoot,
  base: "/",
  appType: "spa",
  clearScreen: false,
  plugins: [
    react(),
    {
      name: "workhorse-demo-development-runtime",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? "/", "http://workhorse.local");
          const destination =
            url.pathname === "/"
              ? "/tasks"
              : url.pathname === legacyBasePath
                ? `/tasks${url.search}`
                : url.pathname.startsWith(`${legacyBasePath}/`)
                  ? `${url.pathname.slice(legacyBasePath.length)}${url.search}`
                  : null;
          if (destination === null) return next();
          response.statusCode = 302;
          response.setHeader("location", destination);
          response.end();
        });
      },
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          const runtime = {
            basePath,
            rpcUrl: `${basePath}/rpc`,
            auditActor: "local-demo",
            demoTools: true,
          };
          return html
            .replace(
              "/*__WORKHORSE_RUNTIME_CONFIG__*/",
              `window.workhorseDashboard=${JSON.stringify(runtime).replaceAll("<", "\\u003c")}`,
            )
            .replace(
              "<!--__WORKHORSE_BROWSER_MODULES__-->",
              `<script type="module" src="/@fs/${reactGrabEntry}"></script>`,
            );
        },
      },
    },
  ],
  resolve: {
    alias: { "/src": dashboardSource },
  },
  server: {
    host: "127.0.0.1",
    port: publicPort,
    strictPort: true,
    fs: { allow: [workspaceRoot] },
    proxy: {
      [`${basePath}/rpc`]: `http://127.0.0.1:${apiPort}`,
      [`${basePath}/events`]: `http://127.0.0.1:${apiPort}`,
    },
  },
});
