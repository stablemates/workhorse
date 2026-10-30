'use client';

import {
  useEffect,
  useSyncExternalStore,
  type ReactNode,
  type SVGProps,
} from 'react';
import { HUGEICONS_NAMES } from "../../lib/hugeicons-names.js";
import {
  HUGEICONS_VARIANTS,
  hugeiconsHasStroke,
  hugeiconsIconStyle,
  hugeiconsVariantFor,
  type HugeiconsVariant,
} from "../../lib/hugeicons-options.js";
import type { ThemeIconRenderProps } from "./icon.js";

/** Matches the vendor's SVG data without importing or distributing its artwork. */
export type HugeiconsGlyph = readonly (readonly [
  string,
  Readonly<Record<string, string | number>>,
])[];
type Variant = HugeiconsVariant;
type Catalog = Record<string, HugeiconsGlyph>;
type LoadCatalog = (variant: Variant) => Promise<Catalog>;
type RenderGlyph = (
  icon: HugeiconsGlyph,
  props: SVGProps<SVGSVGElement>,
) => ReactNode;
type CatalogState = { catalog?: Catalog; failed?: boolean };
type CatalogStore = {
  read: (variant: Variant) => CatalogState | undefined;
  subscribe: (listener: () => void) => () => void;
};
const emptyServerSnapshot = () => undefined;

function LicensedIcon({
  load,
  store,
  renderGlyph,
  name,
  variant: iconStyle,
  hugeiconsVariant,
  family: _family,
  weight: _weight,
  ...props
}: ThemeIconRenderProps & {
  load: LoadCatalog;
  store: CatalogStore;
  renderGlyph: RenderGlyph;
}) {
  const selected =
    hugeiconsVariant ??
    (iconStyle === 'filled' ? 'solid-standard' : 'stroke-standard');
  const variant =
    hugeiconsIconStyle(selected) === iconStyle
      ? selected
      : hugeiconsVariantFor(
          HUGEICONS_VARIANTS[selected].geometry,
          iconStyle === 'filled' ? 'solid' : 'stroke',
        );
  const current = useSyncExternalStore(
    store.subscribe,
    () => store.read(variant),
    emptyServerSnapshot,
  );
  useEffect(() => {
    // Remounting an icon or switching style can retry a failed catalog.
    void load(variant).catch(() => {});
  }, [load, variant]);
  const glyphName = HUGEICONS_NAMES[name];
  const glyph = current?.catalog?.[glyphName];
  const identity = {
    'data-icon-family': 'Hugeicons',
    'data-icon-style': iconStyle,
    'data-hugeicons-variant': variant,
  };
  if (!glyph) {
    const unavailable = current?.failed || !!current?.catalog;
    return (
      <svg
        width={24}
        height={24}
        {...props}
        {...identity}
        data-icon-loading={!unavailable || undefined}
        data-icon-unavailable={unavailable || undefined}
      >
        <title>
          {unavailable
            ? 'Hugeicons icon unavailable'
            : 'Loading Hugeicons icon'}
        </title>
      </svg>
    );
  }
  return renderGlyph(glyph, {
    width: 24,
    height: 24,
    ...props,
    ...identity,
    style: {
      ...(hugeiconsHasStroke(variant) && {
        strokeWidth: 'var(--icon-stroke-width, 2)',
      }),
      ...props.style,
    },
  });
}

/** Connect the app's own installed Hugeicons packages to the editor. */
export function createHugeiconsRenderer({
  loadCatalog,
  renderGlyph,
}: {
  loadCatalog: LoadCatalog;
  renderGlyph: RenderGlyph;
}) {
  const requests: Partial<Record<Variant, Promise<Catalog>>> = {};
  const states: Partial<Record<Variant, CatalogState>> = {};
  const listeners = new Set<() => void>();
  const publish = (variant: Variant, state: CatalogState) => {
    states[variant] = state;
    listeners.forEach((listener) => listener());
  };
  const store: CatalogStore = {
    read: (variant) => states[variant],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const load: LoadCatalog = (variant) =>
    (requests[variant] ??= loadCatalog(variant)
      .then((catalog) => {
        const entries = Object.entries(catalog).filter(
          ([name, glyph]) => name.endsWith('Icon') && Array.isArray(glyph),
        );
        if (!entries.length) throw new Error('The Hugeicons catalog is empty');
        const normalized = Object.fromEntries(
          entries.map(([name, glyph]) => [
            name,
            // Let theme and per-element CSS control stroke width through the SVG.
            hugeiconsHasStroke(variant)
              ? glyph.map(([tag, attributes]) => {
                  const { strokeWidth: _strokeWidth, ...rest } = attributes;
                  return [tag, rest] as const;
                })
              : glyph,
          ]),
        );
        publish(variant, { catalog: normalized });
        return normalized;
      })
      .catch((error: unknown) => {
        delete requests[variant];
        publish(variant, { failed: true });
        throw error;
      }));
  return {
    renderIcon: (props: ThemeIconRenderProps) => {
      if (props.family !== 'Hugeicons') return undefined;
      return (
        <LicensedIcon
          {...props}
          load={load}
          store={store}
          renderGlyph={renderGlyph}
        />
      );
    },
  };
}
