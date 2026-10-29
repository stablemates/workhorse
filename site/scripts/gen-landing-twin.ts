/**
 * Writes `/index.md` and `/features.md`, the Markdown twins of the landing page
 * and the feature tour.
 *
 * Every documentation page has a twin an agent can read instead of the HTML,
 * and `llms.txt` tells an agent to append `.md` to any page URL. The landing
 * page is the page an agent is most likely to reach first: `llms.txt` is linked
 * from the footer, so an agent that starts at the front door must read the
 * whole page to find the pointer. That page is about 346 KB of markup around
 * 49 KB of text. The feature tour has the same shape.
 *
 * The twin is derived from the built page rather than written beside it. A
 * second copy of the landing copy would drift from the route within a release,
 * and no test can catch a paragraph that merely went stale. Deriving it means
 * the twin says what the page says, by construction.
 *
 * It therefore runs after `vite build` and writes into the build output.
 */
import { readFile, writeFile } from "node:fs/promises";

import { type DefaultTreeAdapterTypes, parse } from "parse5";

import { siteConfig } from "../lib/site.js";

// parse5 exports its default tree's node types through this namespace; the
// module path they live at is not a public subpath export.
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type TextNode = DefaultTreeAdapterTypes.TextNode;

/** Elements whose content is navigation or decoration rather than the page's argument. */
const skipped = new Set(["nav", "footer", "header", "script", "style", "noscript", "svg", "input"]);

/** Skipped tags, and anything the page itself hides from assistive technology. */
function isSkipped(element: Element): boolean {
  return skipped.has(element.tagName) || attribute(element, "aria-hidden") === "true";
}

function isElement(node: ChildNode): node is Element {
  return "tagName" in node;
}

function isText(node: ChildNode): node is TextNode {
  return node.nodeName === "#text";
}

function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find((attr) => attr.name === name)?.value;
}

function classesOf(node: Element): string[] {
  return (attribute(node, "class") ?? "").split(/\s+/);
}

function childrenOf(node: ParentNode): ChildNode[] {
  return node.childNodes ?? [];
}

/** Every descendant matching a test, in document order. */
function descendants(node: ParentNode, test: (element: Element) => boolean): Element[] {
  const found: Element[] = [];
  for (const child of childrenOf(node)) {
    if (!isElement(child)) continue;
    if (test(child)) found.push(child);
    found.push(...descendants(child, test));
  }
  return found;
}

/** The visible text of a subtree, with runs of whitespace collapsed. */
function textOf(node: ParentNode): string {
  let text = "";
  for (const child of childrenOf(node)) {
    if (isText(child)) text += child.value;
    else if (isElement(child) && !isSkipped(child)) text += textOf(child);
  }
  return text;
}

/**
 * Inline Markdown for a subtree: links and inline code survive, everything else
 * becomes its text. The pages use no other inline mark.
 */
function inline(node: ParentNode): string {
  let out = "";
  let previousIsElement = false;
  for (const child of childrenOf(node)) {
    if (isText(child)) {
      out += child.value;
      previousIsElement = false;
      continue;
    }
    if (!isElement(child) || isSkipped(child)) continue;
    // Two elements side by side, such as a package name and its description,
    // are separate words on the page because of their layout.
    if (previousIsElement && !/\s$/.test(out)) out += " ";
    previousIsElement = true;
    if (child.tagName === "code") {
      out += `\`${textOf(child).trim()}\``;
    } else if (child.tagName === "a") {
      const href = attribute(child, "href") ?? "";
      const label = inline(child)
        .trim()
        .replace(/\s*→$/, "");
      // A bare fragment or an empty label is a control, not a reference.
      out += label === "" ? "" : href === "" ? label : `[${label}](${absolute(href)})`;
    } else if (child.tagName === "br") {
      out += " ";
    } else {
      out += inline(child);
    }
  }
  return out;
}

/** A site-relative href, made absolute so the twin stands on its own. */
function absolute(href: string): string {
  return href.startsWith("/") ? `${siteConfig.url}${href}` : href;
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The language tabs render every language into the page and show one. The twin
 * expands all of them under a bold label, the way a documentation twin does.
 */
function tabs(node: Element): string[] {
  const tabElements = descendants(node, (element) => attribute(element, "role") === "tab").filter(
    (element) => tidy(textOf(element)) !== "",
  );
  const labels = tabElements.map((element) => tidy(textOf(element)));
  // A tab names the language of its code in `data-language`, because its label
  // is a display name such as "C#" or an integration such as "Prisma".
  const languages = tabElements.map(
    (element) => attribute(element, "data-language") ?? tidy(textOf(element)),
  );
  const panels = descendants(node, (element) => classesOf(element).includes("wh-tab-panel"));
  if (panels.length === 0) {
    return descendants(node, (element) => element.tagName === "pre").map((block) =>
      fence(block, ""),
    );
  }
  // A panel's caption explains the sample. Every language panel repeats the
  // same one, and the page shows a single panel at a time, so a caption shared
  // by all of them is stated once after the set rather than three times inside.
  const captions = panels.map((panel) => {
    const note = descendants(panel, (element) => element.tagName === "figcaption").find(
      (element) => !descendants(element, (inner) => inner.tagName === "span").some(isFileName),
    );
    return note ? tidy(inline(note)) : "";
  });
  const shared = captions.every((caption) => caption === captions[0]) ? captions[0] : undefined;

  const out: string[] = [];
  panels.forEach((panel, index) => {
    const [block] = descendants(panel, (element) => element.tagName === "pre");
    if (!block) return;
    const label = labels[index] ?? "";
    const language = languages[index] ?? "";
    // The panel names the file the snippet belongs in, which is the one thing
    // an agent needs that the code itself does not say.
    const file = descendants(panel, (element) => element.tagName === "span")
      .map((element) => tidy(textOf(element)))
      .find((text) => /^[\w.-]+\.\w+$/.test(text));
    const heading = [label && `**${label}**`, file && `\`${file}\``].filter(Boolean).join(" — ");
    const caption = shared === undefined ? captions[index] : "";
    if (heading !== "") out.push(heading);
    out.push(fence(block, language));
    if (caption) out.push(caption);
  });

  return shared ? [...out, shared] : out;
}

/** A span holding a file name, which is how a panel labels its snippet. */
function isFileName(element: Element): boolean {
  return /^[\w.-]+\.\w+$/.test(tidy(textOf(element)));
}

/** Whether a subtree holds anything `blocks` would emit on its own. */
function hasBlock(node: ParentNode): boolean {
  for (const child of childrenOf(node)) {
    if (!isElement(child) || isSkipped(child)) continue;
    if (/^h[1-6]$/.test(child.tagName)) return true;
    if (["p", "li", "pre"].includes(child.tagName)) return true;
    if (child.tagName === "code" && classesOf(child).includes("block")) return true;
    if (classesOf(child).includes("wh-tabs")) return true;
    if (hasBlock(child)) return true;
  }
  return false;
}

function fence(node: Element, language: string): string {
  // Shiki wraps each line in its own element, so the text carries the newlines.
  const code = textOf(node).replace(/\n+$/, "");
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

/**
 * Walks a subtree into Markdown blocks.
 *
 * Prose reaches the page in three shapes: inside a `p`, inside a container that
 * holds nothing else, and as bare text beside a figure, because a section's
 * note is a JSX fragment with no element of its own. All three have to survive,
 * so text is accumulated until something block-level ends the run.
 */
function blocks(node: ParentNode, out: string[]): void {
  let pending = "";

  function flush(): void {
    const text = tidy(pending);
    pending = "";
    if (text !== "") out.push(text);
  }

  for (const child of childrenOf(node)) {
    if (isText(child)) {
      pending += child.value;
      continue;
    }
    if (!isElement(child) || isSkipped(child)) continue;

    if (/^h[1-6]$/.test(child.tagName)) {
      flush();
      const text = tidy(inline(child));
      if (text !== "") out.push(`${"#".repeat(Number(child.tagName[1]))} ${text}`);
      continue;
    }
    if (child.tagName === "p") {
      flush();
      const text = tidy(inline(child));
      if (text !== "") out.push(text);
      continue;
    }
    // A feature of the tour is an item with a heading and paragraphs.
    if (
      child.tagName === "li" &&
      descendants(child, (element) => /^h[1-6]$/.test(element.tagName)).length > 0
    ) {
      flush();
      blocks(child, out);
      continue;
    }
    if (child.tagName === "li") {
      flush();
      const text = tidy(inline(child));
      if (text !== "") out.push(`- ${text}`);
      continue;
    }
    if (child.tagName === "pre") {
      flush();
      out.push(fence(child, ""));
      continue;
    }
    // The install commands are a block-level `code` rather than a `pre`, and
    // they are the one thing on this page an agent must copy exactly.
    if (child.tagName === "code" && classesOf(child).includes("block")) {
      flush();
      out.push(fence(child, "sh"));
      continue;
    }
    if (classesOf(child).includes("wh-tabs")) {
      flush();
      out.push(...tabs(child));
      continue;
    }
    // A container with nothing block-level in it is part of the run of text,
    // whether it is an inline mark or a `div` holding only a badge and a link.
    if (!hasBlock(child)) {
      pending += inline(child);
      continue;
    }
    flush();
    blocks(child, out);
  }

  flush();
}

/** A route that `src/routes` renders without a Markdown source of its own. */
interface DerivedTwin {
  /** The name of the page in messages. */
  name: string;
  /** The built HTML page, relative to `dist/client`. */
  page: string;
  /** The twin, relative to `dist/client`. */
  twin: string;
  /** The title of the twin. `undefined` uses the `<title>` of the built page. */
  title?: string;
  /** The description of the twin. `undefined` uses the meta description of the built page. */
  description?: string;
  canonical: string;
}

const derivedTwins: readonly DerivedTwin[] = [
  {
    name: "landing page",
    page: "index.html",
    twin: "index.md",
    title: `${siteConfig.name}: ${siteConfig.tagline}`,
    description: siteConfig.description,
    canonical: siteConfig.url,
  },
  {
    name: "feature tour",
    page: "features/index.html",
    twin: "features.md",
    canonical: `${siteConfig.url}/features`,
  },
];

/** The content of the one `<meta name="…">` in the head of a built page. */
function metaContent(document: ParentNode, name: string): string | undefined {
  const [meta] = descendants(
    document,
    (element) => element.tagName === "meta" && attribute(element, "name") === name,
  );
  return meta ? attribute(meta, "content") : undefined;
}

function pageTitle(document: ParentNode): string | undefined {
  const [title] = descendants(document, (element) => element.tagName === "title");
  return title ? tidy(textOf(title)) : undefined;
}

for (const derived of derivedTwins) {
  const document = parse(
    await readFile(new URL(`../dist/client/${derived.page}`, import.meta.url), "utf8"),
  );
  const [main] = descendants(document, (element) => element.tagName === "main");
  if (!main) throw new Error(`The built ${derived.name} has no <main>; the twin cannot be derived`);

  const body: string[] = [];
  blocks(main, body);

  // A run of identical paragraphs means a carousel rendered every slide. The page
  // shows one at a time and the twin should read that way too.
  const deduplicated = body.filter((block, index) => block !== body[index - 1]);

  const title = derived.title ?? pageTitle(document);
  const description = derived.description ?? metaContent(document, "description");
  if (title === undefined || description === undefined) {
    throw new Error(`The built ${derived.name} has no title or description for its twin`);
  }
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `canonical: ${JSON.stringify(derived.canonical)}`,
    "---",
  ].join("\n");

  const markdown = `${frontmatter}\n\n${deduplicated.join("\n\n")}\n`;
  await writeFile(new URL(`../dist/client/${derived.twin}`, import.meta.url), markdown);

  process.stdout.write(
    `Wrote the ${derived.name} twin: ${deduplicated.length} blocks, ${Buffer.byteLength(markdown)} bytes\n`,
  );
}
