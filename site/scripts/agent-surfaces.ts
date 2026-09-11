import { CLI_COMMANDS } from "../../typescript/core/src/cli/surface.js";

/**
 * The surfaces an agent reads that are not documentation pages (ADR 0062): the
 * bodies a 404 carries, and the `llms.txt` sections that say when Workhorse is
 * the right tool, how to call it from the command line, and which
 * machine-readable files exist. Each is a pure function of the site's
 * configuration so `gen-docs-index.ts` writes them and a unit test reads them.
 */

export interface AgentSurfaceSite {
  /** Site origin without a trailing slash, `https://workhorse.run`. */
  readonly base: string;
  readonly name: string;
}

/** One `llms.txt` link: the Markdown twin of a page and its description. */
export interface AgentSurfaceLink {
  readonly title: string;
  /** Site-relative URL of the HTML page, `/docs/quickstart`. */
  readonly url: string;
  readonly description: string;
}

/**
 * The Markdown body of a 404. An agent that lands on a missing URL has spent a
 * fetch and holds nothing, so the body is the shortest route back: the index,
 * the one-file download, the entry point, the sitemap, and the `.md` rule.
 */
export function renderNotFoundMarkdown(
  site: AgentSurfaceSite,
  entryPoint: AgentSurfaceLink,
  groups: readonly { readonly title: string; readonly first: AgentSurfaceLink }[],
): string {
  const lines = [
    "# 404: this page does not exist",
    "",
    `The URL matched no page on ${site.name}. The page moved, or the link was wrong.`,
    "",
    "## Where to look next",
    "",
    `- [llms.txt](${site.base}/llms.txt): every page with a one-line description.`,
    `- [${entryPoint.title}](${site.base}${entryPoint.url}.md): ${entryPoint.description}`,
    `- [llms-full.txt](${site.base}/llms-full.txt): every documentation page in one file.`,
    `- [sitemap.xml](${site.base}/sitemap.xml): every HTML page URL.`,
    `- [openapi.json](${site.base}/openapi.json): the dashboard HTTP API, OpenAPI 3.1.`,
    "",
    "Append `.md` to any page URL for its Markdown source, or send `Accept: text/markdown`.",
    "",
    "## Sections",
    "",
    ...groups.map(
      (group) => `- ${group.title}: [${group.first.title}](${site.base}${group.first.url}.md)`,
    ),
    "",
  ];
  return lines.join("\n");
}

/**
 * The JSON body of a 404, for a client that asked for `application/json`. The
 * shape is the one the OpenAPI document declares for an error: a code a program
 * can switch on, a message a person can read, a hint that says what to do, and
 * the links that do it.
 */
export function renderNotFoundJson(site: AgentSurfaceSite, entryPoint: AgentSurfaceLink): string {
  const body = {
    error: {
      code: "not_found",
      status: 404,
      message: `The URL matched no page on ${site.name}.`,
      hint: "Read llms.txt for every page, or append .md to a page URL for its Markdown source.",
      links: {
        llms: `${site.base}/llms.txt`,
        llmsFull: `${site.base}/llms-full.txt`,
        agents: `${site.base}${entryPoint.url}.md`,
        docs: `${site.base}/docs.md`,
        sitemap: `${site.base}/sitemap.xml`,
        openapi: `${site.base}/openapi.json`,
      },
    },
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * When Workhorse is the right tool, in the terms an agent matches a task
 * against. The boundaries repeat the playbook's "Whether Workhorse fits" list,
 * which stays the owner of that judgement; this section exists so an agent that
 * reads only the router can still decide.
 */
export function renderWhenToUse(
  site: AgentSurfaceSite,
  pages: {
    readonly entryPoint: AgentSurfaceLink;
    readonly installation: AgentSurfaceLink;
    readonly limitations: AgentSurfaceLink;
  },
): string {
  return [
    `## When to use ${site.name}`,
    "",
    "Reach for it when the application already runs on PostgreSQL and needs:",
    "",
    "- Background jobs that commit in the same transaction as the application's own rows, so a job never exists without its data or the reverse.",
    "- Handlers that survive retries, crashes, and long pauses through named checkpoints, durable timers, signals, human approvals, and child jobs.",
    "- Cron schedules synchronised at deployment that any matching worker fires exactly once.",
    "- Keyed debounce and throttle, per-queue concurrency budgets, and rate limits that every worker shares through the database.",
    "- An operator surface for inspecting a job's timeline, redriving dead letters, and pausing queues or workers, as a dashboard, a CLI, and an HTTP API.",
    "",
    "Do not reach for it when any of these disqualifies the task:",
    "",
    "- Handlers run at least once; an effect that cannot tolerate a repeat needs a checkpoint or an idempotency key.",
    "- PostgreSQL is the only supported database; there is no broker and no other backend.",
    "- There is no workflow definition language; durable steps are composed in ordinary handler code.",
    "- A concurrency or rate-limit policy is scoped to one queue, not across queues.",
    "",
    `[${pages.limitations.title}](${site.base}${pages.limitations.url}.md) owns every boundary and its workaround.`,
    "",
    "How an agent integrates it:",
    "",
    `1. Read [${pages.entryPoint.title}](${site.base}${pages.entryPoint.url}.md) and decide whether it fits.`,
    `2. Install the package for the application's language with the command on [${pages.installation.title}](${site.base}${pages.installation.url}.md), which names no version.`,
    "3. Install the schema from a deployment step, never from application startup.",
    "4. Enqueue one job inside the caller's transaction, run one worker, and confirm the job settled by querying it.",
    "",
  ].join("\n");
}

/**
 * What each command is for, in one line. The names come from `CLI_COMMANDS`,
 * the declaration the CLI itself consumes, so a command cannot be listed here
 * that the binary does not have; the check below makes the reverse true too.
 */
const cliCommandPurposes: Readonly<Record<string, string>> = {
  init: "write a starter configuration file for the worker process.",
  "schema install": "install the Workhorse schema into a PostgreSQL database; a deployment step.",
  "schema migrate": "apply pending schema migrations; a deployment step.",
  "schema contract":
    "apply the one pending contract step, retiring the protocols it names; an operator step that requires `--yes`.",
  "schema status":
    "report the installed schema version and whether this client is compatible (`--json` for machines).",
  worker:
    "run a worker process from a configuration file, with graceful drain on SIGTERM and probe endpoints.",
  dashboard: "serve the operator dashboard standalone with a built-in administrator login.",
  admin:
    "inspect jobs, timelines, failures, queues, schedules, and workers, or cancel, redrive, pause, resume, and purge; every mutation names its `--env` and confirms.",
  tui: "open the terminal operator interface.",
  health: "print one bounded queue-health snapshot with a verdict; exit code 2 means degraded.",
};

/**
 * The `llms.txt` section on the command line. The CLI ships inside the npm
 * package and nowhere else, and the section says so rather than letting an
 * agent look for a Homebrew formula or a PyPI script that does not exist.
 */
export function renderCliSection(
  site: AgentSurfaceSite,
  pages: {
    readonly api: AgentSurfaceLink;
    readonly installation: AgentSurfaceLink;
    readonly operations: AgentSurfaceLink;
  },
): string {
  const names: readonly string[] = CLI_COMMANDS.map((command) => command.name);
  const listed = Object.keys(cliCommandPurposes);
  const missing = names.filter((name) => !listed.includes(name));
  const orphaned = listed.filter((name) => !names.includes(name));
  if (missing.length > 0 || orphaned.length > 0) {
    throw new Error(
      `The CLI section and CLI_COMMANDS disagree: missing ${missing.join(", ") || "none"}; ` +
        `orphaned ${orphaned.join(", ") || "none"}. Update cliCommandPurposes in site/scripts/agent-surfaces.ts.`,
    );
  }
  return [
    "## Command line",
    "",
    "The `workhorse` command ships inside the npm package `@stablemates/workhorse` and nowhere else: there is no Homebrew formula and no PyPI script. Python and Go applications run it through Node for the schema step.",
    "",
    `For a database step without Node, every GitHub release attaches the clean-install \`schema.sql\`: download it and apply it with \`psql\`, as [${pages.installation.title}](${site.base}${pages.installation.url}.md) describes.`,
    "",
    "```sh",
    "npm install @stablemates/workhorse",
    "npm exec --no -- workhorse schema status --json",
    "```",
    "",
    "Run `npm exec --no -- workhorse <command>` inside a project that depends on the package. The commands:",
    "",
    ...names.map((name) => `- \`workhorse ${name}\`: ${cliCommandPurposes[name]}`),
    "",
    `[${pages.api.title}](${site.base}${pages.api.url}.md) and [${pages.operations.title}](${site.base}${pages.operations.url}.md) document the flags, the \`--json\` payloads, and the exit codes.`,
    "",
  ].join("\n");
}

/**
 * The machine-readable files, and the one rule that makes every page one: a
 * client that sends `Accept: text/markdown` receives the Markdown twin at the
 * page's own URL, and a missing URL answers 404 with a Markdown or JSON body.
 */
export function renderMachineReadable(site: AgentSurfaceSite): string {
  return [
    "## Machine-readable",
    "",
    `- [openapi.json](${site.base}/openapi.json): OpenAPI 3.1 for the dashboard HTTP API, which the reader's own deployment serves; workhorse.run serves only this description.`,
    `- [sitemap.xml](${site.base}/sitemap.xml): every HTML page URL.`,
    `- [llms-full.txt](${site.base}/llms-full.txt): every documentation page in one file.`,
    "- Any page URL answers `Accept: text/markdown` with its Markdown twin and `Vary: Accept`; appending `.md` to the URL fetches the same file without negotiation.",
    "- A URL that matches no page answers 404 with a Markdown body for `Accept: text/markdown`, a JSON body for `Accept: application/json`, and the HTML page otherwise.",
    "",
  ].join("\n");
}
