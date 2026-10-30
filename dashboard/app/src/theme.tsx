import { MantineProvider } from "@mantine/core";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DashboardNotifications } from "./notifications.js";
import { readStoredValue, storeValue } from "./browser-storage.js";
// Imported by module, not through `ui.ts`, so the first page load does not fetch every component.
import { GraphicalProvider } from "./components/graphical/components/library/graphical-provider.js";
import { dashboardThemeDocument } from "./theme-document.js";
import { DashboardIconRenderer } from "./graphical-icons.js";
import {
  dashboardCssVariablesResolver,
  dashboardMantineTheme,
  dashboardPageColor,
} from "./mantine-theme.js";

export type DashboardColorScheme = "light" | "dark";
/** The theme the user selects. "system" follows the color scheme of the browser. */
export type DashboardThemePreference = DashboardColorScheme | "system";

const themeStorageKey = "workhorse-theme-scheme";
const themePreferences = new Set<DashboardThemePreference>(["system", "light", "dark"]);
const darkSchemeQuery = "(prefers-color-scheme: dark)";

interface ThemeContextValue {
  /** The color scheme the dashboard shows now. */
  scheme: DashboardColorScheme;
  /** Selects a fixed color scheme. It is the same as `setPreference` with that scheme. */
  setScheme: (scheme: DashboardColorScheme) => void;
  preference: DashboardThemePreference;
  setPreference: (preference: DashboardThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** A missing or unknown stored value means System, so the dashboard stores nothing until a choice. */
export function readStoredThemePreference(): DashboardThemePreference {
  const stored = readStoredValue(themeStorageKey) as DashboardThemePreference | null;
  return stored && themePreferences.has(stored) ? stored : "system";
}

function readSystemScheme(): DashboardColorScheme {
  return window.matchMedia(darkSchemeQuery).matches ? "dark" : "light";
}

/** Calls `onChange` each time the browser color scheme changes, until the returned stop runs. */
export function followSystemScheme(onChange: (scheme: DashboardColorScheme) => void): () => void {
  const query = window.matchMedia(darkSchemeQuery);
  const follow = () => onChange(query.matches ? "dark" : "light");
  query.addEventListener("change", follow);
  return () => query.removeEventListener("change", follow);
}

export function WorkhorseThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(readStoredThemePreference);
  const [systemScheme, setSystemScheme] = useState(readSystemScheme);
  const scheme = preference === "system" ? systemScheme : preference;

  // The listener stays attached for every preference, so a later System choice is current.
  useEffect(() => followSystemScheme(setSystemScheme), []);

  useEffect(() => {
    document.documentElement.style.colorScheme = scheme;

    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    themeColor?.setAttribute("content", dashboardPageColor[scheme]);
  }, [scheme]);

  const contextValue = useMemo<ThemeContextValue>(() => {
    const setPreference = (next: DashboardThemePreference) => {
      // Only a selection stores a value, so the stored value always records a user choice.
      storeValue(themeStorageKey, next);
      setPreferenceState(next);
    };
    return { scheme, setScheme: setPreference, preference, setPreference };
  }, [scheme, preference]);

  return (
    <ThemeContext.Provider value={contextValue}>
      <MantineProvider
        theme={dashboardMantineTheme}
        forceColorScheme={scheme}
        cssVariablesResolver={dashboardCssVariablesResolver}
      >
        {/* The Graphical components read the same theme. Its provider also carries the theme
            and the color scheme into the portals of those components. */}
        <GraphicalProvider document={dashboardThemeDocument} colorMode={scheme}>
          <DashboardIconRenderer>
            {/* Mounted above the application so an operator result raised during navigation, or
                by a panel that closes itself, still has a container to arrive in. */}
            <DashboardNotifications />
            {children}
          </DashboardIconRenderer>
        </GraphicalProvider>
      </MantineProvider>
    </ThemeContext.Provider>
  );
}

export function useWorkhorseTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useWorkhorseTheme must be used inside WorkhorseThemeProvider");
  return value;
}
