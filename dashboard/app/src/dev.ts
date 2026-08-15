import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Development-mode dashboard: the browser entry compiled from source, with hot reload.
 *
 * This exists so a host does not need a second server to develop the dashboard UI. Mount
 * `middlewares` in front of your application and hand `template` and `transformHtml` to
 * `createDashboardHost`, and one origin serves both the live-compiled frontend and your API — the
 * HTML still going through the same host code path a production consumer uses.
 *
 * `vite` is an optional peer. It is loaded on demand, so an application that never runs this in
 * development does not carry a bundler in its dependency tree.
 */
export interface DashboardDevServer {
  /**
   * Connect-style middleware serving the dashboard's source modules and hot-reload client.
   *
   * It must run before your application's routing, and it calls `next()` for anything it does not
   * own, so API routes are unaffected.
   */
  middlewares: (
    request: IncomingMessage,
    response: ServerResponse,
    next: (error?: unknown) => void,
  ) => void;
  /** Read the source HTML template rather than the packaged one. */
  readTemplate(): Promise<string>;
  /** Apply the dev-server transforms that inject the hot-reload client and rewrite entry URLs. */
  transformHtml(url: string, html: string): Promise<string>;
  close(): Promise<void>;
}

function packageRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  // Source sits in `src/`; the published module sits in `dist/library/`.
  return basename(moduleDirectory) === "library"
    ? dirname(dirname(moduleDirectory))
    : dirname(moduleDirectory);
}

export interface DashboardDevServerOptions {
  /** Override the browser root. Defaults to this package's own `browser/` directory. */
  root?: string;
}

/**
 * Start Vite in middleware mode against the dashboard's browser entry.
 *
 * Middleware mode is what collapses development to a single origin: Vite serves modules and the
 * hot-reload socket, while the host application keeps serving its own routes and the dashboard HTML.
 */
export async function createDashboardDevServer(
  options: DashboardDevServerOptions = {},
): Promise<DashboardDevServer> {
  let vite: typeof import("vite");
  try {
    vite = await import("vite");
  } catch (error) {
    throw new Error(
      "createDashboardDevServer requires vite. Install it as a development dependency.",
      { cause: error },
    );
  }

  const root = options.root ?? join(packageRoot(), "browser");
  const server = await vite.createServer({
    root,
    base: "/",
    // The host owns HTML, so Vite must not try to serve an index itself.
    appType: "custom",
    server: { middlewareMode: true },
    resolve: { alias: { "/src": join(packageRoot(), "src") } },
  });

  return {
    middlewares: server.middlewares,
    readTemplate: () => readFile(join(root, "index.html"), "utf8"),
    transformHtml: (url, html) => server.transformIndexHtml(url, html),
    close: () => server.close(),
  };
}
