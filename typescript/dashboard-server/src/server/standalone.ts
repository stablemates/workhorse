import { createServer } from "node:http";
import { isIP } from "node:net";
import type { DashboardStandaloneModule } from "@stablemates/workhorse-dashboard-contract";
import { Admin, Queue, type Queryable } from "@stablemates/workhorse";
import { createDashboardHost } from "./host.js";
import { dashboardNodeMiddleware, normalizeDashboardPublicOrigin } from "./node.js";
import { createDashboardOperatorControllers } from "./operator-controllers.js";

/**
 * Serve the operator dashboard as its own process against any Workhorse database.
 *
 * The caller owns the database connection and its shutdown. This module owns the HTTP listener and
 * the dashboard implementation, so core only depends on the small standalone contract.
 */
/**
 * Browser protections for a listener that owns its whole origin.
 *
 * The standalone process serves nothing but the dashboard, so it can state one policy for every
 * response. An embedded host cannot: its own pages share the origin, and a second policy on the
 * dashboard's responses would intersect with the application's own. An embedder therefore owns
 * these headers, and `typescript/dashboard-server/README.md` states the policy to copy.
 *
 * `unsafe-inline` covers the two inline boot scripts in the packaged document, the runtime
 * configuration this host writes into it, and the style elements the application injects while it
 * renders. No response references a remote origin.
 */
const STANDALONE_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
].join("; ");

const STANDALONE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": STANDALONE_CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 4) return normalized.startsWith("127.");
  return family === 6 && normalized === "::1";
}

export const startDashboardServer: DashboardStandaloneModule<Queryable>["startDashboardServer"] =
  async (database, options) => {
    const publicOrigin = options.publicOrigin
      ? normalizeDashboardPublicOrigin(options.publicOrigin)
      : undefined;
    const tcpListener = !options.socketPath;
    const loopbackListener = tcpListener && isLoopbackHostname(options.hostname);
    if (!options.authentication && tcpListener && !loopbackListener) {
      throw new TypeError(
        "The unauthenticated dashboard development bypass requires a loopback listener or Unix socket",
      );
    }
    if (publicOrigin) {
      const origin = new URL(publicOrigin);
      if (!options.authentication && !isLoopbackHostname(origin.hostname)) {
        throw new TypeError(
          "The unauthenticated dashboard development bypass cannot use a remote public origin",
        );
      }
      if (
        origin.protocol !== "https:" &&
        (!isLoopbackHostname(origin.hostname) || (tcpListener && !loopbackListener))
      ) {
        throw new TypeError("A remote dashboard requires an HTTPS public origin");
      }
    }
    if (options.authentication && tcpListener && !loopbackListener && !publicOrigin) {
      throw new TypeError(
        "An authenticated remote dashboard requires an explicit HTTPS public origin",
      );
    }
    // Each database gets its own clients so mutations in one workspace can never reach another.
    const workspaceControls = (workspaceDatabase: Queryable) => {
      const queue = new Queue(workspaceDatabase);
      const admin = new Admin(workspaceDatabase);
      return options.allowMutations
        ? createDashboardOperatorControllers({
            run: (_action, operation) => operation({ admin, queue }),
          })
        : { operator: { mode: "read-only" as const } };
    };
    const workspaceTarget =
      typeof database === "object" && database !== null && "workspaces" in database
        ? database
        : undefined;

    const host = createDashboardHost({
      path: "/",
      environment: "standalone",
      auditActor: options.actor,
      ...(options.authentication
        ? { singleAdmin: options.authentication }
        : {
            // The missing credential mode is an explicit local development bypass. The CLI keeps
            // it on loopback unless an operator deliberately widens the listener.
            authorize: () => true,
          }),
      ...(workspaceTarget
        ? {
            workspaces: Object.fromEntries(
              Object.entries(workspaceTarget.workspaces).map(([name, workspaceDatabase]) => [
                name,
                { database: workspaceDatabase, ...workspaceControls(workspaceDatabase) },
              ]),
            ),
            defaultWorkspace: workspaceTarget.defaultWorkspace,
          }
        : { database: database as Queryable, ...workspaceControls(database as Queryable) }),
    });

    const middleware = dashboardNodeMiddleware(host, { publicOrigin });
    const server = createServer((request, response) => {
      // Set before the middleware writes, so every response the listener produces carries them and
      // a dashboard response that names one of these headers itself still wins.
      for (const [name, value] of Object.entries(STANDALONE_SECURITY_HEADERS)) {
        response.setHeader(name, value);
      }
      middleware(request, response, () => {
        response.statusCode = 404;
        response.end("Not found");
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      const onListening = (): void => {
        server.removeListener("error", reject);
        resolve();
      };
      if (options.socketPath) server.listen(options.socketPath, onListening);
      else server.listen(options.port, options.hostname, onListening);
    });

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    return {
      url:
        publicOrigin ??
        (options.socketPath
          ? `unix://${options.socketPath}`
          : `http://${options.hostname}:${port}`),
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  };
