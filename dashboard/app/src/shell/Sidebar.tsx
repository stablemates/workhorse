import {
  BookOpen01Icon,
  Calendar03Icon,
  Cancel01Icon,
  FlashIcon,
  HelpCircleIcon,
  Layers01Icon,
  LeftToRightListDashIcon,
  Pulse01Icon,
  ServerStack01Icon,
  Settings02Icon,
  Task01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Drawer as BaseDrawer } from "@base-ui/react/drawer";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { useMediaQuery } from "@mantine/hooks";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";

import {
  themeContainer,
  themePart,
} from "../components/graphical/components/library/component-theme.js";
import { WorkhorseBrand, workhorseCommitUrl } from "../brand.js";
import { readStoredValue, storeValue } from "../browser-storage.js";
import { usePopupActivity } from "../dropdown-activity.js";
import { mountedHref, type PageRoute } from "../core.js";

/*
 * The Graphical parts the sidebar uses, themed with the same bindings as
 * `components/graphical/components/library/primitives.tsx`. That module imports every Base UI
 * component, and the sidebar is part of the first paint, so the sidebar imports only these.
 */
const Menu = {
  Root: BaseMenu.Root,
  Portal: BaseMenu.Portal,
  Group: BaseMenu.Group,
  Positioner: themeContainer(BaseMenu.Positioner, "ui-positioner"),
  Popup: themePart(BaseMenu.Popup, "menu", "popover", "ui-popup ui-menu ui-menu-detailed"),
  Item: themePart(BaseMenu.Item, "menu", "option", "ui-option"),
  /** A menu entry that is a real link, so a modified click and the context menu still work. */
  LinkItem: themePart(BaseMenu.LinkItem, "menu", "option", "ui-option ui-link"),
  GroupLabel: themePart(BaseMenu.GroupLabel, "menu", "label", "ui-menu-group-label"),
  Separator: themePart(BaseMenu.Separator, "menu", "separator", "ui-separator"),
};
const Tooltip = {
  Root: BaseTooltip.Root,
  Portal: BaseTooltip.Portal,
  Positioner: themeContainer(BaseTooltip.Positioner, "ui-positioner"),
  Popup: themePart(BaseTooltip.Popup, "tooltip", "popover", "ui-popup ui-tooltip"),
};
const ScrollArea = {
  Root: themePart(BaseScrollArea.Root, "scroll-area", "viewport", "ui-scroll-root"),
  Viewport: themeContainer(BaseScrollArea.Viewport, "ui-scroll-viewport"),
  Scrollbar: themePart(BaseScrollArea.Scrollbar, "scroll-area", "scrollbar", "ui-scrollbar"),
  Thumb: themePart(BaseScrollArea.Thumb, "scroll-area", "thumb", "ui-scroll-thumb"),
};
const Drawer = {
  Root: BaseDrawer.Root,
  Portal: BaseDrawer.Portal,
  Backdrop: themePart(BaseDrawer.Backdrop, "drawer", "backdrop", "ui-backdrop"),
  Viewport: themeContainer(BaseDrawer.Viewport, "ui-drawer-viewport"),
  Popup: themePart(BaseDrawer.Popup, "drawer", "popover", "ui-popup ui-drawer"),
};

const documentationUrl = "https://workhorse.run/docs";
const sidebarCollapsedKey = "workhorse-sidebar-collapsed";

/**
 * The sidebar width in pixels, expanded and as a collapsed rail. `--sidebar-panel-width` in
 * `sidebar.css` states the expanded width again for the rail transforms.
 */
export const dashboardSidebarWidth = { expanded: 232, collapsed: 56 } as const;

/** The stored rail choice. A missing or unknown value means expanded. */
export function readStoredSidebarCollapsed(): boolean {
  return readStoredValue(sidebarCollapsedKey) === "true";
}

export function storeSidebarCollapsed(collapsed: boolean): void {
  storeValue(sidebarCollapsedKey, String(collapsed));
}

/** Whether the desktop sidebar shows as a collapsed rail, and the setter that stores the choice. */
export function useSidebarCollapsed(): readonly [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsedState] = useState(readStoredSidebarCollapsed);
  const setCollapsed = useCallback((next: boolean) => {
    storeSidebarCollapsed(next);
    setCollapsedState(next);
  }, []);
  return [collapsed, setCollapsed] as const;
}

/** The keys of the navigation shortcut, as a person reads them and as ARIA names them. */
interface NavigationShortcut {
  label: string;
  aria: string;
}

/** Command-B on Apple platforms, Control-B on the others. */
export function navigationShortcut(apple: boolean): NavigationShortcut {
  return apple ? { label: "⌘B", aria: "Meta+B" } : { label: "Ctrl+B", aria: "Control+B" };
}

/** True on macOS and iOS, where Command is the shortcut modifier. */
export function onApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

type ShortcutKeys = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** Whether a key press is the navigation shortcut: B with only the platform modifier. */
export function isNavigationShortcut(event: ShortcutKeys, apple: boolean): boolean {
  if (event.key.toLowerCase() !== "b" || event.altKey || event.shiftKey) return false;
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Whether a key press goes to a control that edits text or a value. */
function inEditableControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return (
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
    null
  );
}

/**
 * Calls `onToggle` for the navigation shortcut anywhere in the document.
 *
 * In a text field, a select, or editable content, the key press stays with that control, so
 * Control-B or Command-B keeps its usual meaning there.
 */
export function useNavigationShortcut(onToggle: () => void): void {
  const latest = useRef(onToggle);
  latest.current = onToggle;
  useEffect(() => {
    const apple = onApplePlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (!isNavigationShortcut(event, apple) || inEditableControl(event.target)) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** An entry of the Help menu. Each one opens outside the dashboard, in a new tab. */
interface HelpMenuEntry {
  group: "help" | "about";
  label: string;
  icon?: IconSvgElement;
  /** Text after the label, such as the short revision. */
  detail?: string;
  /** Absent for a version without a revision: the entry then shows the version only. */
  href?: string;
  title?: string;
  accessibleName?: string;
}

/** Documentation, then About with the version and its commit when the build names them. */
export function helpMenuEntries(
  version: string | undefined,
  revision: string | undefined,
): HelpMenuEntry[] {
  const entries: HelpMenuEntry[] = [
    { group: "help", label: "Documentation", icon: BookOpen01Icon, href: documentationUrl },
  ];
  if (version === undefined) return entries;
  entries.push(
    revision === undefined
      ? {
          group: "about",
          label: `Workhorse v${version}`,
          accessibleName: `Workhorse version ${version}`,
        }
      : {
          group: "about",
          label: `Workhorse v${version}`,
          detail: revision.slice(0, 7),
          href: `${workhorseCommitUrl}${revision}`,
          title: revision,
          accessibleName: `Workhorse version ${version}, revision ${revision}`,
        },
  );
  return entries;
}

type NavigateHandler = (event: MouseEvent<HTMLElement>, href: string) => void;

export interface DashboardSidebarProps {
  /** The page that shows now. */
  location: { route: PageRoute };
  /** The path the host mounts the dashboard under, or `""`. */
  basePath: string;
  /**
   * Called for a click on a dashboard link. It navigates inside the app for a plain click and
   * leaves a modified click to the browser.
   */
  onNavigate: NavigateHandler;
  /**
   * True shows the 56px rail. The mobile drawer ignores it. The rail only narrows the visible part
   * of the sidebar: every icon keeps its place, and the sidebar clips and fades the labels.
   */
  collapsed: boolean;
  /** A control under the brand, for example the workspace switcher. The rail clips it to its tile. */
  workspaceControl?: ReactNode;
  /** Called when a pointer or the focus reaches a link, so the page can load before the click. */
  onPrefetch?: (href: string) => void;
  version?: string;
  revision?: string;
  /** `drawer` is the mobile navigation: always expanded, with a close button and no rail. */
  variant?: "panel" | "drawer";
  /** Closes the mobile drawer. Only the `drawer` variant uses it. */
  onClose?: () => void;
}

interface Destination {
  route: PageRoute;
  label: string;
  icon: IconSvgElement;
}

/** The top-level pages in order. The status views of Tasks are on the Tasks page itself. */
const destinations: readonly Destination[] = [
  { route: "/tasks", label: "Tasks", icon: Task01Icon },
  { route: "/events", label: "Events", icon: FlashIcon },
  { route: "/groups", label: "Task groups", icon: Layers01Icon },
  { route: "/cron", label: "Schedules", icon: Calendar03Icon },
  { route: "/queues", label: "Queues", icon: LeftToRightListDashIcon },
  { route: "/workers", label: "Workers", icon: ServerStack01Icon },
  { route: "/system", label: "System health", icon: Pulse01Icon },
];

/** Every sidebar icon uses one size and one stroke weight. */
const iconSize = 16;
const iconStroke = 1.5;
/**
 * The gap from an item's icon box to a rail tooltip or menu. The box ends 10px inside the 56px
 * rail, so the popup starts 8px past the rail edge.
 */
const railPopupOffset = 18;

function NavIcon({ icon }: { icon: IconSvgElement }) {
  return (
    <HugeiconsIcon
      icon={icon}
      size={iconSize}
      strokeWidth={iconStroke}
      className="dashboard-sidebar__icon"
      aria-hidden
    />
  );
}

/**
 * The 36px by 32px box around an item's icon. In the rail it is the visible item: the selected
 * and hover surface covers only it, and tooltips and menus open beside it.
 */
function ItemGlyph({
  icon,
  glyph,
}: {
  icon: IconSvgElement;
  glyph: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <span className="dashboard-sidebar__glyph" ref={glyph}>
      <NavIcon icon={icon} />
    </span>
  );
}

/**
 * Shows `label` beside a rail item. The expanded sidebar shows labels as text, so the tooltip is
 * disabled there. The tree is the same in both states: if the trigger were unwrapped when the rail
 * opens, React would replace each row, and the label fade in `sidebar.css` could not run.
 *
 * The row keeps its full width in the rail, and the sidebar clips it, so the tooltip opens beside
 * the icon box and not beside the row.
 */
function RailTooltip({
  enabled,
  label,
  render,
  anchor,
}: {
  enabled: boolean;
  label: ReactNode;
  render: ReactElement;
  anchor: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <Tooltip.Root disabled={!enabled}>
      <BaseTooltip.Trigger render={render} />
      <Tooltip.Portal>
        <Tooltip.Positioner
          side="right"
          sideOffset={railPopupOffset}
          anchor={anchor}
          className="dashboard-sidebar-layer"
        >
          <Tooltip.Popup>{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function NavItem({
  href,
  basePath,
  label,
  icon,
  active,
  rail,
  onNavigate,
  onPrefetch,
}: {
  href: string;
  basePath: string;
  label: string;
  icon: IconSvgElement;
  active: boolean;
  rail: boolean;
  onNavigate: NavigateHandler;
  onPrefetch: ((href: string) => void) | undefined;
}) {
  const prefetch = active || onPrefetch === undefined ? undefined : () => onPrefetch(href);
  const glyph = useRef<HTMLSpanElement | null>(null);
  const link = (
    <a
      className="dashboard-sidebar__row"
      href={mountedHref(basePath, href)}
      aria-current={active ? "page" : undefined}
      aria-label={rail ? label : undefined}
      onClick={(event) => onNavigate(event, href)}
      onPointerEnter={prefetch}
      onFocus={prefetch}
    >
      <ItemGlyph icon={icon} glyph={glyph} />
      <span className="dashboard-sidebar__label">{label}</span>
    </a>
  );
  return (
    <li>
      <RailTooltip enabled={rail} label={label} render={link} anchor={glyph} />
    </li>
  );
}

function HelpEntry({ entry }: { entry: HelpMenuEntry }) {
  const content = (
    <span className="ui-menu-item-content" data-menu-icon>
      <span className="ui-menu-item-icon" aria-hidden="true">
        {entry.icon === undefined ? null : <NavIcon icon={entry.icon} />}
      </span>
      <span className="ui-menu-item-label">{entry.label}</span>
      {entry.detail === undefined ? null : (
        <span className="dashboard-sidebar__count">{entry.detail}</span>
      )}
    </span>
  );
  if (entry.href === undefined) {
    return (
      <Menu.Item disabled aria-label={entry.accessibleName}>
        {content}
      </Menu.Item>
    );
  }
  return (
    <Menu.LinkItem
      href={entry.href}
      target="_blank"
      rel="noreferrer"
      closeOnClick
      title={entry.title}
      aria-label={entry.accessibleName}
    >
      {content}
    </Menu.LinkItem>
  );
}

function HelpMenu({
  rail,
  side,
  version,
  revision,
}: {
  rail: boolean;
  /** The panel opens it to the right. The mobile drawer fills the width, so it opens upward. */
  side: "right" | "top";
  version: string | undefined;
  revision: string | undefined;
}) {
  const trackPopup = usePopupActivity();
  const glyph = useRef<HTMLSpanElement | null>(null);
  const entries = helpMenuEntries(version, revision);
  const help = entries.filter((entry) => entry.group === "help");
  const about = entries.filter((entry) => entry.group === "about");
  return (
    <li>
      <Menu.Root onOpenChange={trackPopup}>
        <RailTooltip
          enabled={rail}
          label="Help"
          anchor={glyph}
          render={
            <BaseMenu.Trigger
              className="dashboard-sidebar__row"
              aria-label={rail ? "Help" : undefined}
            >
              <ItemGlyph icon={HelpCircleIcon} glyph={glyph} />
              <span className="dashboard-sidebar__label">Help</span>
            </BaseMenu.Trigger>
          }
        />
        <Menu.Portal>
          {/* In the rail the menu opens beside the icon box, where the rail tooltip opens. */}
          <Menu.Positioner
            side={side}
            align={side === "right" ? "end" : "start"}
            sideOffset={rail ? railPopupOffset : side === "right" ? 10 : 4}
            anchor={rail ? glyph : undefined}
            className="dashboard-sidebar-layer"
          >
            <Menu.Popup className="dashboard-sidebar-menu">
              {help.map((entry) => (
                <HelpEntry key={entry.label} entry={entry} />
              ))}
              {about.length === 0 ? null : (
                <>
                  <Menu.Separator />
                  <Menu.Group>
                    <Menu.GroupLabel>About</Menu.GroupLabel>
                    {about.map((entry) => (
                      <HelpEntry key={entry.label} entry={entry} />
                    ))}
                  </Menu.Group>
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </li>
  );
}

/**
 * The dashboard navigation: the brand, an optional workspace control, the top-level pages,
 * Settings, and Help. The Help menu states the version. Destinations are links, so a modified click opens a new tab and
 * `onNavigate` handles a plain click inside the app.
 */
export function DashboardSidebar({
  location,
  basePath,
  onNavigate,
  collapsed,
  workspaceControl,
  onPrefetch,
  version,
  revision,
  variant = "panel",
  onClose,
}: DashboardSidebarProps) {
  const rail = variant === "panel" && collapsed;
  const helpMenu = (
    <HelpMenu
      rail={rail}
      side={variant === "drawer" ? "top" : "right"}
      version={version}
      revision={revision}
    />
  );

  return (
    <BaseTooltip.Provider delay={400}>
      <nav
        className="dashboard-sidebar"
        data-rail={rail || undefined}
        data-variant={variant}
        aria-label="Dashboard"
      >
        <div className="dashboard-sidebar__header">
          <div className="dashboard-sidebar__brand-row">
            {/* The brand is the conventional way home: it links to the host's root page. */}
            <a
              className="dashboard-sidebar__brand"
              href={mountedHref(basePath, "/")}
              aria-label="Workhorse home"
              onClick={(event) => onNavigate(event, "/")}
            >
              {/* The rail keeps the wordmark mounted and fades it, so the brand does not jump. */}
              <WorkhorseBrand />
            </a>
            {variant === "drawer" ? (
              <button
                type="button"
                className="dashboard-sidebar__icon-button"
                aria-label="Close navigation"
                onClick={onClose}
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  size={iconSize}
                  strokeWidth={iconStroke}
                  aria-hidden
                />
              </button>
            ) : null}
          </div>
          {workspaceControl ? (
            <div className="dashboard-sidebar__workspace">{workspaceControl}</div>
          ) : null}
        </div>

        <ScrollArea.Root className="dashboard-sidebar__scroll">
          <ScrollArea.Viewport className="dashboard-sidebar__viewport">
            <ul className="dashboard-sidebar__list">
              {destinations.map((destination) => (
                <NavItem
                  key={destination.route}
                  href={destination.route}
                  basePath={basePath}
                  label={destination.label}
                  icon={destination.icon}
                  active={location.route === destination.route}
                  rail={rail}
                  onNavigate={onNavigate}
                  onPrefetch={onPrefetch}
                />
              ))}
            </ul>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar orientation="vertical">
            <ScrollArea.Thumb />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>

        <div className="dashboard-sidebar__footer">
          <ul className="dashboard-sidebar__list">
            <NavItem
              href="/settings"
              basePath={basePath}
              label="Settings"
              icon={Settings02Icon}
              active={location.route === "/settings"}
              rail={rail}
              onNavigate={onNavigate}
              onPrefetch={onPrefetch}
            />
            {helpMenu}
          </ul>
        </div>
      </nav>
    </BaseTooltip.Provider>
  );
}

/** Narrow windows show the navigation in this modal drawer instead of the sidebar. */
const narrowNavigationQuery = "(max-width: 47.99em)";

/**
 * The navigation as a modal drawer on narrow windows. The controller closes it after each
 * navigation inside the app, so a plain click on a link closes it and a modified click keeps it.
 */
export function DashboardNavigationDrawer({
  opened,
  onOpenChange,
  ...sidebar
}: Omit<DashboardSidebarProps, "variant" | "onClose" | "collapsed"> & {
  opened: boolean;
  onOpenChange: (opened: boolean) => void;
}) {
  const narrow = useMediaQuery(narrowNavigationQuery) ?? false;
  return (
    <Drawer.Root open={opened && narrow} onOpenChange={onOpenChange} swipeDirection="left" modal>
      <Drawer.Portal>
        <Drawer.Backdrop className="dashboard-nav-drawer__backdrop" />
        <Drawer.Viewport className="dashboard-nav-drawer__viewport">
          <Drawer.Popup className="dashboard-nav-drawer" aria-label="Navigation">
            <DashboardSidebar
              {...sidebar}
              variant="drawer"
              collapsed={false}
              onClose={() => onOpenChange(false)}
            />
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
