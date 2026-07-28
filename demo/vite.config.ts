import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dashboardPort = Number(process.env.PORT ?? 3000);
const apiPort = Number(process.env.WORKHORSE_API_PORT ?? 3001);
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
