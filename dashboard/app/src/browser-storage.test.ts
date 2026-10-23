import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deniedStorage = {
  getItem: () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  },
};

function stubWindow(): void {
  vi.stubGlobal("window", {
    location: { pathname: "/tasks", search: "" },
    matchMedia: () => ({ matches: true }),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", deniedStorage);
  stubWindow();
});

afterEach(() => vi.unstubAllGlobals());

describe("browser storage", () => {
  it("returns no value when a read throws", async () => {
    const { readStoredValue } = await import("./browser-storage.js");
    expect(readStoredValue("workhorse-theme-scheme")).toBeNull();
  });

  it("drops a write that throws", async () => {
    const { storeValue } = await import("./browser-storage.js");
    expect(() => storeValue("workhorse-theme-scheme", "dark")).not.toThrow();
  });

  it("reads and writes through to storage when the browser allows it", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const { readStoredValue, storeValue } = await import("./browser-storage.js");
    storeValue("workhorse-timezone", "UTC");
    expect(values.get("workhorse-timezone")).toBe("UTC");
    expect(readStoredValue("workhorse-timezone")).toBe("UTC");
  });
});

describe("dashboard preferences when storage is denied", () => {
  it("loads the time zone preference with the browser zone", async () => {
    const preferences = await import("./preferences.js");
    expect(preferences.displayTimeZone).toBeNull();
    expect(preferences.currentTimeZoneValue()).toBe("system");
  });

  it("applies a time zone change for the current session", async () => {
    const preferences = await import("./preferences.js");
    const listener = vi.fn<() => void>();
    preferences.subscribeTimeZone(listener);
    expect(() => preferences.setDisplayTimeZone("UTC")).not.toThrow();
    expect(preferences.currentTimeZoneValue()).toBe("UTC");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("uses the default refresh interval, system window, and chart options", async () => {
    const [{ readStoredRefreshInterval }, core, { defaultDashboardRefreshInterval }] =
      await Promise.all([
        import("./shell/controller.js"),
        import("./core.js"),
        import("./refresh-policy.js"),
      ]);
    expect(readStoredRefreshInterval()).toBe(defaultDashboardRefreshInterval);
    expect(core.readStoredSystemWindow()).toBe("1h");
    expect(core.readLocation()).toMatchObject({ route: "/tasks", period: "1h", group: "task" });
  });

  it("renders the theme with the system color scheme", async () => {
    const { WorkhorseThemeProvider, useWorkhorseTheme } = await import("./theme.js");
    function Scheme() {
      return createElement("output", null, useWorkhorseTheme().scheme);
    }
    const markup = renderToStaticMarkup(
      createElement(WorkhorseThemeProvider, null, createElement(Scheme)),
    );
    expect(markup).toContain("<output>dark</output>");
  });
});

describe("dashboard preferences when only storage writes fail", () => {
  beforeEach(() => {
    const saved = new Map([
      ["workhorse-activity-period", "24h"],
      ["workhorse-activity-group", "queue"],
      ["workhorse-auto-refresh", "1m"],
      ["workhorse-system-window", "24h"],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: deniedStorage.setItem,
    });
  });

  it("keeps a changed value for the session instead of the saved value", async () => {
    const { readStoredValue, storeValue } = await import("./browser-storage.js");
    expect(readStoredValue("workhorse-auto-refresh")).toBe("1m");
    storeValue("workhorse-auto-refresh", "off");
    expect(readStoredValue("workhorse-auto-refresh")).toBe("off");
  });

  it("applies the default chart options after the operator selects them", async () => {
    const [{ storeValue }, core] = await Promise.all([
      import("./browser-storage.js"),
      import("./core.js"),
    ]);
    expect(core.readLocation()).toMatchObject({ period: "24h", group: "queue" });
    storeValue("workhorse-activity-period", "1h");
    storeValue("workhorse-activity-group", "task");
    expect(core.readLocation()).toMatchObject({ period: "1h", group: "task" });
  });

  it("applies a changed refresh interval and system window", async () => {
    const [{ storeValue }, { readStoredRefreshInterval, refreshStorageKey }, core] =
      await Promise.all([
        import("./browser-storage.js"),
        import("./shell/controller.js"),
        import("./core.js"),
      ]);
    storeValue(refreshStorageKey, "off");
    storeValue(core.systemWindowStorageKey, "1h");
    expect(readStoredRefreshInterval()).toBe("off");
    expect(core.readStoredSystemWindow()).toBe("1h");
  });
});

describe("theme script in the HTML page", () => {
  const html = readFileSync(new URL("../browser/index.html", import.meta.url), "utf8");
  const script = /<script>\s*(\(\(\) => \{[\s\S]*?\}\)\(\);)\s*<\/script>/.exec(html)?.[1];

  function runThemeScript(storage: unknown, prefersDark: boolean) {
    const documentElement = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
    new Function("localStorage", "matchMedia", "document", script!)(
      storage,
      () => ({ matches: prefersDark }),
      { documentElement },
    );
    return documentElement;
  }

  it("uses the system color scheme when storage is denied", () => {
    expect(script).toContain("workhorse-theme-scheme");
    const root = runThemeScript(deniedStorage, false);
    expect(root.dataset.mantineColorScheme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("uses the saved color scheme when storage is available", () => {
    const root = runThemeScript({ getItem: () => "dark" }, false);
    expect(root.dataset.mantineColorScheme).toBe("dark");
  });
});
