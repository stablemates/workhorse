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
});
