import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Queryable } from "@stablemates/workhorse";
import { PROTOCOL_VERSION, WORKHORSE_SCHEMA_VERSION } from "@stablemates/workhorse";
import { describe, expect, it } from "vitest";
import { createDashboardHost } from "../src/server/host.js";
import {
  addInlineScriptNonce,
  DASHBOARD_BROWSER_MODULES_PLACEHOLDER,
  DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER,
  renderDashboardHtml,
} from "../src/server/html.js";

const template = `<html><head><script>${DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER}</script>${DASHBOARD_BROWSER_MODULES_PLACEHOLDER}</head></html>`;
const packagedTemplate = readFileSync(
  join(import.meta.dirname, "../../../dashboard/app/browser/index.html"),
  "utf8",
);

const runtime = {
  basePath: "/workhorse",
  rpcUrl: "/workhorse/rpc",
  auditActor: "ops@example.com",
  workhorseVersion: "9.8.7",
  authentication: {
    loginUrl: "/workhorse/login",
    logoutUrl: "/workhorse/logout",
  },
  demoTools: false,
  workspaces: [],
  workspace: null,
};

describe("renderDashboardHtml", () => {
  it("injects the runtime configuration the browser entry boots from", () => {
    const html = renderDashboardHtml(template, { runtime });

    expect(html).toContain(
      `window.workhorseDashboard={"basePath":"/workhorse","rpcUrl":"/workhorse/rpc","auditActor":"ops@example.com","workhorseVersion":"9.8.7","authentication":{"loginUrl":"/workhorse/login","logoutUrl":"/workhorse/logout"},"demoTools":false,"workspaces":[],"workspace":null}`,
    );
    expect(html).not.toContain(DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER);
  });

  it("escapes a value that would otherwise close the surrounding script element", () => {
    const html = renderDashboardHtml(template, {
      runtime: { ...runtime, auditActor: "</script><script>alert(1)</script>" },
    });

    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });

  it("renders dollar substitution patterns as data in the packaged template", () => {
    const html = renderDashboardHtml(packagedTemplate, {
      runtime: { ...runtime, auditActor: "$&-$`-$'-$1" },
      browserModules: ["/dev/$&-module.ts"],
    });

    expect(html).toContain('window.workhorseDashboard={"basePath":"/workhorse"');
    expect(html).toContain('"auditActor":"$&-$`-$\'-$1"');
    expect(html).toContain('<script type="module" src="/dev/$&amp;-module.ts"></script>');
    expect(html.match(/window\.workhorseDashboard=/g)).toHaveLength(1);
    expect(html.match(/<script>\s*window\.workhorseDashboard=/g)).toHaveLength(1);
    expect(html).not.toContain(DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER);
    expect(html).not.toContain(DASHBOARD_BROWSER_MODULES_PLACEHOLDER);
  });

  it("renders host-owned browser modules and escapes their URLs", () => {
    const html = renderDashboardHtml(template, {
      runtime,
      browserModules: ['/dev/tooling.ts?a="1"&b=2', "/dev/second.ts"],
    });

    expect(html).toContain(
      '<script type="module" src="/dev/tooling.ts?a=&quot;1&quot;&amp;b=2"></script>',
    );
    expect(html).toContain('<script type="module" src="/dev/second.ts"></script>');
  });

  it("removes the module placeholder when a host supplies none", () => {
    const html = renderDashboardHtml(template, { runtime });

    expect(html).not.toContain(DASHBOARD_BROWSER_MODULES_PLACEHOLDER);
    expect(html).not.toContain('<script type="module"');
  });
});

/** Each script start tag of a document, with its attributes. */
function scriptTags(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>/gi)].map(([tag]) => tag);
}

/** The script start tags that load no URL, so their body runs inline. */
function inlineScriptTags(html: string): string[] {
  return scriptTags(html).filter((tag) => !/\ssrc\s*=/i.test(tag));
}

/** Each start tag that carries an inline event handler attribute such as `onclick`. */
function inlineEventHandlers(html: string): string[] {
  return [...html.matchAll(/<[a-z][^>]*\son[a-z]+\s*=[^>]*>/gi)].map(([tag]) => tag);
}

describe("inline script nonces", () => {
  it("puts the nonce on each inline script of the packaged template and nowhere else", () => {
    const html = renderDashboardHtml(packagedTemplate, {
      runtime,
      browserModules: ["/dev/tooling.ts"],
      scriptNonce: "bm9uY2UtdmFsdWU=",
    });

    const inline = inlineScriptTags(html);
    // The color scheme script and the runtime configuration.
    expect(inline).toEqual([
      '<script nonce="bm9uY2UtdmFsdWU=">',
      '<script nonce="bm9uY2UtdmFsdWU=">',
    ]);
    for (const tag of scriptTags(html).filter((entry) => !inline.includes(entry))) {
      expect(tag).not.toContain("nonce=");
    }
  });

  it("keeps a nonce that a script already has and adds one to an inline module", () => {
    const html = addInlineScriptNonce(
      '<script type="module">import "/a.js";</script><script nonce="other">x</script>',
      "abc123",
    );

    expect(html).toBe(
      '<script nonce="abc123" type="module">import "/a.js";</script><script nonce="other">x</script>',
    );
    expect(addInlineScriptNonce(html, "abc123")).toBe(html);
  });

  it("refuses a nonce that could end its attribute", () => {
    expect(() =>
      renderDashboardHtml(template, { runtime, scriptNonce: '"><script>alert(1)</script>' }),
    ).toThrow("base64");
  });
});

const database = {
  query: async () => ({
    rows: [
      { kind: "protocol", version: PROTOCOL_VERSION },
      { kind: "schema", version: WORKHORSE_SCHEMA_VERSION },
    ],
  }),
} as unknown as Queryable;

const builtBundle = join(import.meta.dirname, "../dist/app");
const builtBundleSuite = existsSync(join(builtBundle, "index.html")) ? describe : describe.skip;

builtBundleSuite(
  "dashboard pages and their policy (requires the built dashboard browser bundle)",
  () => {
    it("gives each inline script of a page the nonce that its policy header names", async () => {
      const policies: string[] = [];
      const host = createDashboardHost({
        database,
        path: "/workhorse",
        authorize: () => true,
        contentSecurityPolicy: ({ nonce }) => {
          const policy = `script-src 'self' 'nonce-${nonce}'`;
          policies.push(policy);
          return policy;
        },
      });

      const nonces = new Set<string>();
      for (const page of ["/workhorse/tasks", "/workhorse/queues", "/workhorse/settings"]) {
        const response = await host.handle(new Request(`https://dashboard.test${page}`));
        expect(response?.status).toBe(200);
        const header = response?.headers.get("content-security-policy") ?? "";
        const nonce = /'nonce-([^']+)'/.exec(header)?.[1];
        if (nonce === undefined) throw new Error(`The page ${page} names no nonce`);
        nonces.add(nonce);

        const html = (await response?.text()) ?? "";
        const inline = inlineScriptTags(html);
        expect(inline.length).toBeGreaterThan(0);
        for (const tag of inline) expect(tag).toContain(`nonce="${nonce}"`);
        expect(inlineEventHandlers(html)).toEqual([]);
      }
      // Each page gets its own nonce.
      expect(nonces.size).toBe(3);
      expect(policies).toHaveLength(3);
    });

    it("sends no policy from the host when the embedder owns the header", async () => {
      const host = createDashboardHost({ database, path: "/", authorize: () => true });

      const response = await host.handle(new Request("https://dashboard.test/tasks"));

      expect(response?.headers.has("content-security-policy")).toBe(false);
      // The nonce attribute is harmless without the header.
      for (const tag of inlineScriptTags((await response?.text()) ?? "")) {
        expect(tag).toMatch(/^<script nonce="[A-Za-z0-9+/]+={0,2}">$/);
      }
    });

    it("builds pages with no inline script outside the boot scripts and no inline event handler", () => {
      const index = readFileSync(join(builtBundle, "index.html"), "utf8");
      const login = readFileSync(join(builtBundle, "login.html"), "utf8");

      // The two boot scripts are the only inline scripts, and the host gives each one the nonce.
      expect(inlineScriptTags(index)).toEqual(["<script>", "<script>"]);
      expect(inlineScriptTags(login)).toEqual([]);
      expect(inlineEventHandlers(index)).toEqual([]);
      expect(inlineEventHandlers(login)).toEqual([]);
      expect(index).not.toMatch(/javascript:/i);
      expect(login).not.toMatch(/javascript:/i);
    });
  },
);
