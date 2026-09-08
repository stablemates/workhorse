import { ActionIcon, Box, CheckIcon, Group, SegmentedControl, Text, Tooltip } from "./ui/index.js";
import { Menu } from "./dropdown-activity.js";
import { Moon, Palette, Sun } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DashboardNotifications } from "./notifications.js";

export type DashboardColorScheme = "light" | "dark";

const themeStorageKey = "workhorse-theme-scheme";
const themeSchemes = new Set<DashboardColorScheme>(["light", "dark"]);

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
    document.documentElement.classList.toggle("dark", scheme === "dark");

    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    themeColor?.setAttribute("content", scheme === "light" ? "#ffffff" : "#171717");
  }, [scheme]);

  const contextValue = useMemo(() => ({ scheme, setScheme }), [scheme]);

  return (
    <ThemeContext.Provider value={contextValue}>
      <>
        {/* Mounted above the application so an operator result raised during navigation, or by a
            panel that closes itself, still has a container to arrive in. */}
        <DashboardNotifications />
        {children}
      </>
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
