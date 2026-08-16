import { readFileSync } from "node:fs";

import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Prerender targets come from `scripts/gen-seo.ts`, which reads the same
 * `lib/source.ts` loader the sidebar and the search index read. Importing the
 * loader directly here would need the MDX plugin that this config installs, so
 * the list travels through a generated file instead.
 */
const prerenderPages = JSON.parse(
  readFileSync(new URL("./.source/prerender.json", import.meta.url), "utf8"),
) as string[];

export default defineConfig({
  // The build is fully prerendered, so previewing it means serving static files.
  // Bind IPv4 explicitly: the default resolves to ::1 only, which a caller that
  // dials 127.0.0.1 cannot reach.
  preview: {
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? 4173),
    strictPort: true,
  },
  plugins: [
    tsconfigPaths(),
    tailwindcss(),
    fumadocsMdx(),
    tanstackStart({
      prerender: { enabled: true },
      pages: prerenderPages.map((path) => ({ path })),
    }),
    viteReact(),
  ],
});
