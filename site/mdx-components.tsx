import { Card, Cards } from "fumadocs-ui/components/card";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { Diagram } from "@/components/diagram";

/**
 * MDX component map of the blog posts and the site pages. The documentation
 * pages render with Blume, whose components are in `site/blume/components.ts`.
 * Keep additions server-safe: anything interactive must opt into "use client"
 * inside its own module so docs pages stay server-rendered.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Card,
    Cards,
    Diagram,
    Step,
    Steps,
    Tab,
    Tabs,
    TypeTable,
    ...components,
  };
}
