/**
 * Writes `/index.md`, the landing page's Markdown twin.
 *
 * Every documentation page has a twin an agent can read instead of the HTML.
 * The landing page had none, and it is the page an agent is most likely to
 * reach first: `llms.txt` is linked from the footer, so an agent that starts at
 * the front door must read the whole page to find the pointer. That page is
 * about 346 KB of markup around 49 KB of text.
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

const builtPage = new URL("../dist/client/index.html", import.meta.url);
const twin = new URL("../dist/client/index.md", import.meta.url);

/** Elements whose content is navigation or decoration rather than the page's argument. */
const skipped = new Set(["nav", "footer", "header", "script", "style", "noscript", "svg", "input"]);

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
    else if (isElement(child) && !skipped.has(child.tagName)) text += textOf(child);
  }
  return text;
}

/**
 * Inline Markdown for a subtree: links and inline code survive, everything else
 * becomes its text. The landing copy uses no other inline mark.
 */
function inline(node: ParentNode): string {
  let out = "";
  for (const child of childrenOf(node)) {
    if (isText(child)) {
      out += child.value;
      continue;
    }
    if (!isElement(child) || skipped.has(child.tagName)) continue;
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
  const labels = descendants(node, (element) => element.tagName === "input")
    .map((element) => attribute(element, "aria-label") ?? "")
    .filter((label) => label !== "");
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
    // The panel names the file the snippet belongs in, which is the one thing
    // an agent needs that the code itself does not say.
    const file = descendants(panel, (element) => element.tagName === "span")
      .map((element) => tidy(textOf(element)))
      .find((text) => /^[\w.-]+\.\w+$/.test(text));
    const heading = [label && `**${label}**`, file && `\`${file}\``].filter(Boolean).join(" — ");
    const caption = shared === undefined ? captions[index] : "";
    if (heading !== "") out.push(heading);
    out.push(fence(block, label));
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
    if (!isElement(child) || skipped.has(child.tagName)) continue;
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
    if (!isElement(child) || skipped.has(child.tagName)) continue;

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

const document = parse(await readFile(builtPage, "utf8"));
const [main] = descendants(document, (element) => element.tagName === "main");
if (!main) throw new Error("The built landing page has no <main>; the twin cannot be derived");

const body: string[] = [];
blocks(main, body);

// A run of identical paragraphs means a carousel rendered every slide. The page
// shows one at a time and the twin should read that way too.
const deduplicated = body.filter((block, index) => block !== body[index - 1]);

const frontmatter = [
  "---",
  `title: ${JSON.stringify(`${siteConfig.name}: ${siteConfig.tagline}`)}`,
  `description: ${JSON.stringify(siteConfig.description)}`,
  `canonical: ${JSON.stringify(siteConfig.url)}`,
  "---",
].join("\n");

const markdown = `${frontmatter}\n\n${deduplicated.join("\n\n")}\n`;
await writeFile(twin, markdown);

process.stdout.write(
  `Wrote the landing twin: ${deduplicated.length} blocks, ${Buffer.byteLength(markdown)} bytes\n`,
);
