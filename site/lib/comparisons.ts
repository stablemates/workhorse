import data from "../comparisons.json" with { type: "json" };

/**
 * The comparison data: the single source for which products the "Compare"
 * group names, which facts it states about each one, and where each fact comes
 * from (ADR 0104).
 *
 * Three surfaces read it: the hub at `/compare`, each product page at
 * `/compare/<product>`, and the Markdown twin of both (ADR 0116). Adding a
 * product page is one MDX file under `content/docs/compare/` and one entry here.
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

/**
 * Whether a product needs a service beside the application database: "none"
 * when a SQL database is all it needs, "optional" when a database backend is
 * one choice beside a service, and "required" otherwise. Only the
 * `infrastructure` row states it, from the same source as its value.
 */
type ExtraService = "none" | "optional" | "required";

interface WorkhorseTextCell {
  readonly value: string;
  readonly extraService?: ExtraService;
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
  readonly extraService?: ExtraService;
}

export type CompetitorCell = CompetitorStatusCell | CompetitorTextCell;

interface ComparisonCategory {
  readonly id: string;
  /** The short name of the approach, for a column head. */
  readonly label: string;
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
  /** The page under `content/docs/compare/`, and therefore `/compare/<slug>`. */
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

/** The URL of the hub. Before ADR 0116 it was `/docs/compare`, which now redirects here. */
export const compareHubUrl = "/compare";

/** The URL of a product page. */
export function productUrl(product: ComparisonProduct): string {
  return `${compareHubUrl}/${product.slug}`;
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

/** One numbered source of a page: the URL that a competitor cell cites. */
export interface SourceReference {
  readonly number: number;
  readonly url: string;
}

/**
 * Numbers each distinct source URL in the order that a reader meets it. Cells
 * that cite the same URL share one number.
 */
function numberSources(cells: readonly CompetitorCell[]): readonly SourceReference[] {
  const numbers = new Map<string, number>();
  for (const cell of cells) {
    if (!numbers.has(cell.source)) numbers.set(cell.source, numbers.size + 1);
  }
  return [...numbers].map(([url, number]) => ({ number, url }));
}

/** The sources of one product page, in the order of its table. */
export function productSources(product: ComparisonProduct): readonly SourceReference[] {
  return numberSources(productGroups(product).flatMap(({ rows }) => rows.map(({ cell }) => cell)));
}

/** The number of `url` in `sources`. Every cell's source is in its page's list. */
export function sourceNumber(sources: readonly SourceReference[], url: string): number {
  const reference = sources.find((entry) => entry.url === url);
  if (!reference) throw new Error(`The source ${url} is not in the list of the page`);
  return reference.number;
}

/** The competitor cell of `product` for `row`, or an error that names both. */
function productCell(product: ComparisonProduct, rowId: string): CompetitorCell {
  const cell = product.cells[rowId];
  if (!cell) throw new Error(`The product "${product.slug}" has no cell for the row "${rowId}"`);
  return cell;
}

/** The row with `id`, or an error that names it. */
function sharedRow(id: string): ComparisonRow {
  const row = comparisons.rows.find((entry) => entry.id === id);
  if (!row) throw new Error(`site/comparisons.json has no row "${id}"`);
  return row;
}

// The approach matrix of the hub. It compares the ways to run background work,
// not the products: each column is Workhorse or one category, and each cell of
// a category counts what its products state in `comparisons.json`.

/** The mark of a product or an approach for one capability. */
export type Mark = "Supported" | "Partial" | "Not supported";

/**
 * Languages that one runtime shares count as one language, so a product with
 * TypeScript and JavaScript workers has one worker language.
 */
const sameLanguage: Readonly<Record<string, string>> = {
  JavaScript: "TypeScript",
  Kotlin: "Java",
  "C#": ".NET",
  ".NET (C#)": ".NET",
};

/** The distinct worker languages of a `worker-languages` value. */
export function workerLanguages(value: string): readonly string[] {
  const names = value
    .split(/,|\/|\bor\b/)
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .map((name) => sameLanguage[name] ?? name);
  return [...new Set(names)];
}

const extraServiceMark = {
  none: "Supported",
  optional: "Partial",
  required: "Not supported",
} as const;

/** The mark of one cell. A status cell gives its free edition, and a text cell needs `read`. */
type CellReader = (cell: ComparisonRow["workhorse"] | CompetitorCell) => Mark;

function statusOf(cell: ComparisonRow["workhorse"] | CompetitorCell): Mark {
  if (!("status" in cell)) throw new Error("A status capability reads a text cell");
  if (cell.status === "Supported" || cell.status === "Partial") return cell.status;
  return "Not supported";
}

function textOf(cell: ComparisonRow["workhorse"] | CompetitorCell): string {
  if ("status" in cell) throw new Error("A text capability reads a status cell");
  return cell.value;
}

export interface ApproachCapability {
  /** The row of `comparisons.json` that each cell reads. */
  readonly row: string;
  readonly label: string;
  /** What a product must do to count, in one sentence. */
  readonly rule: string;
  readonly read: CellReader;
}

/** The rows of the approach matrix, in the order of the page. */
export const approachCapabilities: readonly ApproachCapability[] = [
  {
    row: "transactional-enqueue",
    label: "Enqueue in the application's transaction",
    rule: "The task commits or rolls back together with the writes of the application.",
    read: statusOf,
  },
  {
    row: "checkpoints",
    label: "Checkpoints that skip completed steps",
    rule: "When a task runs again, it skips steps that already completed.",
    read: statusOf,
  },
  {
    row: "durable-waits",
    label: "Durable timers and signals",
    rule: "A task waits for a timer or a signal, and no worker holds it while it waits.",
    read: statusOf,
  },
  {
    row: "task-dependencies",
    label: "Task dependencies",
    rule: "A task starts only after the tasks that it depends on finish.",
    read: statusOf,
  },
  {
    row: "worker-languages",
    label: "Workers in more than one language",
    rule: "Workers in two or more languages process tasks. Languages that share a runtime count as one.",
    read: (cell) => (workerLanguages(textOf(cell)).length > 1 ? "Supported" : "Not supported"),
  },
  {
    row: "infrastructure",
    label: "No service beside the database",
    rule: "A SQL database is the only service that the product needs. Partial: a database backend is one choice.",
    read: (cell) => {
      if ("status" in cell || !cell.extraService) {
        throw new Error("The infrastructure row needs an extraService on each cell");
      }
      return extraServiceMark[cell.extraService];
    },
  },
];

/** One product inside an approach cell. */
interface ApproachProduct {
  readonly product: ComparisonProduct;
  readonly mark: Mark;
}

/** The cell of one approach for one capability: its mark and the count behind it. */
export interface ApproachCell {
  readonly mark: Mark;
  readonly supported: number;
  readonly partial: number;
  readonly products: readonly ApproachProduct[];
}

/** The mark of Workhorse for one capability. */
export function workhorseMark(capability: ApproachCapability): Mark {
  return capability.read(sharedRow(capability.row).workhorse);
}

/**
 * The cell of one category. It is "Supported" when every product supports the
 * capability, "Not supported" when none supports it even in part, and
 * "Partial" otherwise.
 */
export function approachCell(
  capability: ApproachCapability,
  products: readonly ComparisonProduct[],
): ApproachCell {
  const marks = products.map((product) => ({
    product,
    mark: capability.read(productCell(product, capability.row)),
  }));
  const supported = marks.filter(({ mark }) => mark === "Supported").length;
  const partial = marks.filter(({ mark }) => mark === "Partial").length;
  const mark: Mark =
    supported === marks.length
      ? "Supported"
      : supported + partial === 0
        ? "Not supported"
        : "Partial";
  return { mark, supported, partial, products: marks };
}

/** The count line under an approach mark, for example "7 of 8 products, 1 in part". */
export function approachCount(cell: ApproachCell): string {
  const total = cell.products.length;
  const base = `${cell.supported} of ${total} ${total === 1 ? "product" : "products"}`;
  return cell.partial > 0 ? `${base}, ${cell.partial} in part` : base;
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
 * The Markdown of the hub: the approach matrix of the HTML page, then one
 * table for each hub row, with Workhorse first and a bold line for each
 * category, then one table of versions and check dates for each category.
 */
export function hubMarkdown(base: string): string {
  const categories = hubCategories();
  const approaches = [
    "| Capability | Workhorse | " +
      categories.map(({ category }) => tableText(category.label)).join(" | ") +
      " |",
    `| --- | --- | ${categories.map(() => "---").join(" | ")} |`,
    ...approachCapabilities.map(
      (capability) =>
        `| ${tableText(capability.label)} | ${workhorseMark(capability)} | ` +
        categories
          .map(({ products }) => {
            const cell = approachCell(capability, products);
            return `${cell.mark} (${approachCount(cell)})`;
          })
          .join(" | ") +
        " |",
    ),
  ].join("\n");
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
  const lists = categories.map(({ category, products }) =>
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
  return [
    approaches,
    "The tables below give the status of each product for each feature of the hub.",
    ...features,
    ...lists,
  ].join("\n\n");
}
