import {
  ActionIcon,
  Box,
  CheckIcon,
  createTheme,
  type CSSVariablesResolver,
  Group,
  MantineProvider,
  SegmentedControl,
  Text,
  Tooltip,
} from "@mantine/core";
import { Menu } from "./dropdown-activity.js";
import { Desktop, Moon, Palette, Sun } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DashboardNotifications } from "./notifications.js";
import { readStoredValue, storeValue } from "./browser-storage.js";
import { statusTextColors } from "./status-colors.js";

export type DashboardColorScheme = "light" | "dark";
/** The theme the user selects. "system" follows the color scheme of the browser. */
export type DashboardThemePreference = DashboardColorScheme | "system";

const themeStorageKey = "workhorse-theme-scheme";
const themePreferences = new Set<DashboardThemePreference>(["system", "light", "dark"]);
const darkSchemeQuery = "(prefers-color-scheme: dark)";

const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    "--workhorse-color-warning-text": statusTextColors.warning.light,
    "--workhorse-color-danger-text": statusTextColors.danger.light,
  },
  dark: {
    "--workhorse-color-warning-text": statusTextColors.warning.dark,
    "--workhorse-color-danger-text": statusTextColors.danger.dark,
  },
});

const theme = createTheme({
  primaryColor: "steel",
  primaryShade: { light: 7, dark: 5 },
  fontFamily:
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  headings: {
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: "700",
  },
  defaultRadius: "sm",
  colors: {
    steel: [
      "#f4f6f8",
      "#e6eaee",
      "#ccd3da",
      "#afb9c3",
      "#96a2ae",
      "#8594a1",
      "#768592",
      "#626f7b",
      "#535e68",
      "#454e57",
    ],
  },
});

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
    themeColor?.setAttribute("content", scheme === "light" ? "#f7f8fa" : "#1a1b1e");
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
        theme={theme}
        forceColorScheme={scheme}
        cssVariablesResolver={cssVariablesResolver}
      >
        {/* Mounted above the application so an operator result raised during navigation, or by a
            panel that closes itself, still has a container to arrive in. */}
        <DashboardNotifications />
        {children}
      </MantineProvider>
    </ThemeContext.Provider>
  );
}

export function useWorkhorseTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useWorkhorseTheme must be used inside WorkhorseThemeProvider");
  return value;
}

const options: Array<{
  value: DashboardThemePreference;
  label: string;
  icon: ReactNode;
}> = [
  { value: "light", label: "Light", icon: <Sun size={14} /> },
  { value: "dark", label: "Dark", icon: <Moon size={14} /> },
  { value: "system", label: "System", icon: <Desktop size={14} /> },
];

function ThemeOptionLabel({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <Group gap={6} wrap="nowrap">
      {icon}
      <Text component="span" size="xs" fw={650}>
        {label}
      </Text>
    </Group>
  );
}

export function ThemeSchemeSwitch() {
  const { preference, setPreference } = useWorkhorseTheme();

  return (
    <>
      <Box visibleFrom="lg">
        <SegmentedControl
          size="xs"
          value={preference}
          onChange={(value) => setPreference(value as DashboardThemePreference)}
          aria-label="Color theme"
          className="theme-switch"
          data={options.map((option) => ({
            value: option.value,
            label: <ThemeOptionLabel icon={option.icon} label={option.label} />,
          }))}
        />
      </Box>
      <Box hiddenFrom="lg">
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Tooltip label="Change color theme">
              <ActionIcon variant="default" size="lg" aria-label="Change color theme">
                <Palette size={18} />
              </ActionIcon>
            </Tooltip>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Color theme</Menu.Label>
            {options.map((option) => (
              <Menu.Item
                key={option.value}
                leftSection={option.icon}
                rightSection={preference === option.value ? <CheckIcon size={12} /> : null}
                onClick={() => setPreference(option.value)}
              >
                {option.label}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Box>
    </>
  );
}
