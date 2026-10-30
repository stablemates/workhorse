'use client';

import {
  createContext,
  useContext,
  useId,
  type CSSProperties,
  type ReactNode,
  type SVGProps,
} from 'react';
import {
  Archive,
  PanelLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  X,
  Info,
  Bold,
  Italic,
  Underline,
  Copy,
  Download,
  FilePlus,
  FolderOpen,
  Printer,
  Save,
  Undo2,
  Redo2,
  ArrowUp,
  CalendarPlus,
  CalendarDays,
  MapPin,
  Tag,
  Package,
  Truck,
  ListOrdered,
  LoaderCircle,
  Timer,
  BookOpen,
  CheckCheck,
  ShieldCheck,
  TrendingUp,
  ArrowDownToLine,
  ArrowRight,
  Award,
  Bell,
  Bookmark,
  CreditCard,
  FileText,
  Folder,
  Gift,
  Globe,
  House,
  Inbox,
  Mailbox,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Search,
  Settings,
  ShoppingBag,
  SlidersHorizontal,
  Stamp,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { THEME_ICON_ARTWORK } from "../../lib/icon-artwork.js";
import { CENTRAL_OUTLINE_ARTWORK } from "../../lib/icon-artwork.js";
import { LUCIDE_FILLED_ARTWORK } from "../../lib/icon-artwork.js";
import {
  CENTRAL_CONTROL_OUTLINES,
  CENTRAL_CONTROL_FILLS,
  CENTRAL_CONTROL_STROKES,
  PHOSPHOR_CONTROL_ARTWORK,
  LUCIDE_CONTROL_FILLS,
} from "../../lib/icon-artwork.js";
import type { ThemeDefinition } from "../../lib/theme-model.js";
import {
  isHugeiconsVariant,
  type HugeiconsVariant,
} from "../../lib/hugeicons-options.js";
import { iconWeightVariables } from "../../lib/theme-icon-weight.js";

const lucide = {
  home: House,
  folder: Folder,
  team: UsersRound,
  settings: Settings,
  inboxTray: Inbox,
  shoppingBag: ShoppingBag,
  gift: Gift,
  creditCard: CreditCard,
  award: Award,
  pause: Pause,
  play: Play,
  bookmark: Bookmark,
  arrowRight: ArrowRight,
  archive: Archive,
  inbox: ArrowDownToLine,
  adjust: SlidersHorizontal,
  document: FileText,
  search: Search,
  paperclip: Paperclip,
  bell: Bell,
  trash: Trash2,
  stamp: Stamp,
  globe: Globe,
  pencil: Pencil,
  mailbox: Mailbox,
};
const controls = {
  panelLeft: PanelLeft,
  check: Check,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  minus: Minus,
  plus: Plus,
  close: X,
  info: Info,
  bold: Bold,
  italic: Italic,
  underline: Underline,
  copy: Copy,
  download: Download,
  filePlus: FilePlus,
  folderOpen: FolderOpen,
  printer: Printer,
  save: Save,
  undo: Undo2,
  redo: Redo2,
  arrowUp: ArrowUp,
  calendarPlus: CalendarPlus,
  calendarDays: CalendarDays,
  mapPin: MapPin,
  tag: Tag,
  package: Package,
  truck: Truck,
  listOrdered: ListOrdered,
  loader: LoaderCircle,
  timer: Timer,
  bookOpen: BookOpen,
  checkCheck: CheckCheck,
  shieldCheck: ShieldCheck,
  trendingUp: TrendingUp,
};
const allIcons = { ...lucide, ...controls };
const centralOutlines = {
  ...CENTRAL_OUTLINE_ARTWORK,
  ...CENTRAL_CONTROL_OUTLINES,
};
const centralFills = {
  ...THEME_ICON_ARTWORK.Central,
  ...CENTRAL_CONTROL_FILLS,
};
const phosphorArtwork = {
  ...THEME_ICON_ARTWORK.Phosphor,
  ...PHOSPHOR_CONTROL_ARTWORK,
};
const lucideFills: Record<string, { body: string; cutouts?: string }> = {
  ...LUCIDE_FILLED_ARTWORK,
  ...LUCIDE_CONTROL_FILLS,
};
export type ThemeIconName = keyof typeof allIcons;
export const THEME_ICON_NAMES = Object.keys(lucide) as ThemeIconName[];
export const CONTROL_ICON_NAMES = Object.keys(
  controls,
) as (keyof typeof controls)[];

type IconSettings = {
  family?: ThemeDefinition['iconFamily'];
  variant?: 'filled' | 'outlined';
  hugeiconsVariant?: HugeiconsVariant;
};
const IconThemeContext = createContext<IconSettings>({});

/** Reusable theme scope. React context carries the selected artwork through portals. */
export function IconTheme({
  variables,
  children,
}: {
  variables: CSSProperties;
  children: ReactNode;
}) {
  const inherited = useContext(IconThemeContext);
  const tokens = variables as Record<string, string | number | undefined>;
  const family = tokens['--theme-icon-family'];
  const variant = tokens['--theme-icon-style'];
  const hugeiconsVariant = tokens['--theme-hugeicons-variant'];
  return (
    <IconThemeContext
      value={{
        hugeiconsVariant: isHugeiconsVariant(hugeiconsVariant)
          ? hugeiconsVariant
          : inherited.hugeiconsVariant,
        family:
          family === 'Central' ||
          family === 'Phosphor' ||
          family === 'Lucide' ||
          family === 'Hugeicons'
            ? family
            : inherited.family,
        variant:
          variant === 'filled' || variant === 'outlined'
            ? variant
            : inherited.variant,
      }}
    >
      {children}
    </IconThemeContext>
  );
}

const IconNameContext = createContext<
  ((instance: string, name: ThemeIconName) => ThemeIconName) | null
>(null);

export type ThemeIconRenderProps = SVGProps<SVGSVGElement> & {
  name: ThemeIconName;
  family: NonNullable<ThemeDefinition['iconFamily']>;
  variant: 'filled' | 'outlined';
  weight?: number;
  hugeiconsVariant?: HugeiconsVariant;
};
const IconRendererContext = createContext<
  ((props: ThemeIconRenderProps) => ReactNode | undefined) | null
>(null);

/** Supply separately installed or licensed artwork without changing component source. */
export function IconRendererProvider({
  renderIcon,
  children,
}: {
  renderIcon: (props: ThemeIconRenderProps) => ReactNode | undefined;
  children: ReactNode;
}) {
  return (
    <IconRendererContext value={renderIcon}>{children}</IconRendererContext>
  );
}

/** Optional instance-level name resolution; ordinary icons need no provider. */
export function IconNameProvider({
  resolveName,
  children,
}: {
  resolveName: (instance: string, name: ThemeIconName) => ThemeIconName;
  children: ReactNode;
}) {
  return <IconNameContext value={resolveName}>{children}</IconNameContext>;
}

/** Decorative artwork; the containing control owns its accessible name. */
export function ThemedIcon({
  name: authoredName,
  family: explicitFamily,
  centralStyle,
  variant,
  weight,
  semantic = false,
  style,
  ...props
}: SVGProps<SVGSVGElement> & {
  name: ThemeIconName;
  family?: ThemeDefinition['iconFamily'];
  centralStyle?: 'filled' | 'outlined';
  variant?: 'filled' | 'outlined';
  weight?: number;
  /** Fixed control meaning; editor icon replacement applies only to decorative icons. */
  semantic?: boolean;
}) {
  const inherited = useContext(IconThemeContext);
  const renderIcon = useContext(IconRendererContext);
  const family = explicitFamily ?? inherited.family ?? 'Lucide';
  const instance = useId();
  const resolveName = useContext(IconNameContext);
  const name =
    (!semantic && resolveName?.(instance, authoredName)) || authoredName;
  const identity = {
    'data-icon-name': name,
    ...(!semantic && { 'data-icon-instance': instance }),
  };
  const Icon = allIcons[name];
  const resolvedStyle =
    variant ??
    centralStyle ??
    inherited.variant ??
    (family === 'Central' ? 'filled' : 'outlined');
  const iconStyle = {
    ...(weight !== undefined && iconWeightVariables(weight)),
    ...style,
  } as CSSProperties;
  const customIcon = renderIcon?.({
    'aria-hidden': true,
    ...props,
    ...identity,
    style: iconStyle,
    name,
    family,
    variant: resolvedStyle,
    hugeiconsVariant: inherited.hugeiconsVariant,
    weight,
  });
  if (customIcon !== undefined) return customIcon;
  const outlined = (
    <Icon
      aria-hidden="true"
      data-icon-family="Lucide"
      data-icon-style="outlined"
      data-icon-fallback={
        family !== 'Lucide' || resolvedStyle !== 'outlined' || undefined
      }
      strokeWidth="var(--icon-stroke-width, 2)"
      {...props}
      {...identity}
      style={iconStyle}
    />
  );
  // A receiving app supplies its own licensed renderer; never substitute Phosphor.
  if (family === 'Hugeicons') return outlined;
  if (family === 'Lucide')
    return resolvedStyle === 'filled' && lucideFills[name] ? (
      <FilledLucideIcon
        name={name}
        {...props}
        {...identity}
        style={iconStyle}
      />
    ) : (
      outlined
    );
  const centralOutline = family === 'Central' && resolvedStyle === 'outlined';
  const artwork = centralOutline
    ? centralOutlines[name]
    : family === 'Central'
      ? centralFills[name]
      : phosphorArtwork[name];
  if (!artwork) return outlined;
  const filledPhosphor = family === 'Phosphor' && resolvedStyle === 'filled';
  const controlStroke =
    family === 'Central' ? CENTRAL_CONTROL_STROKES[name] : undefined;
  // These strings are the static, bundled SVG catalog above, never user content.
  return (
    <svg
      width="24"
      height="24"
      viewBox={artwork.viewBox}
      fill={centralOutline ? 'none' : 'currentColor'}
      aria-hidden="true"
      data-icon-family={family}
      data-icon-style={resolvedStyle}
      {...props}
      {...identity}
      style={iconStyle}
    >
      {controlStroke ? (
        <path
          d={controlStroke}
          fill="none"
          stroke="currentColor"
          strokeWidth="var(--icon-stroke-width, 2)"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : filledPhosphor ? (
        <g
          dangerouslySetInnerHTML={{
            __html: artwork.filledBody,
          }}
        />
      ) : (
        <>
          {family === 'Phosphor' && (
            <g
              style={{ display: 'var(--theme-icon-thin-display, none)' }}
              dangerouslySetInnerHTML={{
                __html: artwork.thinBody,
              }}
            />
          )}
          <g
            style={{ display: 'var(--icon-light-display, none)' }}
            dangerouslySetInnerHTML={{ __html: artwork.lightBody }}
          />
          <g
            style={{ display: 'var(--icon-regular-display, inline)' }}
            dangerouslySetInnerHTML={{ __html: artwork.body }}
          />
          <g
            style={{ display: 'var(--icon-bold-display, none)' }}
            dangerouslySetInnerHTML={{ __html: artwork.boldBody }}
          />
        </>
      )}
    </svg>
  );
}

/** Filled Lucide adaptations retain transparent details instead of painting white. */
function FilledLucideIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & {
  name: ThemeIconName;
}) {
  const maskId = useId();
  const artwork = lucideFills[name];
  if (!artwork) return null;
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      data-icon-family="Lucide"
      data-icon-style="filled"
      {...props}
    >
      {artwork.cutouts && (
        <defs>
          <mask
            id={maskId}
            x="0"
            y="0"
            width="24"
            height="24"
            maskUnits="userSpaceOnUse"
            style={{ maskType: 'luminance' }}
          >
            <rect width="24" height="24" fill="white" />
            <g
              fill="black"
              style={{ color: 'black' }}
              dangerouslySetInnerHTML={{ __html: artwork.cutouts }}
            />
          </mask>
        </defs>
      )}
      <g
        mask={artwork.cutouts ? `url(#${maskId})` : undefined}
        dangerouslySetInnerHTML={{ __html: artwork.body }}
      />
    </svg>
  );
}
