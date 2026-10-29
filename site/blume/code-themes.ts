import type { BlumeConfig } from "blume";

type CodeTheme = NonNullable<
  NonNullable<NonNullable<NonNullable<BlumeConfig["markdown"]>["code"]>["theme"]>["light"]
>;

/**
 * The colours of one theme. Untitled is neutral with one amber accent, so a
 * code block has five greys and one amber: keywords are amber, names and
 * numbers are the strongest grey, strings are a softer grey, and comments and
 * punctuation are the most muted.
 */
interface Palette {
  readonly surface: string;
  readonly text: string;
  readonly comment: string;
  readonly punctuation: string;
  readonly string: string;
  readonly strong: string;
  readonly keyword: string;
}

function codeTheme(name: string, type: "light" | "dark", palette: Palette): CodeTheme {
  return {
    name,
    type,
    colors: { "editor.background": palette.surface, "editor.foreground": palette.text },
    tokenColors: [
      { settings: { foreground: palette.text } },
      {
        scope: ["comment", "punctuation.definition.comment", "string.comment"],
        settings: { foreground: palette.comment, fontStyle: "italic" },
      },
      {
        scope: [
          "keyword",
          "storage",
          "storage.type",
          "storage.modifier",
          "keyword.operator.new",
          "keyword.operator.expression",
          "keyword.control",
          "keyword.other",
          "variable.language",
          "constant.language",
          "support.type.primitive",
          "entity.name.tag",
          "markup.heading",
        ],
        settings: { foreground: palette.keyword },
      },
      {
        scope: [
          "string",
          "string.quoted",
          "string.template",
          "string.unquoted",
          "markup.inline.raw",
          "constant.other.symbol",
        ],
        settings: { foreground: palette.string },
      },
      {
        scope: [
          "constant.numeric",
          "constant.character",
          "constant.other",
          "entity.name.function",
          "support.function",
          "entity.name.method",
          "entity.name.type",
          "entity.name.class",
          "entity.name.namespace",
          "support.class",
          "support.type",
          "entity.other.inherited-class",
          "markup.inserted",
        ],
        settings: { foreground: palette.strong },
      },
      {
        scope: ["punctuation", "meta.brace", "keyword.operator", "markup.deleted"],
        settings: { foreground: palette.punctuation },
      },
      {
        scope: [
          "variable.parameter",
          "variable.other.property",
          "support.variable.property",
          "meta.object-literal.key",
          "entity.other.attribute-name",
        ],
        settings: { foreground: palette.text },
      },
    ],
  };
}

/**
 * Light: on the #fbfbfb code surface. The amber is darkened from #cf9148, and
 * comments and punctuation are darkened from #7d7d7d (3.98:1) to #6e6e6e
 * (4.93:1), so that each keeps a 4.5:1 contrast.
 */
export const lightCodeTheme = codeTheme("workhorse-light", "light", {
  surface: "#fbfbfb",
  text: "#333333",
  comment: "#6e6e6e",
  punctuation: "#6e6e6e",
  string: "#555555",
  strong: "#000000",
  keyword: "#8f5b1d",
});

/** Dark: on the #141414 code surface, with the brand amber as it is. */
export const darkCodeTheme = codeTheme("workhorse-dark", "dark", {
  surface: "#141414",
  text: "#cfcfcf",
  comment: "#838383",
  punctuation: "#838383",
  string: "#ababab",
  strong: "#ffffff",
  keyword: "#cf9148",
});
