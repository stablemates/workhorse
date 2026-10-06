import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");

type GuideCoverage = {
  pages: Record<string, string>;
  exclusions: Record<string, { issue: string; reason: string }>;
};

const readCoverage = async () =>
  JSON.parse(await readFile(path.join(root, "site/guide-coverage.json"), "utf8")) as GuideCoverage;

/**
 * Identifiers a guide's explanation names. A collapsed `Reference:` block mirrors its architecture
 * page rather than the site page, so its identifiers are not held to site parity. Any other
 * `<details>` block is explanation and stays in scope.
 */
function inlineIdentifiers(markdown: string): string[] {
  const withoutCodeBlocks = markdown
    .replace(/^<details>\n<summary>Reference:[\s\S]*?^<\/details>$/gm, "")
    .replace(/```[\s\S]*?```/g, "");
  const literals = new Set(["DELETE", "Origin", "POST", "_FILE"]);
  return [...withoutCodeBlocks.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1]!)
    .filter((identifier) => {
      if (identifier.endsWith(".md") || literals.has(identifier)) return false;
      const name = identifier.replace(/\([^)]*\)$/, "");
      return (
        /^@[-\w]+\/[.\w-]+$/.test(name) ||
        /^\*?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(name) ||
        /^[A-Z_][A-Z0-9_]*$/.test(name) ||
        /^[A-Z][A-Za-z0-9]*$/.test(name) ||
        /^[a-z]+(?:[A-Z][A-Za-z0-9]*)+$/.test(name) ||
        /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name) ||
        /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(name)
      );
    });
}

/**
 * Names a guide invents for its examples: queues, tenants, task types, and application functions.
 * The guide lists them in a `<!-- scenario-names: … -->` comment. Every other identifier its
 * explanation names is a product identifier that its mapped site page must carry.
 */
function scenarioNames(markdown: string): Set<string> {
  const declaration = /<!-- scenario-names: (.*?) -->/.exec(markdown);
  return new Set(declaration?.[1]!.split(",").map((name) => name.trim()) ?? []);
}

/** The identifier without call arguments, which a guide's example may fill in. */
function identifierName(identifier: string): string {
  return identifier.replace(/\(.*\)$/, "").replace(/^\*/, "");
}

/**
 * Whether a page names an identifier as a whole token. `registerOpenTelemetry` does not match inside
 * `registerOpenTelemetryProvider`, and `Queue.sync_budgets` does not match inside
 * `AsyncQueue.sync_budgets`.
 */
function namesIdentifier(pageContents: string, name: string): boolean {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$-])${escaped}(?![\\w$-])`).test(pageContents);
}

/** Product identifiers that a guide's explanation names and its mapped site page lacks. */
function missingIdentifiers(guideContents: string, pageContents: string): string[] {
  const invented = scenarioNames(guideContents);
  return [...new Set(inlineIdentifiers(guideContents))].filter((identifier) => {
    const name = identifierName(identifier);
    return !invented.has(name) && !namesIdentifier(pageContents, name);
  });
}

describe("documentation site guide coverage", () => {
  it("accounts for every guide with a site page or a tracked exclusion", async () => {
    const guideFiles = (await readdir(path.join(root, "docs/guides")))
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -3))
      .toSorted();
    const manifest = await readCoverage();
    const accountedFor = [
      ...Object.keys(manifest.pages),
      ...Object.keys(manifest.exclusions),
    ].toSorted();

    expect(accountedFor).toEqual(guideFiles);
    expect(new Set(accountedFor).size).toBe(accountedFor.length);
  });

  it("points mappings at real site pages and exclusions at tracked work", async () => {
    const manifest = await readCoverage();

    await Promise.all(
      Object.values(manifest.pages).map((page) =>
        expect(
          readFile(path.join(root, "site/content/docs", `${page}.mdx`), "utf8"),
        ).resolves.toEqual(expect.any(String)),
      ),
    );
    for (const exclusion of Object.values(manifest.exclusions)) {
      expect(exclusion.issue).toMatch(/^WOR-\d+$/);
      expect(exclusion.reason.trim()).not.toBe("");
    }
  });

  it("holds every identifier to site parity unless the guide declares it invented", () => {
    const guide = [
      "# A guide",
      "",
      "<!-- scenario-names: acme, pdf.render, reportProgress, doc-42 -->",
      "",
      "Queue `acme` runs `pdf.render` and calls `reportProgress(context, 1)`.",
      "Set `dashboard.quickAction`, `service.name`, and `task_runtime.state`, then call",
      "`registerOpenTelemetry()` and `AsyncQueue.sync_budgets`. The status is `succeeded`.",
      "Queue `doc-42` reports `rate-limit-throttled`.",
      "",
      "<details>",
      "<summary>Reference: limits</summary>",
      "",
      "`MAX_WAIT_DURATION_MS` bounds the wait.",
      "",
      "</details>",
    ].join("\n");

    expect(missingIdentifiers(guide, "The page names nothing.")).toEqual([
      "dashboard.quickAction",
      "service.name",
      "task_runtime.state",
      "registerOpenTelemetry()",
      "AsyncQueue.sync_budgets",
      "succeeded",
      "rate-limit-throttled",
    ]);
    expect(
      missingIdentifiers(
        guide,
        "`dashboard.quickAction` `service.name` `task_runtime.state` `registerOpenTelemetry()` " +
          "`AsyncQueue.sync_budgets` `succeeded` `rate-limit-throttled`",
      ),
    ).toEqual([]);
    expect(
      missingIdentifiers(
        "Call `registerOpenTelemetry()` and `Queue.sync_budgets`.",
        "Call `registerOpenTelemetryProvider()` and `AsyncQueue.sync_budgets`.",
      ),
    ).toEqual(["registerOpenTelemetry()", "Queue.sync_budgets"]);
    expect(
      missingIdentifiers(
        "<details>\n<summary>How to cancel</summary>\n\nCall `queue.cancel(taskId)`.\n\n</details>",
        "The page names nothing.",
      ),
    ).toEqual(["queue.cancel(taskId)"]);
    expect(
      missingIdentifiers("Call `queue.cancel(taskId)`.", "Call `queue.cancel(id, options)`."),
    ).toEqual([]);
  });

  it("lists only scenario names that each guide still uses", async () => {
    const manifest = await readCoverage();
    const staleByGuide: Record<string, string[]> = {};

    for (const guide of Object.keys(manifest.pages)) {
      const contents = await readFile(path.join(root, "docs/guides", `${guide}.md`), "utf8");
      const used = new Set(inlineIdentifiers(contents).map(identifierName));
      const stale = [...scenarioNames(contents)].filter((name) => !used.has(name));
      if (stale.length > 0) staleByGuide[guide] = stale;
    }
    expect(staleByGuide).toEqual({});
  });

  it("keeps each guide's identifiers in its mapped site page", async () => {
    const manifest = await readCoverage();
    const missingByGuide: Record<string, string[]> = {};

    for (const [guide, page] of Object.entries(manifest.pages)) {
      const [guideContents, pageContents] = await Promise.all([
        readFile(path.join(root, "docs/guides", `${guide}.md`), "utf8"),
        readFile(path.join(root, "site/content/docs", `${page}.mdx`), "utf8"),
      ]);
      const missing = missingIdentifiers(guideContents, pageContents);
      if (missing.length > 0) missingByGuide[`${guide} -> ${page}.mdx`] = missing;
    }
    expect(missingByGuide).toEqual({});
  });

  it("keeps corrected lifecycle claims aligned across source and site documentation", async () => {
    const files = await Promise.all(
      [
        "docs/architecture/overview.md",
        "docs/guides/010-tasks-and-state.md",
        "docs/guides/140-deadlines-and-timeouts.md",
        "docs/guides/340-redrive.md",
        "site/content/docs/concepts.mdx",
        "site/content/docs/dead-letters.mdx",
        "site/content/docs/deadlines.mdx",
        "site/content/docs/compatibility.mdx",
      ].map((file) => readFile(path.join(root, file), "utf8")),
    );
    const combined = files.join("\n");

    expect(files[0]).toContain("Schema version 1 stores");
    // The claim guarded here is the storage shape, not the number. Schema version 2 exists as a
    // migration and these pages may name it; what must not come back is a second lifecycle design
    // presented as what a later schema version stores.
    expect(combined).not.toMatch(/schema version (?!1\b)\d+ stores|exactly as fast/i);
    expect(combined).not.toContain("Before a mutation, the client reads");
    expect(combined).not.toContain("Insert-only identity, routing, payload");
    expect(files[1]).toContain("pending [keyed debounce]");
    expect(files[4]).toContain("pending [keyed debounce]");
    expect(files[2]).toContain("calls `expire_owned_v1`");
    expect(files[6]).toContain("calls `expire_owned_v1`");
    // Compatibility used to name the TypeScript entrypoint alone, which read as a TypeScript-only
    // instruction on a page three SDKs share. It now names all three, so what this holds is the
    // claim rather than the spelling: the page still tells a reader to assert before a process
    // works. support-matrix.test.ts holds the three entrypoint names.
    expect(files[7]).toContain("Assert compatibility when a process starts");
  });

  it("describes Python workers as pool-backed across source and site documentation", async () => {
    const [architecture, guide, page] = await Promise.all(
      [
        "docs/architecture/schema-and-protocol.md",
        "docs/guides/200-transactional-enqueue.md",
        "site/content/docs/enqueue.mdx",
      ].map((file) => readFile(path.join(root, file), "utf8")),
    );

    // ADR 0071 moved both Python workers onto pools. The pages once told readers to give a worker
    // its own connection, and the reference still described the removed connection factories.
    expect(architecture).toContain("exports `Worker` for a Psycopg `ConnectionPool`");
    expect(architecture).toContain("`_PooledAsyncPsycopgExecutor` or `_PooledAsyncpgExecutor`");
    expect(architecture).toContain("reserves one pool connection for heartbeat");
    expect(architecture).toContain("`AsyncWorker._listen`, which borrows one connection");
    for (const contents of [architecture, guide, page]) {
      expect(contents).not.toMatch(/notification_connection_factory|heartbeat_connection_factory/);
      expect(contents).not.toMatch(/dedicated query connection|asyncio\.Lock/);
      expect(contents).not.toMatch(/(needs|requires) (a|its own|one dedicated) connection/);
    }

    for (const contents of [guide, page]) {
      expect(contents).toContain("Queue(connection).enqueue(");
      expect(contents).toContain("`AsyncWorker.from_psycopg` and `AsyncWorker.from_asyncpg`");
    }
    expect(guide).toContain("A worker takes a connection pool, not a connection.");
    expect(guide).toContain("Open the transaction on the borrowed");
    expect(page).toContain("Python's `Worker` takes a Psycopg `ConnectionPool`");
    expect(page).toContain("borrow a connection\nfrom that pool and open its transaction there");
  });

  it("describes Python worker entry points as taking caller-owned pools", async () => {
    const [guide, page, readme] = await Promise.all(
      ["docs/guides/310-workers.md", "site/content/docs/workers.mdx", "python/README.md"].map(
        async (file) => (await readFile(path.join(root, file), "utf8")).replaceAll(/\s+/g, " "),
      ),
    );

    // The worker pages outlived the move to pools: the guide passed a connection to
    // AsyncWorker.from_asyncpg, and the site and README called query connections dedicated.
    for (const contents of [guide, page, readme]) {
      expect(contents).not.toMatch(/from_(asyncpg|psycopg)\(connection/);
      expect(contents).not.toMatch(/dedicated[^.]*\b(query|claims)\b/);
      expect(contents).toContain("takes an asyncpg `Pool`");
      expect(contents).toContain(
        "borrows a pool connection for each claim and lifecycle statement and returns it afterwards",
      );
      expect(contents).toContain("reserves its own heartbeat and listener connections");
      expect(contents).toMatch(/never closes (it|the pool it was given)/);
    }
    expect(guide).toContain("AsyncWorker.from_asyncpg(worker_pool,");
    expect(guide).not.toContain("Workers that share a database pool also share the listener");
    expect(guide).toContain("A Python or Rust worker holds its own.");
    expect(readme).toContain("Queue(application_connection).enqueue(");
    expect(readme).toContain("Worker(worker_pool)");
  });

  it("tells TypeScript readers to register telemetry before Workhorse metrics appear", async () => {
    const [guide, page] = await Promise.all([
      readFile(path.join(root, "docs/guides/355-observability.md"), "utf8"),
      readFile(path.join(root, "site/content/docs/maintenance.mdx"), "utf8"),
    ]);

    // Core starts with a no-op provider (ADR 0048), so configuring an SDK alone exports nothing.
    // The maintenance page once promised metrics as soon as an SDK was configured.
    expect(page).not.toMatch(/automatically once your application configures an SDK/);
    expect(page).toContain("core stays silent until a telemetry provider is registered");
    expect(page).toContain("[OpenTelemetry](/docs/operations#opentelemetry)");
    expect(guide).toContain("[registers telemetry](350-production-telemetry.md)");

    // The observer example must register telemetry and tear down in order: the observer stops
    // before the provider it records into goes away.
    const example = page.slice(page.indexOf("new WorkhorseMetricsObserver(") - 400);
    const registration = example.indexOf("const unregisterTelemetry = registerOpenTelemetry();");
    const observerStart = example.indexOf("new WorkhorseMetricsObserver(");
    const observerStop = example.indexOf("observer.stop();");
    const unregister = example.indexOf("unregisterTelemetry();", observerStop);
    expect(registration).toBeGreaterThanOrEqual(0);
    expect(registration).toBeLessThan(observerStart);
    expect(observerStop).toBeGreaterThan(observerStart);
    expect(unregister).toBeGreaterThan(observerStop);
  });
});
