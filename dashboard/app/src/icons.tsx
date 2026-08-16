import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowTurnBackwardIcon,
  Calendar03Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Copy01Icon,
  FilterIcon,
  FlashIcon,
  InformationCircleIcon,
  LeftToRightListDashIcon,
  Moon02Icon,
  MoreVerticalIcon,
  PaintBoardIcon,
  PlayCircleIcon,
  Pulse01Icon,
  RefreshIcon,
  Robot01Icon,
  Search01Icon,
  Settings02Icon,
  Sun03Icon,
  UserCheck01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { CSSProperties } from "react";

/**
 * Every icon the dashboard draws, and the only module that imports an icon package.
 *
 * The dashboard used to import glyphs from an icon library directly at each call site, which put
 * the vendor's export names and its per-icon prop spelling into every screen file. Migrating
 * libraries then meant editing every screen, and a raw `size={16}` at a call site meant no two
 * places had to agree on what "an icon in a menu row" measures. This module is the seam: screens
 * name the meaning they want, this file decides which drawing and which measurements serve it.
 *
 * Names here describe what the icon means to an operator, not what it depicts, so the picture can
 * change without a rename rippling through the screens.
 */

/**
 * The sizes an icon is allowed to be, named for where it appears rather than for how big it is.
 *
 * A call site picks a role and gets the measurement that role has agreed on. Nothing outside this
 * module states a pixel count, so changing what "a menu icon" measures is one edit here.
 */
export const iconSize = {
  /** Inside a badge or a compact chip, beside text already at its smallest. */
  chip: 11,
  /** Beside dense inline text, such as a status line in a table cell. */
  inline: 12,
  /** Inside a stepper bullet, which sits between the inline and control sizes. */
  bullet: 13,
  /** On a control an operator clicks: a button, an action icon, a search field. */
  control: 14,
  /** A stepper's completed marker, one step up from a control. */
  marker: 15,
  /** In a menu row, a dropdown item, or a summary tile. */
  menu: 16,
  /** In primary navigation and page-level alerts. */
  navigation: 18,
  /** A feature-sized glyph, such as an empty state's badge. */
  feature: 22,
  /** A page-level failure that has to be seen before the sentence under it is read. */
  page: 28,
} as const;

export type IconSize = (typeof iconSize)[keyof typeof iconSize];

/**
 * Stroke weights, named for emphasis rather than for a number.
 *
 * The previous library expressed emphasis as a named weight and this one expresses it as a stroke
 * width, so the mapping lives here once instead of at each call site.
 */
export const iconStroke = {
  /** The default line, for an icon that labels something. */
  regular: 1.5,
  /** A heavier line, for an icon that carries state an operator is scanning for. */
  bold: 2,
} as const;

export type IconWeight = keyof typeof iconStroke;

/**
 * What every icon in this module accepts.
 *
 * Deliberately narrower than the underlying library's props: a call site chooses a size role and
 * an emphasis, and may pass the presentation attributes the surrounding component needs. It cannot
 * reach the vendor's own prop names, so those stay replaceable.
 */
export interface DashboardIconProps {
  /** One of the named sizes. Defaults to the menu size, the commonest role. */
  size?: IconSize;
  /** Emphasis, mapped to a stroke width. Defaults to regular. */
  weight?: IconWeight;
  /** CSS colour, for the rare icon that carries a colour the theme does not supply. */
  color?: string;
  style?: CSSProperties;
  className?: string;
  /** Hide a purely decorative icon from assistive technology. */
  "aria-hidden"?: boolean;
  "aria-label"?: string;
  role?: string;
}

/** The shape of every icon this module exports, for a caller that stores one to render later. */
export type DashboardIcon = (props: DashboardIconProps) => React.JSX.Element;

function createIcon(icon: IconSvgElement, displayName: string): DashboardIcon {
  function DashboardIconComponent({
    size = iconSize.menu,
    weight = "regular",
    ...rest
  }: DashboardIconProps) {
    return <HugeiconsIcon icon={icon} size={size} strokeWidth={iconStroke[weight]} {...rest} />;
  }
  DashboardIconComponent.displayName = displayName;
  return DashboardIconComponent;
}

/** A successful or completed outcome. */
export const CheckCircleIcon = createIcon(CheckmarkCircle02Icon, "CheckCircleIcon");
/** A failure or a warning an operator has to read. */
export const WarningIcon = createIcon(Alert02Icon, "WarningIcon");
/** Neutral explanation, offered rather than raised. */
export const InfoIcon = createIcon(InformationCircleIcon, "InfoIcon");
/** A discarded task: an outcome that ended without succeeding. */
export const DiscardedIcon = createIcon(CancelCircleIcon, "DiscardedIcon");
/** Work that is refused or stopped: a cancellation, or a blocked task. */
export const ProhibitIcon = createIcon(Cancel01Icon, "ProhibitIcon");
/** Time: a schedule, a wait, or a delay. */
export const ClockIcon = createIcon(Clock01Icon, "ClockIcon");
/** A calendar of recurring work. */
export const CalendarIcon = createIcon(Calendar03Icon, "CalendarIcon");
/** Copy a value to the clipboard. */
export const CopyIcon = createIcon(Copy01Icon, "CopyIcon");
/** The overflow menu on a row. */
export const RowMenuIcon = createIcon(MoreVerticalIcon, "RowMenuIcon");
/** Filtering, and the fallback glyph for an unnamed row action. */
export const FilterIconGlyph = createIcon(FilterIcon, "FilterIconGlyph");
/** Settings. */
export const SettingsIcon = createIcon(Settings02Icon, "SettingsIcon");
/** A run, a dispatch, or throughput: the fast path through the system. */
export const LightningIcon = createIcon(FlashIcon, "LightningIcon");
/** Queued work waiting its turn. */
export const QueuedIcon = createIcon(LeftToRightListDashIcon, "QueuedIcon");
/** A list of tasks. */
export const TaskListIcon = createIcon(CheckListIcon, "TaskListIcon");
/** Search. */
export const SearchIcon = createIcon(Search01Icon, "SearchIcon");
/** Start something now. */
export const PlayIcon = createIcon(PlayCircleIcon, "PlayIcon");
/** Live activity and health. */
export const ActivityIcon = createIcon(Pulse01Icon, "ActivityIcon");
/** A worker process. */
export const WorkerIcon = createIcon(Robot01Icon, "WorkerIcon");
/** Work waiting on a person's decision. */
export const HumanWaitIcon = createIcon(UserCheck01Icon, "HumanWaitIcon");
/** Retry, or a task that has been retried. */
export const RetryIcon = createIcon(ArrowTurnBackwardIcon, "RetryIcon");
/** Refresh the data on screen. */
export const RefreshIconGlyph = createIcon(RefreshIcon, "RefreshIconGlyph");
/** The light colour theme. */
export const LightThemeIcon = createIcon(Sun03Icon, "LightThemeIcon");
/** The dark colour theme. */
export const DarkThemeIcon = createIcon(Moon02Icon, "DarkThemeIcon");
/**
 * The colour theme control itself.
 *
 * Named for the colour theme rather than for "theme" alone so it cannot be confused with Mantine's
 * `ThemeIcon` container, which several screens import to draw a tinted badge around an icon.
 */
export const ColorThemeIcon = createIcon(PaintBoardIcon, "ColorThemeIcon");
