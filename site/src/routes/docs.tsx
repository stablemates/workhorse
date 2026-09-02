import {
  Book02Icon,
  Database01Icon,
  GaugeIcon,
  PackageAddIcon,
  PlayCircleIcon,
  PlugSocketIcon,
  Rocket01Icon,
  ShieldEnergyIcon,
  SourceCodeIcon,
  TrafficLightIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { WORKHORSE_VERSION } from "@stablemates/workhorse/version";
import type { Node, Root } from "fumadocs-core/page-tree";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";

import docsIndex from "@/.source/docs-index.json";
import { baseOptions } from "@/app/layout.config";
import { integrations, type IntegrationLogo } from "@/lib/integrations";

/**
 * Built by `scripts/gen-docs-index.ts`. Reading it as plain JSON keeps the
 * Fumadocs loader, and the Node filesystem it needs, out of the browser bundle.
 *
 * JSON cannot carry a React element, so a node's `icon` arrives as the name of a
 * file in `public/brand/integrations`. This hydrates those names into images
 * once, at module load.
 */
interface SerializedNode {
  readonly type: string;
  readonly name: string;
  readonly url?: string;
  readonly icon?: string;
  readonly defaultOpen?: boolean;
  readonly children?: readonly SerializedNode[];
}

/**
 * Group icons. Free Hugeicons, because this repository becomes public and the
 * Pro set is licensed.
 *
 * Each glyph has to say what the group does, and no two may repeat. A traffic
 * light for admission control, a shield for surviving a crash, and a gauge for
 * watching production each carry their meaning without a label.
 */
const groupIcons = {
  rocket: Rocket01Icon,
  inbox: PackageAddIcon,
  filter: TrafficLightIcon,
  play: PlayCircleIcon,
  workflow: ShieldEnergyIcon,
  activity: GaugeIcon,
  plug: PlugSocketIcon,
  database: Database01Icon,
  book: Book02Icon,
  code: SourceCodeIcon,
} as const;

function isGroupIcon(name: string): name is keyof typeof groupIcons {
  return name in groupIcons;
}

/**
 * Brand marks, one pair per integration, keyed by the slug the generator writes
 * into the tree and read from `site/integrations.json` so a mark is declared
 * with the rest of its integration.
 *
 * Each theme gets the variant drawn for it, and the pair is swapped with CSS so
 * the switch costs no JavaScript and cannot flash.
 */
const logos = new Map(
  integrations
    .filter((entry) => entry.logo)
    .map((entry) => [entry.slug, entry.logo as IntegrationLogo]),
);

function logo(pair: IntegrationLogo, label: string): ReactNode {
  const { light, dark } = pair;

  return (
    <span className="contents" title={label}>
      <img
        src={`/brand/integrations/${light}.svg`}
        alt=""
        aria-hidden
        width={16}
        height={16}
        className="size-4 shrink-0 object-contain dark:hidden"
      />
      <img
        src={`/brand/integrations/${dark}.svg`}
        alt=""
        aria-hidden
        width={16}
        height={16}
        className="hidden size-4 shrink-0 object-contain dark:block"
      />
    </span>
  );
}

function icon(name: string, label: string): ReactNode {
  if (isGroupIcon(name)) {
    return <HugeiconsIcon icon={groupIcons[name]} size={16} strokeWidth={1.8} aria-hidden />;
  }

  const pair = logos.get(name);
  return pair ? logo(pair, label) : null;
}

function hydrate(node: SerializedNode): Node {
  return {
    ...node,
    ...(node.icon ? { icon: icon(node.icon, node.name) } : {}),
    ...(node.children ? { children: node.children.map(hydrate) } : {}),
  } as Node;
}

const tree: Root = {
  ...docsIndex.tree,
  children: (docsIndex.tree.children as SerializedNode[]).map(hydrate),
} as Root;

export const Route = createFileRoute("/docs")({
  component: DocsRootLayout,
});

function DocsRootLayout() {
  return (
    /* wh-page-scale: on wide monitors the docs render at the density of
       ~150% browser zoom — see the media rules in global.css. */
    <div className="wh-page-scale flex flex-1 flex-col">
      <DocsLayout
        {...baseOptions}
        tree={tree}
        sidebar={{
          defaultOpenLevel: 0,
          banner: (
            <p
              className="wh-rule mx-2 mb-2 border-b pb-3 font-mono text-[11px] text-fd-muted-foreground"
              aria-label={`Workhorse version ${WORKHORSE_VERSION}`}
            >
              Workhorse v{WORKHORSE_VERSION}
            </p>
          ),
        }}
      >
        <Outlet />
      </DocsLayout>
    </div>
  );
}
