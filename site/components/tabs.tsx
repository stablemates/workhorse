import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { useState, type ComponentPropsWithRef, type ReactNode } from "react";

/*
 * The tabs of the marketing pages, on the Base UI tab parts.
 *
 * Every color comes from a site stylesheet rule (`.wh-tabset` in
 * `src/styles/marketing.css`) that reads the `dark` class on the root
 * element. Fumadocs sets that class before the first paint, so the
 * prerendered tabs draw in the right scheme at once, and hydration changes
 * no color.
 *
 * The indicator slides to the selected tab. Base UI positions it only after
 * hydration, so until then the selected tab draws the same surface itself.
 * When a reader selects a tab, the root takes `data-changed`, and the panel
 * that opens fades in. A panel does not fade on the first paint.
 *
 * A code group adds the `wh-tabs` and `wh-tab-panel` classes, which
 * `scripts/gen-landing-twin.ts` reads to find code in the page.
 */

type RootProps = Omit<
  ComponentPropsWithRef<typeof BaseTabs.Root>,
  "className" | "value" | "defaultValue" | "onValueChange" | "children"
> & {
  /**
   * `pill`: a row of labels with a sliding fill. `segmented`: the same on a
   * track. `cards`: the pillar row of the landing page.
   */
  variant: "pill" | "segmented" | "cards";
  className?: string;
  children: (selected: number) => ReactNode;
};

/** A tab group with a numeric value. `children` gets the selected index. */
function Root({ variant, className, children, ...props }: RootProps) {
  const [selected, setSelected] = useState(0);
  const [changed, setChanged] = useState(false);
  return (
    <BaseTabs.Root
      {...props}
      value={selected}
      onValueChange={(value: number) => {
        setSelected(value);
        setChanged(true);
      }}
      data-variant={variant}
      data-changed={changed || undefined}
      className={["wh-tabset", className].filter(Boolean).join(" ")}
    >
      {children(selected)}
    </BaseTabs.Root>
  );
}

function List({
  className,
  children,
  ...props
}: Omit<ComponentPropsWithRef<typeof BaseTabs.List>, "className"> & { className?: string }) {
  return (
    <BaseTabs.List
      activateOnFocus
      {...props}
      className={["wh-tabset-list", className].filter(Boolean).join(" ")}
    >
      {children}
      <BaseTabs.Indicator className="wh-tabset-indicator" />
    </BaseTabs.List>
  );
}

function Tab({
  className,
  ...props
}: Omit<ComponentPropsWithRef<typeof BaseTabs.Tab>, "className"> & { className?: string }) {
  return (
    <BaseTabs.Tab {...props} className={["wh-tabset-tab", className].filter(Boolean).join(" ")} />
  );
}

function Panel({
  className,
  ...props
}: Omit<ComponentPropsWithRef<typeof BaseTabs.Panel>, "className"> & { className?: string }) {
  return (
    <BaseTabs.Panel
      {...props}
      className={["wh-tabset-panel", className].filter(Boolean).join(" ")}
    />
  );
}

export const Tabs = { Root, List, Tab, Panel };
