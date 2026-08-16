import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";

import { baseOptions } from "@/app/layout.config";
import { source } from "@/lib/source";

export const Route = createFileRoute("/docs")({
  // The page tree crosses the loader boundary, so it must be serialized.
  loader: async () => ({ tree: await source.serializePageTree(source.pageTree) }),
  component: DocsRootLayout,
});

function DocsRootLayout() {
  const { tree } = useFumadocsLoader(Route.useLoaderData());

  return (
    <DocsLayout {...baseOptions} tree={tree} sidebar={{ defaultOpenLevel: 1 }}>
      <Outlet />
    </DocsLayout>
  );
}
