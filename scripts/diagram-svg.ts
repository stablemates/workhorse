/**
 * Primitives for the documentation diagrams under `site/public/diagrams/`.
 *
 * The tokens come from `site/src/styles/global.css`, so a diagram matches the site in both color
 * schemes. Each diagram is plain SVG with Geist and Geist Mono text. `generate-diagrams.ts` renders
 * it to PNG with resvg, because GitHub cannot load web fonts in an image a README embeds.
 */

export type Theme = "light" | "dark";

interface Palette {
  readonly paper: string;
  readonly ink: string;
  readonly inkRgb: string;
  readonly muted: string;
  readonly soft: string;
  readonly accent: string;
  readonly accentRgb: string;
  readonly backend: string;
}

const palettes: Record<Theme, Palette> = {
  light: {
    paper: "#f9fafb",
    ink: "#1a2027",
    inkRgb: "26,32,39",
    muted: "#4e5359",
    soft: "#6d7277",
    accent: "#aa4515",
    accentRgb: "213,92,19",
    backend: "#ffffff",
  },
  dark: {
    paper: "#04080e",
    ink: "#f2f4f5",
    inkRgb: "242,244,245",
    muted: "#ced1d4",
    soft: "#95999d",
    accent: "#fc984c",
    accentRgb: "252,152,76",
    backend: "#0a1017",
  },
};

export const SANS = "Geist";
export const MONO = "Geist Mono";

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

/** The width of a mono label mask, from its character count, size, and tracking. */
function labelWidth(text: string, size = 8, tracking = 0.06): number {
  return grid([...text].length * (0.62 + tracking) * size + 12);
}

export class Diagram {
  readonly #parts: string[] = [];
  readonly #palette: Palette;

  constructor(readonly theme: Theme) {
    this.#palette = palettes[theme];
  }

  #ink(alpha: number): string {
    return `rgba(${this.#palette.inkRgb},${alpha})`;
  }

  /** A titled region. Draw zones after the arrows that cross them and before their boxes. */
  zone(x: number, y: number, w: number, h: number, text: string): void {
    const p = this.#palette;
    const lw = labelWidth(text, 7, 0.14);
    this.#parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${this.#ink(0.02)}" stroke="${this.#ink(0.12)}" stroke-width="0.8"/>`,
      `<rect x="${x + 12}" y="${y - 6}" width="${lw}" height="12" rx="2" fill="${p.paper}"/>`,
      `<text x="${x + 12 + lw / 2}" y="${y + 3}" fill="${p.soft}" font-size="7" font-family="${MONO}" text-anchor="middle" letter-spacing="0.14em">${text}</text>`,
    );
  }

  /** An orthogonal arrow along `d`. Draw arrows before boxes, so a box covers the line end. */
  arrow(d: string, { dashed = false }: { readonly dashed?: boolean } = {}): void {
    const dash = dashed ? ' stroke-dasharray="5,4"' : "";
    this.#parts.push(
      `<path d="${d}" fill="none" stroke="${this.#palette.muted}" stroke-width="1.2"${dash} marker-end="url(#arrow-${this.theme})"/>`,
    );
  }

  /** A mono label on a paper mask, centered on `x`. */
  label(x: number, y: number, text: string): void {
    const p = this.#palette;
    const w = labelWidth(text);
    this.#parts.push(
      `<rect x="${x - w / 2}" y="${y}" width="${w}" height="12" rx="2" fill="${p.paper}"/>`,
      `<text x="${x}" y="${y + 9}" fill="${p.soft}" font-size="8" font-family="${MONO}" text-anchor="middle" letter-spacing="0.06em">${text}</text>`,
    );
  }

  /** A box with an optional centered name and mono subtitle. */
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
    const [fill, stroke, dash, width] = {
      focal: [`rgba(${p.accentRgb},0.08)`, p.accent, "", "1.4"],
      backend: [p.backend, p.ink, "", "1"],
      store: [this.#ink(0.05), p.muted, "", "1"],
      external: [this.#ink(0.03), this.#ink(0.4), ' stroke-dasharray="4,3"', "1"],
    }[kind];
    this.#parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${p.paper}"/>`,
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="${width}"${dash}/>`,
    );
    if (name === undefined) return;
    const cx = x + w / 2;
    const ny = y + h / 2 + (sub === undefined ? 4 : -2);
    this.#parts.push(
      `<text x="${cx}" y="${ny}" fill="${p.ink}" font-size="${size}" font-weight="600" font-family="${SANS}" text-anchor="middle">${name}</text>`,
    );
    if (sub !== undefined) {
      this.#parts.push(
        `<text x="${cx}" y="${ny + 14}" fill="${p.muted}" font-size="9" font-family="${MONO}" text-anchor="middle">${sub}</text>`,
      );
    }
  }

  /** Text rows from baseline `y`, 15 px apart, centered on `x` unless `anchor` is `start`. */
  rows(x: number, y: number, rows: readonly Row[], anchor: "middle" | "start" = "middle"): void {
    rows.forEach(([text, size, color, family, weight], index) => {
      this.#parts.push(
        `<text x="${x}" y="${y + index * 15}" fill="${this.#palette[color]}" font-size="${size}" font-family="${family}" font-weight="${weight}" text-anchor="${anchor}">${text}</text>`,
      );
    });
  }

  /** A horizontal divider inside a box. */
  divider(x1: number, x2: number, y: number): void {
    this.#parts.push(
      `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${this.#ink(0.14)}"/>`,
    );
  }

  /** Left-aligned mono text, for a legend or a line of code. */
  text(
    x: number,
    y: number,
    text: string,
    { size = 9, color = "muted" }: { readonly size?: number; readonly color?: Color } = {},
  ): void {
    this.#parts.push(
      `<text x="${x}" y="${y}" fill="${this.#palette[color]}" font-size="${size}" font-family="${MONO}">${text}</text>`,
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
      `<defs><marker id="arrow-${this.theme}" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="${p.muted}"/></marker></defs>`,
      `<rect width="${width}" height="${height}" fill="${p.paper}"/>`,
      ...this.#parts,
      "</svg>",
      "",
    ].join("\n");
  }
}
