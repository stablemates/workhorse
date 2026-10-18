import data from "../comparisons.json" with { type: "json" };

/**
 * The comparison data: the single source for which products the "Compare"
 * group names, which facts it states about each one, and where each fact comes
 * from (ADR 0104).
 *
 * Four surfaces read it: the docs sidebar, the hub at `/docs/compare`, each
 * product page, and the Markdown twin of all three. Adding a product page is one
 * MDX file under `content/docs/compare/` and one entry here.
 */

/** The status words of `docs/features.md` and `docs/parity.md`. */
type WorkhorseStatus = "Supported" | "Partial" | "Planned" | "Not supported" | "Absent";

/** The words a competitor cell can use. "Unknown" never ships: the schema test refuses it. */
type CompetitorStatus = "Supported" | "Partial" | "Not supported";

/** A status row says whether a product has a capability; a text row names a value. */
type RowKind = "status" | "text";

/** The row of a Workhorse matrix that a status cell restates. */
interface FeatureReference {
  readonly doc: "docs/features.md" | "docs/parity.md";
  /** The first cell of the row, exactly as the matrix spells it. */
  readonly row: string;
}

interface WorkhorseStatusCell {
  readonly status: WorkhorseStatus;
  readonly feature: FeatureReference;
  /** The docs page that explains the capability, as a `/docs/…` path. */
  readonly page?: string;
  readonly note?: string;
}

interface WorkhorseTextCell {
  readonly value: string;
  /** A repository path that states the value. */
  readonly source: string;
  readonly page?: string;
  readonly note?: string;
}

type WorkhorseCell = WorkhorseStatusCell | WorkhorseTextCell;

interface CompetitorCellBase {
  /** A public URL at the pinned version that supports the cell. */
  readonly source: string;
  /** The competitor version the source describes. Equal to the product's version. */
  readonly version: string;
  /** A short quote or code reference from the source, for the reviewer and the quarterly check. */
  readonly evidence: string;
  readonly note?: string;
}

/**
 * A paid edition, a paid license, or a managed service that reaches a higher
 * status than the free edition. The license note of the product names it, and
 * the source and evidence of the cell support it.
 */
interface PaidEdition {
  readonly edition: string;
  readonly status: CompetitorStatus;
}

interface CompetitorStatusCell extends CompetitorCellBase {
  /** The status of the free edition. */
  readonly status: CompetitorStatus;
  /** Set only when a paid edition reaches a higher status than `status`. */
  readonly paid?: PaidEdition;
}

interface CompetitorTextCell extends CompetitorCellBase {
  readonly value: string;
}

type CompetitorCell = CompetitorStatusCell | CompetitorTextCell;

interface ComparisonCategory {
  readonly id: string;
  readonly title: string;
  /** What the products of this category have in common, in one or two sentences. */
  readonly summary: string;
}

interface ComparisonGroup {
  readonly id: string;
  readonly title: string;
}

export interface ComparisonRow {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly kind: RowKind;
  /** A hub row is a column of the hub matrix, so every product states it. */
  readonly hub?: boolean;
  readonly workhorse: WorkhorseCell;
}

/** A row that one product page adds for itself. A page adds at most three. */
interface ProductRow extends ComparisonRow {
  readonly cell: CompetitorCell;
}

/**
 * Whether the page behind an entry exists yet. A planned entry has a hub row
 * and no page, and names the Issue that writes the page.
 */
type PageStatus = "published" | "planned";

export interface ComparisonProduct {
  /** The page under `content/docs/compare/`, and therefore `/docs/compare/<slug>`. */
  readonly slug: string;
  readonly name: string;
  /** Other spellings of the name, such as a package name, for the name guard. */
  readonly aliases?: readonly string[];
  readonly category: string;
  readonly page: PageStatus;
  /** The Issue that writes a planned page. Planned entries only. */
  readonly issue?: string;
  readonly version: string;
  /** The ISO date when a person last checked every cell against `version`. */
  readonly checked: string;
  readonly repository: string;
  /** What the product is, in its own terms. */
  readonly summary: string;
  readonly cells: Readonly<Record<string, CompetitorCell>>;
  readonly rows?: readonly ProductRow[];
}

interface ComparisonData {
  readonly categories: readonly ComparisonCategory[];
  readonly groups: readonly ComparisonGroup[];
  readonly rows: readonly ComparisonRow[];
  readonly products: readonly ComparisonProduct[];
}

export const comparisons = data as ComparisonData;

/** The URL of a product page. */
export function productUrl(product: ComparisonProduct): string {
  return `/docs/compare/${product.slug}`;
}

export function isPublished(product: ComparisonProduct): boolean {
  return product.page === "published";
}

/** Finds a product by slug, or throws with the slug in the message. */
export function comparisonProduct(slug: string): ComparisonProduct {
  const product = comparisons.products.find((entry) => entry.slug === slug);
  if (!product) throw new Error(`site/comparisons.json has no product "${slug}"`);
  return product;
}

/** The columns of the hub matrix, in row order. */
export function hubRows(): readonly ComparisonRow[] {
  return comparisons.rows.filter((row) => row.hub);
}

/** One category of the hub, with its products in data order. */
export interface HubCategory {
  readonly category: ComparisonCategory;
  readonly products: readonly ComparisonProduct[];
}

/** The categories of the hub, each with its products. */
export function hubCategories(): readonly HubCategory[] {
  return comparisons.categories.map((category) => ({
    category,
    products: comparisons.products.filter((product) => product.category === category.id),
  }));
}

/** One group of a product table: the core rows, then the product's own rows of that group. */
export interface ProductGroup {
  readonly group: ComparisonGroup;
  readonly rows: readonly { readonly row: ComparisonRow; readonly cell: CompetitorCell }[];
}

/** The rows of one product page, grouped in the order of `groups`. */
export function productGroups(product: ComparisonProduct): readonly ProductGroup[] {
  return comparisons.groups.map((group) => ({
    group,
    rows: [
      ...comparisons.rows
        .filter((row) => row.group === group.id)
        .map((row) => {
          const cell = product.cells[row.id];
          if (!cell) {
            throw new Error(`The product "${product.slug}" has no cell for the row "${row.id}"`);
          }
          return { row, cell };
        }),
      ...(product.rows ?? [])
        .filter((row) => row.group === group.id)
        .map((row) => ({ row, cell: row.cell })),
    ],
  }));
}

/**
 * The word or value a cell shows. A cell with a paid edition shows both
 * statuses, for example "Partial; Supported with Example Pro".
 */
export function cellText(cell: WorkhorseCell | CompetitorCell): string {
  if (!("status" in cell)) return cell.value;
  return "paid" in cell && cell.paid
    ? `${cell.status}; ${cell.paid.status} with ${cell.paid.edition}`
    : cell.status;
}

/** The ISO date as a reader spells it, for example "17 October 2026". */
function readableDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** The line above a product table that says what was checked and when. */
export function checkedLine(product: ComparisonProduct): string {
  return `Last checked on ${readableDate(product.checked)} against ${product.name} ${product.version}.`;
}

// Markdown for the agent twin. `site/scripts/mdx-to-markdown.ts` replaces a
// `<ComparisonTable />` tag with this text, so the twin holds the same table
// as the HTML page.

/** Escapes the characters that end a Markdown table cell. */
function tableText(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function workhorseMarkdown(cell: WorkhorseCell, base: string): string {
  const text = cellText(cell);
  const shown = cell.page ? `[${text}](${base}${cell.page}.md)` : text;
  return tableText(cell.note ? `${shown}. ${cell.note}` : shown);
}

function competitorMarkdown(cell: CompetitorCell): string {
  const text = cellText(cell);
  return tableText(`${cell.note ? `${text}. ${cell.note}` : text} ([source](${cell.source}))`);
}

/** The Markdown of a product table, one table for each group. */
export function productMarkdown(product: ComparisonProduct, base: string): string {
  const tables = productGroups(product)
    .filter(({ rows }) => rows.length > 0)
    .map(({ group, rows }) =>
      [
        `**${group.title}**`,
        "",
        `| Capability | Workhorse | ${tableText(product.name)} ${product.version} |`,
        "| --- | --- | --- |",
        ...rows.map(
          ({ row, cell }) =>
            `| ${tableText(row.label)} | ${workhorseMarkdown(row.workhorse, base)} | ${competitorMarkdown(cell)} |`,
        ),
      ].join("\n"),
    );
  return [checkedLine(product), "", tables.join("\n\n")].join("\n");
}

/** The product name, as a link when the product has a page. */
function productNameMarkdown(product: ComparisonProduct, base: string): string {
  return isPublished(product)
    ? `[${tableText(product.name)}](${base}${productUrl(product)}.md)`
    : tableText(product.name);
}

/**
 * The Markdown of the hub, in the order of the HTML: one table for each hub
 * row, with Workhorse first and a bold line for each category, then one table
 * of versions and check dates for each category.
 */
export function hubMarkdown(base: string): string {
  const features = hubRows().map((row) => {
    const rows = hubCategories().flatMap(({ category, products }) =>
      [`| **${tableText(category.title)}** | |`].concat(
        products.map((product) => {
          const cell = product.cells[row.id];
          if (!cell) {
            throw new Error(
              `The product "${product.slug}" has no cell for the hub row "${row.id}"`,
            );
          }
          return `| ${productNameMarkdown(product, base)} ${product.version} | ${competitorMarkdown(cell)} |`;
        }),
      ),
    );
    return [
      `### ${tableText(row.label)}`,
      "",
      `| Product | ${tableText(row.label)} |`,
      "| --- | --- |",
      `| Workhorse | ${workhorseMarkdown(row.workhorse, base)} |`,
      ...rows,
    ].join("\n");
  });
  const categories = hubCategories().map(({ category, products }) =>
    [
      `### ${category.title}`,
      "",
      category.summary,
      "",
      "| Product | Version | Checked |",
      "| --- | --- | --- |",
      ...products.map(
        (product) =>
          `| ${productNameMarkdown(product, base)} | ${product.version} | ${product.checked} |`,
      ),
    ].join("\n"),
  );
  return [...features, ...categories].join("\n\n");
}
