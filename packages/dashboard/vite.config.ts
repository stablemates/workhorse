import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "browser",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../dist/app",
    emptyOutDir: false,
  },
  resolve: {
    alias: { "/src": new URL("./src", import.meta.url).pathname },
  },
});
