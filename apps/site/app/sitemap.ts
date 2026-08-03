import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/site";
import { source } from "@/lib/source";

const staticRoutes = [
  { path: "/", priority: 1, changeFrequency: "weekly" as const },
  { path: "/docs", priority: 0.9, changeFrequency: "weekly" as const },
  { path: "/reference", priority: 0.8, changeFrequency: "weekly" as const },
  { path: "/integrations", priority: 0.7, changeFrequency: "monthly" as const },
  { path: "/examples", priority: 0.7, changeFrequency: "monthly" as const },
  { path: "/demo", priority: 0.6, changeFrequency: "monthly" as const },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteConfig.url.replace(/\/$/, "");
  const lastModified = new Date();

  const staticEntries = staticRoutes.map((route) => ({
    url: `${base}${route.path}`,
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));

  // Docs pages come from the same loader the routes render, so a new MDX file
  // is indexed without a second registration step.
  const docEntries = source.getPages().map((page) => ({
    url: `${base}${page.url}`,
    lastModified,
    changeFrequency: "weekly" as const,
    priority: 0.6,
  }));

  const seen = new Set(staticEntries.map((entry) => entry.url));
  return [...staticEntries, ...docEntries.filter((entry) => !seen.has(entry.url))];
}
