import { z } from "zod";

/**
 * Runtime configuration handed to the dashboard's browser entry.
 *
 * This is the contract between whatever serves the HTML and the React application that boots from
 * it. It exists as one exported type so a host and a development server cannot drift apart on it.
 */
export const dashboardRuntimeConfigSchema = z.strictObject({
  /** Normalized mount path. Empty string when the dashboard owns the host root. */
  basePath: z.string(),
  rpcUrl: z.string(),
  auditActor: z.string(),
  /** Published version of the SDK serving this browser application. */
  workhorseVersion: z.string(),
  /**
   * Git commit of the Workhorse source the serving build came from. Absent for a published release,
   * whose version already names its source.
   */
  workhorseRevision: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  /** Built-in authentication routes. Null when the embedding host owns authorization. */
  authentication: z.strictObject({ loginUrl: z.string(), logoutUrl: z.string() }).nullable(),
  /** Enables the task-seeding menu. Only hosts that intentionally supply fixtures should set it. */
  demoTools: z.boolean(),
  /** Every named workspace the host serves, in configuration order. */
  workspaces: z
    .array(
      z.strictObject({
        name: z.string(),
        url: z.string(),
        databaseHost: z.string().optional(),
        databaseName: z.string().optional(),
      }),
    )
    .readonly(),
  /** Name of the workspace this document was rendered for. Null in single-workspace mode. */
  workspace: z.string().nullable(),
});

export type DashboardRuntimeConfig = z.infer<typeof dashboardRuntimeConfigSchema>;

export type { DashboardWorkspaceLink } from "../runtime-config.js";

export interface RenderDashboardHtmlOptions {
  runtime: DashboardRuntimeConfig;
  /** Trusted host-owned ES modules loaded before the dashboard browser entry. */
  browserModules?: readonly string[];
  /**
   * The Content-Security-Policy nonce of this response. When it is set, each inline script element
   * of the document gets a `nonce` attribute with this value, so a policy can allow those scripts
   * without `'unsafe-inline'`. It must contain only base64 or base64url characters.
   */
  scriptNonce?: string;
}

/** The characters a nonce can contain, so it cannot end the attribute that holds it. */
const SCRIPT_NONCE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** A script start tag. The template is trusted, and the runtime configuration escapes `<`. */
const SCRIPT_START_TAG = /<script\b([^>]*)>/gi;

/**
 * Give each inline script element of a document the nonce of its response.
 *
 * A script element with a `src` attribute loads from its URL, so `'self'` already covers it. An
 * element that already has a `nonce` attribute keeps it, so a second pass over the same document
 * changes nothing.
 */
export function addInlineScriptNonce(html: string, nonce: string): string {
  if (!SCRIPT_NONCE.test(nonce)) {
    throw new TypeError("A dashboard script nonce must contain only base64 characters");
  }
  return html.replace(SCRIPT_START_TAG, (tag: string, attributes: string) =>
    /\s(?:src|nonce)\s*=/i.test(attributes) ? tag : `<script nonce="${nonce}"${attributes}>`,
  );
}

/** Placeholder the packaged `index.html` reserves for the runtime configuration script body. */
export const DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER = "/*__WORKHORSE_RUNTIME_CONFIG__*/";

/** Placeholder the packaged `index.html` reserves for host-owned module tags. */
export const DASHBOARD_BROWSER_MODULES_PLACEHOLDER = "<!--__WORKHORSE_BROWSER_MODULES__-->";

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Fill the packaged dashboard `index.html` template.
 *
 * Both the production request host and a development server that compiles the browser entry from
 * source must produce the same document, so they share this function rather than each implementing
 * the substitution. Adding a field to `DashboardRuntimeConfig` then reaches every caller instead of
 * silently applying to one of them.
 *
 * The serialized config escapes `<` so a value can never terminate the surrounding script element,
 * and host-owned module URLs are attribute-escaped. With `scriptNonce`, each inline script element
 * carries the nonce.
 */
export function renderDashboardHtml(template: string, options: RenderDashboardHtmlOptions): string {
  const serialized = JSON.stringify(options.runtime).replaceAll("<", "\\u003c");
  const html = template
    .replace(DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER, () => `window.workhorseDashboard=${serialized}`)
    .replace(DASHBOARD_BROWSER_MODULES_PLACEHOLDER, () =>
      (options.browserModules ?? [])
        .map((source) => `<script type="module" src="${escapeHtmlAttribute(source)}"></script>`)
        .join("\n"),
    );
  return options.scriptNonce === undefined ? html : addInlineScriptNonce(html, options.scriptNonce);
}
