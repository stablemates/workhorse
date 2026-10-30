import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import type { DashboardStandaloneModule } from "@stablemates/workhorse-dashboard-contract";
import { Admin, Queue, type Queryable } from "@stablemates/workhorse";
import { createDashboardHost } from "./host.js";
import { dashboardNodeMiddleware, normalizeDashboardPublicOrigin } from "./node.js";
import { createDashboardOperatorControllers } from "./operator-controllers.js";
import { trustedProxyCheck } from "./trusted-proxy.js";
import type {
  DashboardAuditContext,
  DashboardScheduleController,
  DashboardSettingsController,
} from "./types.js";

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

/**
 * Schedule pause and resume for a standalone process that allows mutations.
 *
 * No client wraps `set_schedule_paused_v1`, so the host calls it as the other SDK hosts do. The
 * function records the actor and the reason of the request as the pause attribution.
 */
function standaloneScheduleController(database: Queryable): DashboardScheduleController {
  return {
    async setSchedulePaused(namespace, name, paused, audit) {
      const result = await database.query<{ paused: boolean | null }>(
        "SELECT workhorse.set_schedule_paused_v1($1::text, $2::text, $3::boolean, $4::text, $5::text) AS paused",
        [namespace, name, paused, audit.actor, audit.reason],
      );
      const changed = result.rows[0]?.paused;
      if (changed === null || changed === undefined) {
        throw new Error(`Schedule ${namespace}/${name} not found`);
      }
      return { paused: changed };
    },
  };
}

/** One policy change of a standalone dashboard, with the audit context of the request. */
interface StandalonePolicyAuditRecord {
  event: "workhorse.dashboard.policy_changed";
  action:
    | "overrideMaintenancePolicy"
    | "revertMaintenancePolicy"
    | "overrideRetentionPolicy"
    | "revertRetentionPolicy";
  /** The definition of an override, or the settings of a revert. */
  change: unknown;
  /** The workspace that the change applies to. Single-workspace mode has no name and no field. */
  workspace?: string;
  actor: string;
  reason: string;
  /** The request ID as `queue_control` keeps it: a short preview, a digest, and the length. */
  requestIdPreview: string;
  requestIdDigest: string;
  requestIdLength: number;
  occurredAt: string;
}

/** The request ID evidence that `set_queue_paused_v1` stores, so a log line holds no raw ID. */
function requestIdEvidence(
  requestId: string,
): Pick<StandalonePolicyAuditRecord, "requestIdPreview" | "requestIdDigest" | "requestIdLength"> {
  const characters = [...requestId];
  const length = characters.length;
  const preview =
    length <= 4
      ? "•".repeat(length)
      : length <= 8
        ? `${characters.slice(0, 2).join("")}…${characters.slice(-2).join("")}`
        : `${characters.slice(0, 8).join("")}…${characters.slice(-4).join("")}`;
  return {
    requestIdPreview: preview,
    requestIdDigest: createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 12),
    requestIdLength: length,
  };
}

/** Write one audit record as one JSON line on the standard output of the process. */
function writePolicyAuditRecord(record: StandalonePolicyAuditRecord): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/** Run one policy change, then write its audit record. A failed change writes none. */
async function audited(
  action: StandalonePolicyAuditRecord["action"],
  change: unknown,
  workspace: string | null,
  audit: DashboardAuditContext,
  operation: () => Promise<unknown>,
): Promise<void> {
  await operation();
  writePolicyAuditRecord({
    event: "workhorse.dashboard.policy_changed",
    action,
    change,
    // The RPC log names the workspace the same way.
    ...(workspace === null ? {} : { workspace }),
    actor: audit.actor,
    reason: audit.reason,
    ...requestIdEvidence(audit.requestId),
    occurredAt: audit.occurredAt ?? new Date().toISOString(),
  });
}

/**
 * Database-wide maintenance and retention policy changes, through the workspace queue.
 *
 * The policy functions keep no attribution, and the standalone process owns no audit table in the
 * database of the operator. After each successful change, the process writes the actor, the
 * reason, and the request ID evidence to its log, as an embedded host records them in its own
 * audit table. A failed change writes no record. A process that serves several workspaces names
 * the workspace in each record.
 */
function standaloneSettingsController(
  queue: Queue,
  workspace: string | null,
): DashboardSettingsController {
  return {
    overrideMaintenancePolicy: (definition, audit) =>
      audited("overrideMaintenancePolicy", definition, workspace, audit, () =>
        queue.overrideMaintenancePolicy(definition),
      ),
    revertMaintenancePolicy: (settings, audit) =>
      audited("revertMaintenancePolicy", settings, workspace, audit, () =>
        queue.revertMaintenancePolicy(settings),
      ),
    overrideRetentionPolicy: (definition, audit) =>
      audited("overrideRetentionPolicy", definition, workspace, audit, () =>
        queue.overrideRetentionPolicy(definition),
      ),
    revertRetentionPolicy: (settings, audit) =>
      audited("revertRetentionPolicy", settings, workspace, audit, () =>
        queue.revertRetentionPolicy(settings),
      ),
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 4) return normalized.startsWith("127.");
  return family === 6 && normalized === "::1";
}

/**
 * The `host:port` values a browser uses to reach a loopback listener.
 *
 * `localhost` is included because browsers resolve it to loopback themselves, so no remote name
 * server can point it elsewhere.
 */
function loopbackHosts(hostname: string, port: number): string[] {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const address = isIP(bare) === 6 ? `[${bare}]` : bare;
  return [`${address}:${port}`, `localhost:${port}`];
}

export const startDashboardServer: DashboardStandaloneModule<Queryable>["startDashboardServer"] =
  async (database, options) => {
    const publicOrigin = options.publicOrigin
      ? normalizeDashboardPublicOrigin(options.publicOrigin)
      : undefined;
    const trustedProxies = options.trustedProxies ?? [];
    // Refuse a malformed setting before the listener binds.
    trustedProxyCheck(trustedProxies);
    const tcpListener = !options.socketPath;
    if (!tcpListener && trustedProxies.length > 0) {
      throw new TypeError(
        "Dashboard trusted proxies require a TCP listener, because a Unix socket peer has no address",
      );
    }
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
    // A persisted stack names container paths and package internals. A browser that is not on
    // this machine sees them only when the operator asks for them.
    const remotelyReachable =
      (tcpListener && !loopbackListener) ||
      (publicOrigin !== undefined && !isLoopbackHostname(new URL(publicOrigin).hostname));
    const redactErrorStacks = remotelyReachable && !options.revealErrorStacks;
    // Each database gets its own clients so mutations in one workspace can never reach another.
    const workspaceControls = (workspaceDatabase: Queryable, workspace: string | null) => {
      const queue = new Queue(workspaceDatabase);
      const admin = new Admin(workspaceDatabase);
      const controls = options.allowMutations
        ? {
            ...createDashboardOperatorControllers({
              run: (_action, operation) => operation({ admin, queue }),
            }),
            scheduleController: standaloneScheduleController(workspaceDatabase),
            settingsController: standaloneSettingsController(queue, workspace),
          }
        : { operator: { mode: "read-only" as const } };
      return { ...controls, redactErrorStacks };
    };
    const workspaceTarget =
      typeof database === "object" && database !== null && "workspaces" in database
        ? database
        : undefined;

    // The listener binds first because a loopback listener's own address, including a port the
    // operating system picked, is the only host name it answers to.
    const server = createServer();
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
    try {
      const host = createDashboardHost({
        path: "/",
        environment: "standalone",
        auditActor: options.actor,
        // A Unix socket has no host name, and a public origin replaces the inbound one.
        ...(tcpListener && !publicOrigin
          ? { allowedHosts: loopbackHosts(options.hostname, port) }
          : {}),
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
                  { database: workspaceDatabase, ...workspaceControls(workspaceDatabase, name) },
                ]),
              ),
              defaultWorkspace: workspaceTarget.defaultWorkspace,
            }
          : { database: database as Queryable, ...workspaceControls(database as Queryable, null) }),
      });

      const middleware = dashboardNodeMiddleware(host, { publicOrigin, trustedProxies });
      server.on("request", (request, response) => {
        // Set before the middleware writes, so every response the listener produces carries them
        // and a dashboard response that names one of these headers itself still wins.
        for (const [name, value] of Object.entries(STANDALONE_SECURITY_HEADERS)) {
          response.setHeader(name, value);
        }
        middleware(request, response, () => {
          response.statusCode = 404;
          response.end("Not found");
        });
      });
    } catch (error) {
      server.close();
      throw error;
    }

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
