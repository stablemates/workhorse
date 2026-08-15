import { Card, Cards } from "fumadocs-ui/components/card";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

/**
 * MDX component map shared by every MDX surface on the site.
 * Keep additions server-safe: anything interactive must opt into "use client"
 * inside its own module so docs pages stay server-rendered.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Card,
    Cards,
    Step,
    Steps,
    Tab,
    Tabs,
    TypeTable,
    ...components,
  };
}

export const mdxComponents = getMDXComponents();
