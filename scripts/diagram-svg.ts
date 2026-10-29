/**
 * Primitives for the documentation diagrams under `site/diagrams/`.
 *
 * The tokens come from the Untitled theme: ten neutral steps for each color scheme and one accent
 * for the single focal element of a diagram. Boxes have hairline strokes and 8 px corners, and
 * regions have 12 px corners. Labels use the sans family. A label uses the mono family only when it
 * is a code identifier (see `isCode`). `generate-diagrams.ts` renders each diagram to PNG with
 * resvg, because GitHub cannot load web fonts in an image a README embeds.
 */

export type Theme = "light" | "dark";

interface Palette {
  /** The page behind the diagram, and the mask behind a label on a line. Neutral 1. */
  readonly paper: string;
  /** The fill of a PostgreSQL state box. Neutral 3 in light, neutral 2 in dark. */
  readonly well: string;
  /** Region outlines and dividers. Neutral 4. */
  readonly hairline: string;
  /** Box outlines. Neutral 5. */
  readonly line: string;
  /** Arrows. Neutral 7 in light, neutral 6 in dark, for 3:1 contrast on the paper. */
  readonly arrow: string;
  /** Names and headings. Neutral 10 in light, neutral 9 in dark. */
  readonly ink: string;
  /** Subtitles and secondary text. Neutral 8 in light, neutral 7 in dark. */
  readonly muted: string;
  /**
   * Region labels, arrow labels, and the least important text. Neutral 8 in light, 7 in dark,
   * for 4.5:1 contrast on the paper and the well.
   */
  readonly soft: string;
  /** The one accent, for the focal element. */
  readonly accent: string;
  readonly accentRgb: string;
}

const palettes: Record<Theme, Palette> = {
  light: {
    paper: "#ffffff",
    well: "#f4f4f4",
    hairline: "#e7e7e7",
    line: "#cdcdcd",
    arrow: "#7d7d7d",
    ink: "#000000",
    muted: "#555555",
    soft: "#555555",
    accent: "#cf9148",
    accentRgb: "207,145,72",
  },
  dark: {
    paper: "#000000",
    well: "#202020",
    hairline: "#2b2b2b",
    line: "#3d3d3d",
    arrow: "#838383",
    ink: "#f4f4f4",
    muted: "#cfcfcf",
    soft: "#ababab",
    accent: "#cf9148",
    accentRgb: "207,145,72",
  },
};

/** The sans stack of the theme. resvg uses the first family it has a file for. */
export const SANS = "Timeless Grotesk, Geist, sans-serif";
export const MONO = "Geist Mono, monospace";

/** A box style: the dashboard is `focal`, a process is `backend`, PostgreSQL state is `store`. */
type BoxKind = "focal" | "backend" | "store" | "external";

type Color = "ink" | "muted" | "soft";

/** One centered text row: the text, its size, its color, its family, and its weight. */
export type Row = readonly [
  text: string,
  size: number,
  color: Color,
  family: string,
  weight: number,
];

/** Round up to the 4 px grid. */
function grid(value: number): number {
  return Math.ceil(value / 4) * 4;
}

/**
 * True when `text` reads as code: an identifier with an underscore, a call, a dotted or camel-case
 * name, a key and value, a path, a quoted string, or a cron field. Plain words and lists of plain
 * words are prose and use the sans family, and so is a full sentence that names an identifier.
 */
function isCode(text: string): boolean {
  if (/^[A-Z].*\.$/.test(text) && text.split(" ").length > 5) return false;
  return /[_(){}=<>/"`*[\]]|&quot;|&lt;|&gt;|\b[a-z][a-z0-9]*[A-Z]|\w\.\w|\w:\w|--/.test(text);
}

/** The family for a text: mono for code, sans for prose. */
function familyOf(text: string, requested: string = MONO): string {
  return requested === MONO && isCode(text) ? MONO : SANS;
}

/** The width of a label mask, from its character count, size, and family. */
function labelWidth(text: string, size: number, family: string): number {
  const em = family === MONO ? 0.62 : /^[^a-z]*$/.test(text) ? 0.66 : 0.56;
  return grid([...text].length * em * size + 12);
}

export class Diagram {
  readonly #parts: string[] = [];
  readonly #palette: Palette;

  constructor(readonly theme: Theme) {
    this.#palette = palettes[theme];
  }

  /** A titled region. Draw zones after the arrows that cross them and before their boxes. */
  zone(x: number, y: number, w: number, h: number, text: string): void {
    const p = this.#palette;
    const family = familyOf(text);
    const lw = labelWidth(text, 8, family);
    this.#parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="none" stroke="${p.hairline}" stroke-width="1"/>`,
      `<rect x="${x + 12}" y="${y - 6}" width="${lw}" height="12" fill="${p.paper}"/>`,
      `<text x="${x + 12 + lw / 2}" y="${y + 3}" fill="${p.soft}" font-size="8" font-weight="500" font-family="${family}" text-anchor="middle" letter-spacing="0.04em">${text}</text>`,
    );
  }

  /** An orthogonal arrow along `d`. Draw arrows before boxes, so a box covers the line end. */
  arrow(d: string, { dashed = false }: { readonly dashed?: boolean } = {}): void {
    const dash = dashed ? ' stroke-dasharray="4,3"' : "";
    this.#parts.push(
      `<path d="${d}" fill="none" stroke="${this.#palette.arrow}" stroke-width="1"${dash} marker-end="url(#arrow-${this.theme})"/>`,
    );
  }

  /** A label on a paper mask, centered on `x`. */
  label(x: number, y: number, text: string): void {
    const p = this.#palette;
    const family = familyOf(text);
    const w = labelWidth(text, 9, family);
    this.#parts.push(
      `<rect x="${x - w / 2}" y="${y}" width="${w}" height="12" rx="2" fill="${p.paper}"/>`,
      `<text x="${x}" y="${y + 9}" fill="${p.soft}" font-size="9" font-family="${family}" text-anchor="middle">${text}</text>`,
    );
  }

  /** A box with an optional centered name and subtitle. */
  box(
    x: number,
    y: number,
    w: number,
    h: number,
    kind: BoxKind,
    name?: string,
    sub?: string,
    size = 12,
  ): void {
    const p = this.#palette;
    const [fill, stroke] = {
      focal: [`rgba(${p.accentRgb},0.12)`, p.accent],
      backend: [p.paper, p.line],
      store: [p.well, p.hairline],
      external: [p.paper, p.hairline],
    }[kind];
    // A short or narrow bar keeps small corners, so it does not become a pill.
    const rx = Math.min(8, h / 4, w / 4);
    this.#parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${p.paper}"/>`,
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`,
    );
    if (name === undefined) return;
    const cx = x + w / 2;
    const ny = y + h / 2 + (sub === undefined ? 4 : -2);
    const nameColor = kind === "external" ? p.muted : p.ink;
    this.#parts.push(
      `<text x="${cx}" y="${ny}" fill="${nameColor}" font-size="${size}" font-weight="500" font-family="${familyOf(name)}" text-anchor="middle">${name}</text>`,
    );
    if (sub !== undefined) {
      this.#parts.push(
        `<text x="${cx}" y="${ny + 14}" fill="${p.soft}" font-size="9" font-family="${familyOf(sub)}" text-anchor="middle">${sub}</text>`,
      );
    }
  }

  /**
   * Text rows from baseline `y`, 15 px apart, centered on `x` unless `anchor` is `start`. A row that
   * asks for the mono family gets it only when its text is code.
   */
  rows(x: number, y: number, rows: readonly Row[], anchor: "middle" | "start" = "middle"): void {
    rows.forEach(([text, size, color, family, weight], index) => {
      const resolved = familyOf(text, family);
      const w = resolved === SANS ? Math.min(weight, 500) : weight;
      this.#parts.push(
        `<text x="${x}" y="${y + index * 15}" fill="${this.#palette[color]}" font-size="${size}" font-family="${resolved}" font-weight="${w}" text-anchor="${anchor}">${text}</text>`,
      );
    });
  }

  /** A horizontal divider inside a box. */
  divider(x1: number, x2: number, y: number): void {
    this.#parts.push(
      `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${this.#palette.hairline}"/>`,
    );
  }

  /** Text from `x`, for a legend or a line of code. Code uses the mono family, prose uses sans. */
  text(
    x: number,
    y: number,
    text: string,
    {
      size = 9,
      color = "muted",
      anchor = "start",
    }: {
      readonly size?: number;
      readonly color?: Color;
      readonly anchor?: "start" | "middle" | "end";
    } = {},
  ): void {
    this.#parts.push(
      `<text x="${x}" y="${y}" fill="${this.#palette[color]}" font-size="${size}" font-family="${familyOf(text)}" text-anchor="${anchor}">${text}</text>`,
    );
  }

  /** The complete SVG document, with an accessible title and description. */
  render(slug: string, width: number, height: number, title: string, description: string): string {
    const p = this.#palette;
    const id = `${slug}-${this.theme}`;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="${id}-title ${id}-desc">`,
      `<title id="${id}-title">${title}</title>`,
      `<desc id="${id}-desc">${description}</desc>`,
      `<defs><marker id="arrow-${this.theme}" markerWidth="8" markerHeight="8" refX="6.5" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M 1.5,1 L 6.5,4 L 1.5,7" fill="none" stroke="${p.arrow}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`,
      `<rect width="${width}" height="${height}" fill="${p.paper}"/>`,
      ...this.#parts,
      "</svg>",
      "",
    ].join("\n");
  }
}
