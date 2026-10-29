'use client';

import type { SVGProps } from 'react';
import { ThemedIcon, type ThemeIconName } from "./icon.js";

type GlyphProps = Omit<SVGProps<SVGSVGElement>, 'name'> & {
  size?: number | string;
};
function glyph(name: ThemeIconName) {
  function ControlIcon({ size = 24, ...props }: GlyphProps) {
    return (
      <ThemedIcon name={name} semantic width={size} height={size} {...props} />
    );
  }
  ControlIcon.displayName = `ThemedGlyph(${name})`;
  return ControlIcon;
}

export const Check = glyph('check');
export const ChevronDown = glyph('chevronDown');
export const ChevronLeft = glyph('chevronLeft');
export const ChevronRight = glyph('chevronRight');
export const Minus = glyph('minus');
export const Plus = glyph('plus');
export const X = glyph('close');
export const Info = glyph('info');
export const Bold = glyph('bold');
export const Italic = glyph('italic');
export const Underline = glyph('underline');
export const Copy = glyph('copy');
export const Download = glyph('download');
export const FilePlus = glyph('filePlus');
export const FolderOpen = glyph('folderOpen');
export const Printer = glyph('printer');
export const Save = glyph('save');
export const Undo2 = glyph('undo');
export const Redo2 = glyph('redo');
export const ArrowUp = glyph('arrowUp');
export const CalendarPlus = glyph('calendarPlus');
export const CalendarDays = glyph('calendarDays');
export const MapPin = glyph('mapPin');
export const Tag = glyph('tag');
export const Package = glyph('package');
export const Truck = glyph('truck');
export const ListOrdered = glyph('listOrdered');
export const LoaderCircle = glyph('loader');
export const Timer = glyph('timer');
export const BookOpen = glyph('bookOpen');
export const CheckCheck = glyph('checkCheck');
export const ShieldCheck = glyph('shieldCheck');
export const TrendingUp = glyph('trendingUp');
export const ArrowRight = glyph('arrowRight');
export const CreditCard = glyph('creditCard');
export const FileText = glyph('document');
export const Pencil = glyph('pencil');
export const ShoppingBag = glyph('shoppingBag');
export const Trash2 = glyph('trash');
export const PanelLeft = glyph('panelLeft');
