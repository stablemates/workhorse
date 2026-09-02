/**
 * Turns an MDX page body into the Markdown an agent reads at `/docs/<slug>.md`.
 *
 * A docs page shows its three languages in a `<Tabs>` component, so the HTML
 * hides two of them behind a control an agent cannot click. Copying the body
 * into the twin unchanged hands the agent the raw `<Tabs>` and `<Tab>` tags
 * instead, which its tooling reads as markup it has to strip. This transform
 * expands every tab inline under a bold language label, so the twin carries all
 * three languages as ordinary Markdown.
 *
 * Expansion costs no size. The twin already carried every language; only the
 * HTML hid two of them.
 *
 * A tab body is indented to sit under its tag, so the transform removes that
 * indentation. A fenced block indented by four spaces is an indented code block
 * wrapped in a fence, and a reader counting backticks sees the wrong thing.
 *
 * The transform knows `Tabs` and `Tab` and nothing else. Any other MDX
 * component throws, naming the component and the page, because a silent pass
 * through would put a bare JSX tag in front of an agent.
 */

/** MDX components this transform can expand. Anything else is a build failure. */
const knownComponents: ReadonlySet<string> = new Set(["Tabs", "Tab"]);

const fenceEdge = /^\s*(?:```|~~~)/;
const tabsOpen = /^\s*<Tabs\b([^>]*)>\s*$/;
const tabsClose = /^\s*<\/Tabs>\s*$/;
const tabOpen = /^\s*<Tab\b([^>]*)>\s*$/;
const tabClose = /^\s*<\/Tab>\s*$/;
const itemsAttribute = /items=\{\[(.*?)]}/;
const valueAttribute = /value="([^"]*)"/;
const inlineCode = /`[^`]*`/g;
const componentTag = /<\/?([A-Z][A-Za-z0-9]*)/g;

interface OpenTab {
  readonly label: string;
  readonly lines: string[];
}

/**
 * Removes the shared indentation of a tab body and drops its blank edges, so a
 * fenced block that sat under `<Tab>` starts at the left margin.
 */
function dedent(lines: readonly string[]): string[] {
  const filled = lines.filter((line) => line.trim() !== "");
  if (filled.length === 0) return [];
  const indent = Math.min(...filled.map((line) => line.length - line.trimStart().length));
  const flush = lines.map((line) => (line.trim() === "" ? "" : line.slice(indent)));
  while (flush.length > 0 && flush[0] === "") flush.shift();
  while (flush.length > 0 && flush.at(-1) === "") flush.pop();
  return flush;
}

/** Reads the labels out of `items={["TypeScript", "Python", "Go"]}`. */
function tabsItems(attributes: string): string[] {
  const items = itemsAttribute.exec(attributes);
  if (!items?.[1]) return [];
  return [...items[1].matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
}

function unknownComponent(line: string, page: string): void {
  for (const match of line.replace(inlineCode, "").matchAll(componentTag)) {
    const tag = match[1] ?? "";
    if (knownComponents.has(tag)) continue;
    throw new Error(
      `The docs page "${page}" uses the MDX component <${tag}>, which the Markdown twin ` +
        "transform does not know. Teach site/scripts/mdx-to-markdown.ts how to expand it.",
    );
  }
}

/**
 * Expands `body`, an MDX page with its frontmatter already removed, into
 * Markdown. Throws on any MDX component other than `Tabs` and `Tab`, naming the
 * component and `page`.
 */
export function mdxToMarkdown(body: string, page: string): string {
  const output: string[] = [];
  let items: string[] = [];
  let itemIndex = 0;
  let expanded: string[] | undefined;
  let tab: OpenTab | undefined;
  let inFence = false;
  // A `</Tabs>` line already ends its block with a blank line, so the blank line
  // that followed the tag in the source would double it.
  let skipBlankLine = false;

  const sink = (): string[] => tab?.lines ?? output;

  const closeTab = (): void => {
    if (!tab || !expanded) return;
    expanded.push(`**${tab.label}**`, "", ...dedent(tab.lines), "");
    tab = undefined;
  };

  for (const line of body.split("\n")) {
    if (skipBlankLine) {
      skipBlankLine = false;
      if (line.trim() === "") continue;
    }

    if (fenceEdge.test(line)) {
      inFence = !inFence;
      sink().push(line);
      continue;
    }
    if (inFence) {
      sink().push(line);
      continue;
    }

    const opensTabs = tabsOpen.exec(line);
    if (opensTabs) {
      if (expanded) throw new Error(`The docs page "${page}" nests <Tabs> inside <Tabs>`);
      items = tabsItems(opensTabs[1] ?? "");
      itemIndex = 0;
      expanded = [];
      continue;
    }

    if (tabsClose.test(line)) {
      if (!expanded) throw new Error(`The docs page "${page}" closes a <Tabs> it never opened`);
      closeTab();
      while (expanded.at(-1) === "") expanded.pop();
      output.push(...expanded, "");
      expanded = undefined;
      skipBlankLine = true;
      continue;
    }

    const opensTab = tabOpen.exec(line);
    if (opensTab) {
      if (!expanded) throw new Error(`The docs page "${page}" opens a <Tab> outside <Tabs>`);
      closeTab();
      const attributes = opensTab[1] ?? "";
      const label = valueAttribute.exec(attributes)?.[1] ?? items[itemIndex];
      itemIndex += 1;
      if (!label) {
        throw new Error(`The docs page "${page}" has a <Tab> with no value and no items entry`);
      }
      tab = { label, lines: [] };
      continue;
    }

    if (tabClose.test(line)) {
      if (!tab) throw new Error(`The docs page "${page}" closes a <Tab> it never opened`);
      closeTab();
      continue;
    }

    unknownComponent(line, page);
    sink().push(line);
  }

  if (expanded) throw new Error(`The docs page "${page}" leaves a <Tabs> unclosed`);
  if (inFence) throw new Error(`The docs page "${page}" leaves a code fence unclosed`);

  return output.join("\n");
}
