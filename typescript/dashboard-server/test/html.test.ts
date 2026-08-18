import { describe, expect, it } from "vitest";
import {
  DASHBOARD_BROWSER_MODULES_PLACEHOLDER,
  DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER,
  renderDashboardHtml,
} from "../src/server/html.js";

const template = `<html><head><script>${DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER}</script>${DASHBOARD_BROWSER_MODULES_PLACEHOLDER}</head></html>`;

const runtime = {
  basePath: "/workhorse",
  rpcUrl: "/workhorse/rpc",
  auditActor: "ops@example.com",
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
      `window.workhorseDashboard={"basePath":"/workhorse","rpcUrl":"/workhorse/rpc","auditActor":"ops@example.com","authentication":{"loginUrl":"/workhorse/login","logoutUrl":"/workhorse/logout"},"demoTools":false,"workspaces":[],"workspace":null}`,
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
