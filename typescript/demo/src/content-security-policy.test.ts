import { describe, expect, it } from "vitest";
import { demoContentSecurityPolicy } from "./app.js";

function connectSource(policy: string): string {
  const directive = policy.split("; ").find((entry) => entry.startsWith("connect-src "));
  if (!directive) throw new Error("The policy declares no connect-src directive");
  return directive;
}

function withoutConnectSource(directives: string[]): string[] {
  return directives.filter((entry) => !entry.startsWith("connect-src "));
}

describe("demo content security policy", () => {
  it("grants no WebSocket source in production", () => {
    const policy = demoContentSecurityPolicy("production");
    expect(policy).not.toMatch(/\bwss?:/);
    expect(connectSource(policy)).toBe(
      "connect-src 'self' https://*.google-analytics.com https://www.google-analytics.com",
    );
  });

  it("grants the WebSocket sources Vite's hot reload needs in development", () => {
    expect(connectSource(demoContentSecurityPolicy("development"))).toBe(
      "connect-src 'self' ws: wss: https://*.google-analytics.com https://www.google-analytics.com",
    );
  });

  it("keeps every other directive identical across modes", () => {
    const development = demoContentSecurityPolicy("development").split("; ");
    const production = demoContentSecurityPolicy("production").split("; ");
    expect(withoutConnectSource(development)).toEqual(withoutConnectSource(production));
    expect(production).toContain("default-src 'self'");
    expect(production).toContain("frame-ancestors 'none'");
  });

  it("allows form submissions only to the demo origin", () => {
    for (const mode of ["development", "production"] as const) {
      expect(demoContentSecurityPolicy(mode).split("; ")).toContain("form-action 'self'");
    }
  });

  it("allows no inline script and names the nonce of a page", () => {
    expect(demoContentSecurityPolicy("production").split("; ")).toContain(
      "script-src 'self' https://www.googletagmanager.com",
    );
    expect(demoContentSecurityPolicy("production", "bm9uY2U=").split("; ")).toContain(
      "script-src 'self' 'nonce-bm9uY2U=' https://www.googletagmanager.com",
    );
    for (const mode of ["development", "production"] as const) {
      const script = demoContentSecurityPolicy(mode, "bm9uY2U=")
        .split("; ")
        .find((entry) => entry.startsWith("script-src "));
      expect(script).not.toContain("'unsafe-inline'");
    }
    // Only style-src keeps inline elements, for the styles the application injects.
    expect(demoContentSecurityPolicy("production")).toContain("style-src 'self' 'unsafe-inline'");
  });
});
