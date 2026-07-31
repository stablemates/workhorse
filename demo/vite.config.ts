import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { requireDevelopmentApiPort } from "./src/development-port.js";

const dashboardPort = Number(process.env.PORT ?? 3000);

export default defineConfig(({ command }) => {
  const apiTarget =
    command === "serve"
      ? `http://127.0.0.1:${requireDevelopmentApiPort(process.env.WORKHORSE_API_PORT)}`
      : undefined;

  return {
    root: "dashboard",
    base: "/",
    plugins: [react()],
    server: {
      port: dashboardPort,
      strictPort: true,
      proxy: apiTarget
        ? {
            "^/$": apiTarget,
            "/api": apiTarget,
            "/dashboard/events": apiTarget,
            "/demo": apiTarget,
            "/health": apiTarget,
            "/jobs": apiTarget,
            "/orders": apiTarget,
            "/rpc": apiTarget,
          }
        : undefined,
    },
    build: {
      outDir: "../dist/dashboard",
      emptyOutDir: true,
    },
  };
});
