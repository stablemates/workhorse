import { Outlet, createFileRoute } from "@tanstack/react-router";
import type { Node, Root } from "fumadocs-core/page-tree";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";

import docsIndex from "@/.source/docs-index.json";
import { baseOptions } from "@/app/layout.config";

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

function logo(name: string, label: string): ReactNode {
  return (
    <img
      src={`/brand/integrations/${name}.svg`}
      alt=""
      aria-hidden
      width={16}
      height={16}
      className="size-4 shrink-0 object-contain"
      title={label}
    />
  );
}

function hydrate(node: SerializedNode): Node {
  return {
    ...node,
    ...(node.icon ? { icon: logo(node.icon, node.name) } : {}),
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
    <DocsLayout {...baseOptions} tree={tree} sidebar={{ defaultOpenLevel: 0 }}>
      <Outlet />
    </DocsLayout>
  );
}
