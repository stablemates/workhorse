import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The app loads Mantine's styles one component at a time (`styles.css`), not the whole
 * `@mantine/core/styles.css`. A component whose style file is not loaded still renders, but without
 * its layout: a `SimpleGrid` stacks its cells in one column, and a `Progress` bar has no height.
 * Neither a type check nor a unit test in jsdom shows that, so this test reads the imports.
 */
const source = dirname(fileURLToPath(import.meta.url));
const mantineStyles = dirname(
  createRequire(import.meta.url).resolve("@mantine/core/styles/Button.css"),
);
const styles = readFileSync(join(source, "styles.css"), "utf8");

/**
 * The base style files that a component also needs, because it renders a base component. The
 * scan below finds only the style file with the name of the component itself.
 */
const baseStyles: Readonly<Record<string, readonly string[]>> = {
  Accordion: ["UnstyledButton"],
  ActionIcon: ["UnstyledButton"],
  Burger: ["UnstyledButton"],
  Button: ["UnstyledButton"],
  Drawer: ["ModalBase", "Overlay", "CloseButton"],
  HoverCard: ["Popover"],
  Menu: ["Popover"],
  Modal: ["ModalBase", "Overlay", "CloseButton"],
  MultiSelect: ["Input", "Combobox", "Popover", "Pill", "PillsInput", "CloseButton"],
  NavLink: ["UnstyledButton"],
  SegmentedControl: ["FloatingIndicator"],
  Select: ["Input", "Combobox", "Popover", "CloseButton"],
  TextInput: ["Input"],
  Textarea: ["Input"],
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

/** Each value that a source file imports from `@mantine/core`, with the files that import it. */
function mantineComponents(): Map<string, string[]> {
  const components = new Map<string, string[]>();
  for (const file of sourceFiles(source)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@mantine\/core["']/g)) {
      for (const specifier of match[1]!.split(",")) {
        const name = specifier
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim();
        if (name === "" || name.startsWith("type ")) continue;
        components.set(name, [...(components.get(name) ?? []), file.slice(source.length + 1)]);
      }
    }
  }
  return components;
}

describe("Mantine component styles", () => {
  it("loads the style file of every Mantine component that the app imports", () => {
    const missing = [...mantineComponents()].flatMap(([name, files]) =>
      [name, ...(baseStyles[name] ?? [])]
        .filter((style) => existsSync(join(mantineStyles, `${style}.css`)))
        .filter((style) => !styles.includes(`@import "@mantine/core/styles/${style}.css";`))
        .map((style) => `${style}.css for ${name} (${files.join(", ")})`),
    );

    expect(missing).toEqual([]);
  });

  it("names only base style files that Mantine ships", () => {
    const unknown = Object.values(baseStyles)
      .flat()
      .filter((style) => !existsSync(join(mantineStyles, `${style}.css`)));

    expect(unknown).toEqual([]);
  });
});
