import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * Prerender targets come from `scripts/gen-docs-index.ts`, which reads the
 * content the same way as the sitemap and the agent files. The list leaves out
 * the documentation pages, which Blume builds.
 */
const prerenderPages = JSON.parse(
  readFileSync(new URL("./.source/prerender.json", import.meta.url), "utf8"),
) as string[];

/**
 * `vite preview` serves the built site, but it answers `/docs/<slug>` with the
 * app shell rather than the page file that Blume wrote at
 * `docs/<slug>/index.html`. nginx resolves that file itself (`site/nginx.conf`).
 * This middleware does the same for the preview server, so a smoke test of the
 * preview reads the real documentation page.
 */
function previewDocsPages(): Plugin {
  return {
    name: "workhorse:preview-docs-pages",
    configurePreviewServer(server) {
      const clientDir = join(server.config.root, "dist/client");
      server.middlewares.use((request, _response, next) => {
        const path = request.url?.split("?")[0] ?? "";
        const isDocs = path === "/docs" || path.startsWith("/docs/");
        if (isDocs && extname(path) === "") {
          const page = `${path.replace(/\/$/, "")}/index.html`;
          if (existsSync(join(clientDir, page))) request.url = page;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  // The build is fully prerendered, so previewing it means serving static files.
  // Bind IPv4 explicitly: the default resolves to ::1 only, which a caller that
  // dials 127.0.0.1 cannot reach.
  preview: {
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? 4173),
    strictPort: true,
  },
  plugins: [
    previewDocsPages(),
    tailwindcss(),
    fumadocsMdx(),
    tanstackStart({
      prerender: {
        enabled: true,
        // The prerenderer follows the links it finds. Blume builds every page
        // under /docs (`blume/`), so this app must not write one there too.
        filter: ({ path }) => path !== "/docs" && !path.startsWith("/docs/"),
      },
      pages: prerenderPages.map((path) => ({ path })),
    }),
    viteReact(),
  ],
});
