import {
  ActionIcon,
  Box,
  CheckIcon,
  createTheme,
  Group,
  MantineProvider,
  Menu,
  SegmentedControl,
  Text,
  Tooltip,
} from "@mantine/core";
import { Moon, Palette, Sun } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type DashboardColorScheme = "light" | "dark";

const themeStorageKey = "workhorse-theme-scheme";
const themeSchemes = new Set<DashboardColorScheme>(["light", "dark"]);

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
  scheme: DashboardColorScheme;
  setScheme: (scheme: DashboardColorScheme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialScheme(): DashboardColorScheme {
  const stored = localStorage.getItem(themeStorageKey) as DashboardColorScheme | null;
  if (stored && themeSchemes.has(stored)) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function WorkhorseThemeProvider({ children }: { children: ReactNode }) {
  const [scheme, setScheme] = useState<DashboardColorScheme>(readInitialScheme);

  useEffect(() => {
    localStorage.setItem(themeStorageKey, scheme);
    document.documentElement.style.colorScheme = scheme;

    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    themeColor?.setAttribute("content", scheme === "light" ? "#f7f8fa" : "#1a1b1e");
  }, [scheme]);

  const contextValue = useMemo(() => ({ scheme, setScheme }), [scheme]);

  return (
    <ThemeContext.Provider value={contextValue}>
      <MantineProvider theme={theme} forceColorScheme={scheme}>
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
  value: DashboardColorScheme;
  label: string;
  icon: ReactNode;
}> = [
  { value: "light", label: "Light", icon: <Sun size={14} /> },
  { value: "dark", label: "Dark", icon: <Moon size={14} /> },
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
  const { scheme, setScheme } = useWorkhorseTheme();

  return (
    <>
      <Box visibleFrom="lg">
        <SegmentedControl
          size="xs"
          value={scheme}
          onChange={(value) => setScheme(value as DashboardColorScheme)}
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
                rightSection={scheme === option.value ? <CheckIcon size={12} /> : null}
                onClick={() => setScheme(option.value)}
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
