import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import diagramSizes from "../lib/diagram-sizes.json";
import { Diagram } from "./diagram";

const contentRoot = resolve(import.meta.dirname, "../content");

/** The `<img>` or `<source>` tags of the markup, each as a map of its attributes. */
function tags(markup: string, name: "img" | "source") {
  return [...markup.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "g"))].map(
    ([, attributes]) =>
      new Map(
        [...attributes!.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key!, value!]),
      ),
  );
}

describe("the docs diagram", () => {
  it("reserves the space of each image and loads every image lazily", () => {
    const markup = renderToStaticMarkup(<Diagram name="query-reads" alt="One read" />);
    const [width, height] = diagramSizes["query-reads"];
    const [narrowWidth, narrowHeight] = diagramSizes["query-reads-narrow"];

    const images = tags(markup, "img");
    // Two themes in the column and two in the closed dialog.
    expect(images).toHaveLength(4);
    for (const image of images) {
      expect(image.get("width")).toBe(String(width));
      expect(image.get("height")).toBe(String(height));
      expect(image.get("loading")).toBe("lazy");
      expect(image.get("decoding")).toBe("async");
    }
    const sources = tags(markup, "source");
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(source.get("width")).toBe(String(narrowWidth));
      expect(source.get("height")).toBe(String(narrowHeight));
    }
  });

  it("loads the column images of a first-screen diagram eagerly and the dialog images lazily", () => {
    const markup = renderToStaticMarkup(<Diagram eager name="query-reads" alt="One read" />);
    expect(tags(markup, "img").map((image) => image.get("loading"))).toEqual([
      "eager",
      "eager",
      "lazy",
      "lazy",
    ]);
  });

  it("shows only the narrow image in the column of a narrow diagram, and the wide one in the dialog", () => {
    const markup = renderToStaticMarkup(<Diagram narrow name="query-reads" alt="One read" />);
    const [narrowWidth] = diagramSizes["query-reads-narrow"];
    const [width] = diagramSizes["query-reads"];
    expect(tags(markup, "source")).toEqual([]);
    expect(tags(markup, "img").map((image) => [image.get("src"), image.get("width")])).toEqual([
      ["/diagrams/query-reads-narrow-light.png", String(narrowWidth)],
      ["/diagrams/query-reads-narrow-dark.png", String(narrowWidth)],
      ["/diagrams/query-reads-light.png", String(width)],
      ["/diagrams/query-reads-dark.png", String(width)],
    ]);
  });

  it("refuses a diagram that the generator does not write", () => {
    expect(() => renderToStaticMarkup(<Diagram name="no-such-diagram" alt="None" />)).toThrow(
      /No diagram named no-such-diagram/,
    );
  });
});

describe("the diagrams on the docs pages", () => {
  it("have generated sizes and are eager only before the first section of their page", async () => {
    const files = (await readdir(contentRoot, { recursive: true })).filter((file) =>
      file.endsWith(".mdx"),
    );
    const misplaced: string[] = [];
    let count = 0;
    for (const file of files) {
      const source = await readFile(join(contentRoot, file), "utf8");
      const firstSection = source.search(/^## /m);
      for (const match of source.matchAll(/<Diagram\b[^>]*?\/>/gs)) {
        count += 1;
        const tag = match[0];
        const name = /\bname="([^"]+)"/.exec(tag)?.[1] ?? "";
        expect(diagramSizes, `${file}: ${name}`).toHaveProperty([name]);
        expect(diagramSizes, `${file}: ${name}-narrow`).toHaveProperty([`${name}-narrow`]);
        const inFirstScreen = firstSection === -1 || match.index < firstSection;
        if (/\beager\b/.test(tag) !== inFirstScreen) misplaced.push(`${file}: ${name}`);
      }
    }
    expect(count).toBeGreaterThan(0);
    expect(misplaced, "Set `eager` only on a diagram before the first `##` heading.").toEqual([]);
  });
});
