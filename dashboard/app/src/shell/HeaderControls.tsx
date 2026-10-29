import {
  Alert02Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  ComputerIcon,
  Moon02Icon,
  PauseIcon,
  RefreshIcon,
  ServerStack02Icon,
  SidebarLeftIcon,
  Sun03Icon,
  Tick02Icon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { mergeProps } from "@base-ui/react/merge-props";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import {
  cloneElement,
  useState,
  type ComponentProps,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type { LoadState } from "../core.js";
import { usePopupActivity } from "../dropdown-activity.js";
import {
  dashboardRefreshIntervals,
  type DashboardRefreshIntervalValue,
} from "../refresh-policy.js";
import { useWorkhorseTheme, type DashboardThemePreference } from "../theme.js";
import { Button, Menu, Popover, Tooltip } from "../ui.js";

type HeaderButtonKind = "icon" | "settings" | "account";

/**
 * Every header control is 32px high, so the row reads as one line in the 56px bar. An icon button
 * is square. A button with text uses a smaller horizontal padding than the theme's ghost button.
 */
const headerButtonGeometry = {
  icon: { width: 32, height: 32, padding: 0 },
  settings: { height: 32, paddingTop: 0, paddingBottom: 0, paddingLeft: 6, paddingRight: 6 },
  account: { height: 32, paddingTop: 0, paddingBottom: 0, paddingLeft: 8, paddingRight: 8 },
} as const satisfies Record<HeaderButtonKind, CSSProperties>;

/** The props that a themed Graphical trigger part adds for its own surface. */
interface PartSurfaceProps {
  className?: unknown;
  style?: unknown;
  "data-ui-part"?: unknown;
  "data-ui-component"?: unknown;
}

/**
 * Removes the surface of a themed trigger part.
 *
 * Each themed trigger part, such as a tooltip or a menu trigger, brings its own class, style, and
 * part attributes. The header controls draw their own surface, so they keep the behavior of the
 * trigger and drop that surface.
 */
export function withoutPartSurface<Props extends object>(
  props: Props,
): Omit<Props, keyof PartSurfaceProps> {
  const {
    className: _className,
    style: _style,
    "data-ui-part": _part,
    "data-ui-component": _component,
    ...rest
  } = props as Props & PartSurfaceProps;
  return rest;
}

/** Renders a Base UI trigger as a ghost Graphical button. */
function HeaderButton({ kind, ...props }: ComponentProps<"button"> & { kind: HeaderButtonKind }) {
  return (
    <Button
      {...withoutPartSurface(props)}
      variant="ghost"
      className={`dashboard-header-button dashboard-header-button--${kind}`}
      style={headerButtonGeometry[kind]}
    />
  );
}

/** Supplements the accessible name of a header control with a hover and focus label. */
function HeaderTooltip({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactElement<Record<string, unknown>>;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={400}
        render={(props) =>
          cloneElement(children, mergeProps(withoutPartSurface(props), children.props))
        }
      />
      <Tooltip.Portal>
        <Tooltip.Positioner side="bottom" sideOffset={6}>
          <Tooltip.Popup>{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function Icon({ icon, size = 16 }: { icon: IconSvgElement; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} aria-hidden="true" />;
}

/**
 * Opens and closes the navigation. On a narrow screen the navigation is a drawer over the page;
 * on a wide one it is the sidebar. The tooltip names the keyboard shortcut that does the same.
 */
export function NavigationToggle({
  expanded,
  onToggle,
  controls,
  shortcut,
}: {
  expanded: boolean;
  onToggle: () => void;
  /** The id of the navigation region. */
  controls: string;
  /** The shortcut that toggles the navigation, as the tooltip shows it and as ARIA names it. */
  shortcut: { label: string; aria: string };
}) {
  const label = expanded ? "Hide navigation" : "Show navigation";
  return (
    <HeaderTooltip
      label={
        <span className="dashboard-header-tooltip">
          {label}
          <kbd className="dashboard-header-tooltip__shortcut">{shortcut.label}</kbd>
        </span>
      }
    >
      <HeaderButton
        kind="icon"
        aria-label={label}
        aria-expanded={expanded}
        aria-controls={controls}
        aria-keyshortcuts={shortcut.aria}
        onClick={onToggle}
      >
        <Icon icon={SidebarLeftIcon} />
      </HeaderButton>
    </HeaderTooltip>
  );
}

/** Environment values that start with `prod`, in any case, get production emphasis. */
export function isProductionEnvironment(environment: string): boolean {
  return environment.toLowerCase().startsWith("prod");
}

/**
 * Whether a host value names a deployment environment.
 *
 * The standalone CLI states `standalone`, and a host that names no environment states `unknown`.
 * Neither tells the operator where the database runs, so the header does not show them.
 */
export function namesDeploymentEnvironment(environment: string): boolean {
  const value = environment.trim().toLowerCase();
  return value !== "" && value !== "standalone" && value !== "unknown";
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The deployment environment that the host names. It is information only: it does not change
 * what an operator can do.
 */
export function EnvironmentIndicator({ environment }: { environment: string }) {
  const production = isProductionEnvironment(environment);
  const label = sentenceCase(environment);
  return (
    <span
      className="dashboard-environment"
      data-production={production || undefined}
      title={`Deployment environment: ${label}`}
    >
      <Icon icon={ServerStack02Icon} size={14} />
      <span className="dashboard-visually-hidden">Environment: </span>
      <span className="dashboard-environment__label">{label}</span>
    </span>
  );
}

export type DashboardConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "refreshFailed";

/**
 * The connection outcome for the page load state.
 *
 * Connecting comes before the first data, and connected after it. Disconnected means the page load
 * failed. Refresh failed means a later refresh failed while the page keeps the older data.
 */
export function dashboardConnectionStatus(loadState: LoadState): DashboardConnectionStatus {
  if (loadState.status === "error") return "disconnected";
  if (loadState.status === "stale") return "refreshFailed";
  return loadState.data === null ? "connecting" : "connected";
}

const connectionPresentation = {
  connecting: { label: "Connecting", icon: null },
  connected: { label: "Connected", icon: null },
  disconnected: { label: "Disconnected", icon: AlertCircleIcon },
  refreshFailed: { label: "Refresh failed", icon: Alert02Icon },
} as const satisfies Record<
  DashboardConnectionStatus,
  { label: string; icon: IconSvgElement | null }
>;

/**
 * The connection state, as one live region.
 *
 * A healthy connection shows nothing, because it needs no action, and keeps its name for
 * assistive technology. A failure shows an icon and its name as text, because the operator must
 * see it. On a narrow screen the failure shows only the icon, and its name stays in the tooltip
 * and the live region.
 */
export function ConnectionIndicator({ status }: { status: DashboardConnectionStatus }) {
  const { label, icon } = connectionPresentation[status];
  return (
    <span role="status" className="dashboard-connection" data-status={status}>
      {icon === null ? (
        <span className="dashboard-visually-hidden">{label}</span>
      ) : (
        <span className="dashboard-connection__mark" title={label}>
          <Icon icon={icon} size={16} />
          <span className="dashboard-connection__label">{label}</span>
        </span>
      )}
    </span>
  );
}

const refreshIntervalLabels = {
  off: "Manual only",
  "5s": "Every 5 seconds",
  "15s": "Every 15 seconds",
  "30s": "Every 30 seconds",
  "1m": "Every minute",
  "5m": "Every 5 minutes",
} as const satisfies Record<DashboardRefreshIntervalValue, string>;

function refreshIntervalValue(value: unknown): DashboardRefreshIntervalValue | null {
  return dashboardRefreshIntervals.find((option) => option.value === value)?.value ?? null;
}

export interface RefreshSettingsProps {
  interval: DashboardRefreshIntervalValue;
  /** True while a blocker or the resume countdown holds auto refresh. */
  paused: boolean;
  /** What holds auto refresh, or the resume countdown. */
  pauseDescription: string;
  /** The first page of a pinned task listing, or null when the listing follows new tasks. */
  firstPageHref: string | null;
  onIntervalChange: (value: DashboardRefreshIntervalValue) => void;
  onFirstPage: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/** The short name of each interval in the compact settings list. */
const refreshIntervalOptionLabels = {
  off: "Off",
  "5s": "5 seconds",
  "15s": "15 seconds",
  "30s": "30 seconds",
  "1m": "1 minute",
  "5m": "5 minutes",
} as const satisfies Record<DashboardRefreshIntervalValue, string>;

/**
 * The body of the refresh settings popover: a compact list of intervals, the pause state, and
 * the way out of a pinned page.
 *
 * Each row is a radio, so the arrow keys move the selection as in any radio group. A check mark
 * marks the selected interval. A pointer click also closes the popover through `onPicked`.
 */
export function RefreshSettings({
  interval,
  paused,
  pauseDescription,
  firstPageHref,
  onIntervalChange,
  onFirstPage,
  onPicked,
}: RefreshSettingsProps & { onPicked?: () => void }) {
  return (
    <div className="dashboard-refresh-settings">
      <BaseRadioGroup
        className="dashboard-refresh-settings__options"
        aria-labelledby="dashboard-refresh-settings-title"
        value={interval}
        onValueChange={(value) => {
          const next = refreshIntervalValue(value);
          if (next !== null) onIntervalChange(next);
        }}
      >
        {dashboardRefreshIntervals.map((option) => (
          <BaseRadio.Root
            key={option.value}
            value={option.value}
            className="dashboard-refresh-option"
            onClick={(event) => {
              // A keyboard selection reports no pointer clicks, and it keeps the list open.
              if (event.detail > 0) onPicked?.();
            }}
          >
            <span className="dashboard-refresh-option__label">
              {refreshIntervalOptionLabels[option.value]}
            </span>
            <BaseRadio.Indicator className="dashboard-refresh-option__check">
              <Icon icon={Tick02Icon} size={14} />
            </BaseRadio.Indicator>
          </BaseRadio.Root>
        ))}
      </BaseRadioGroup>
      {paused && interval !== "off" ? (
        <p className="dashboard-refresh-settings__status">
          <Icon icon={PauseIcon} size={12} />
          <span>{pauseDescription}</span>
        </p>
      ) : null}
      {firstPageHref === null ? null : (
        <p className="dashboard-refresh-settings__pinned">
          <a href={firstPageHref} onClick={onFirstPage}>
            Back to first page
          </a>
        </p>
      )}
    </div>
  );
}

export interface RefreshControlProps extends RefreshSettingsProps {
  loading: boolean;
  onRefresh: () => void;
}

/**
 * Refreshes the page now, and opens the auto refresh settings.
 *
 * The refresh button starts the schedule again. The settings button shows a pause mark while
 * auto refresh is held. Its tooltip and the popover state the reason, so a touch user can read it.
 * The control shows no countdown: a moving mark in the header pulls the eye on every page, and the
 * settings already state the interval.
 */
export function RefreshControl({ loading, onRefresh, ...settings }: RefreshControlProps) {
  const trackPopup = usePopupActivity();
  const [open, setOpen] = useState(false);
  const { interval, paused, pauseDescription } = settings;
  const showPaused = paused && interval !== "off";
  const settingsLabel = showPaused
    ? `Auto refresh settings. ${pauseDescription}`
    : `Auto refresh settings. ${refreshIntervalLabels[interval]}`;
  const changeOpen = (next: boolean) => {
    trackPopup(next);
    setOpen(next);
  };

  return (
    <div className="dashboard-refresh" data-paused={showPaused || undefined}>
      <HeaderTooltip label="Refresh now">
        <HeaderButton
          kind="icon"
          aria-label="Refresh now"
          aria-busy={loading || undefined}
          onClick={onRefresh}
        >
          <span className="dashboard-refresh__icon" data-loading={loading || undefined}>
            <Icon icon={RefreshIcon} />
          </span>
        </HeaderButton>
      </HeaderTooltip>
      <Popover.Root open={open} onOpenChange={changeOpen}>
        <HeaderTooltip label={showPaused ? pauseDescription : refreshIntervalLabels[interval]}>
          <Popover.Trigger
            aria-label={settingsLabel}
            render={(props) => <HeaderButton {...props} kind="settings" />}
          >
            {showPaused ? (
              <span className="dashboard-refresh__paused">
                <Icon icon={PauseIcon} size={12} />
              </span>
            ) : null}
            <Icon icon={ArrowDown01Icon} size={14} />
          </Popover.Trigger>
        </HeaderTooltip>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={8}>
            <Popover.Popup className="dashboard-refresh-popup">
              <Popover.Title
                id="dashboard-refresh-settings-title"
                className="dashboard-refresh-popup__title"
              >
                Auto refresh
              </Popover.Title>
              <RefreshSettings
                {...settings}
                onPicked={() => changeOpen(false)}
                onFirstPage={(event) => {
                  setOpen(false);
                  trackPopup(false);
                  settings.onFirstPage(event);
                }}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

export const appearanceOptions = [
  { value: "light", label: "Light", icon: Sun03Icon },
  { value: "dark", label: "Dark", icon: Moon02Icon },
  { value: "system", label: "System", icon: ComputerIcon },
] as const satisfies ReadonlyArray<{
  value: DashboardThemePreference;
  label: string;
  icon: IconSvgElement;
}>;

/** The preference after `current` in the order Light, Dark, System. */
export function nextAppearance(
  current: DashboardThemePreference,
): (typeof appearanceOptions)[number] {
  const at = appearanceOptions.findIndex((option) => option.value === current);
  return appearanceOptions[(at + 1) % appearanceOptions.length]!;
}

/**
 * One button for the color theme at every width. A click changes the preference in the order
 * Light, Dark, System. The icon shows the stored preference, so System stays visible when it
 * resolves to light or dark. The name states the current and the next preference.
 */
export function AppearanceToggle() {
  const { preference, setPreference } = useWorkhorseTheme();
  const current = appearanceOptions.find((option) => option.value === preference)!;
  const next = nextAppearance(preference);
  const label = `Appearance: ${current.label}. Change to ${next.label}`;
  return (
    <HeaderTooltip label={label}>
      <HeaderButton kind="icon" aria-label={label} onClick={() => setPreference(next.value)}>
        <Icon icon={current.icon} />
      </HeaderButton>
    </HeaderTooltip>
  );
}

/** The signed-in operator. Sign out is a form post, so it works without the client session. */
export function AccountMenu({ actor, logoutUrl }: { actor: string; logoutUrl: string }) {
  const trackPopup = usePopupActivity();
  return (
    <Menu.Root onOpenChange={trackPopup}>
      <Menu.Trigger
        aria-label={`Signed in as ${actor}`}
        title={actor}
        render={(props) => <HeaderButton {...props} kind="account" />}
      >
        <Icon icon={UserCircleIcon} />
        <span className="dashboard-account__name">{actor}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8}>
          <Menu.Popup className="dashboard-header-menu">
            <Menu.Group>
              <Menu.GroupLabel>Signed in as {actor}</Menu.GroupLabel>
              <form action={logoutUrl} method="post">
                <Menu.Item nativeButton render={<button type="submit" />}>
                  Sign out
                </Menu.Item>
              </form>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
