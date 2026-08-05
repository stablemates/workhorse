/**
 * Runtime configuration handed to the dashboard's browser entry.
 *
 * This is the contract between whatever serves the HTML and the React application that boots from
 * it. It exists as one exported type so a host and a development server cannot drift apart on it.
 */
export interface DashboardRuntimeConfig {
  /** Normalized mount path. Empty string when the dashboard owns the host root. */
  basePath: string;
  rpcUrl: string;
  /** Server-sent refresh stream this host serves. The application subscribes when set to "Live". */
  eventsUrl: string;
  auditActor: string;
  /** Enables the job-seeding menu. Only hosts that intentionally supply fixtures should set it. */
  demoTools: boolean;
}

export interface RenderDashboardHtmlOptions {
  runtime: DashboardRuntimeConfig;
  /** Trusted host-owned ES modules loaded before the dashboard browser entry. */
  browserModules?: readonly string[];
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
 * and host-owned module URLs are attribute-escaped.
 */
export function renderDashboardHtml(template: string, options: RenderDashboardHtmlOptions): string {
  const serialized = JSON.stringify(options.runtime).replaceAll("<", "\\u003c");
  return template
    .replace(DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER, `window.workhorseDashboard=${serialized}`)
    .replace(
      DASHBOARD_BROWSER_MODULES_PLACEHOLDER,
      (options.browserModules ?? [])
        .map((source) => `<script type="module" src="${escapeHtmlAttribute(source)}"></script>`)
        .join("\n"),
    );
}
