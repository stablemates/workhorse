import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { requireDevelopmentApiPort } from "./src/development-port.js";

const dashboardPort = Number(process.env.PORT ?? 3000);
const apiPort = requireDevelopmentApiPort(process.env.WORKHORSE_API_PORT);
const apiTarget = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  root: "dashboard",
  base: "/",
  plugins: [react()],
  server: {
    port: dashboardPort,
    strictPort: true,
    proxy: {
      "^/$": apiTarget,
      "/api": apiTarget,
      "/dashboard/events": apiTarget,
      "/demo": apiTarget,
      "/health": apiTarget,
      "/jobs": apiTarget,
      "/orders": apiTarget,
      "/rpc": apiTarget,
    },
  },
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
  },
});
