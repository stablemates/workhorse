import { useId, useState } from "react";

import {
  type ApproachCell,
  type ComparisonProduct,
  type ComparisonRow,
  type CompetitorCell,
  type Mark,
  type SourceReference,
  approachCapabilities,
  approachCell,
  approachCount,
  cellText,
  comparisonProduct,
  hubCategories,
  productGroups,
  productSources,
  sourceNumber,
  workhorseMark,
} from "@/lib/comparisons";
import { siteConfig } from "@/lib/site";

/**
 * The comparison tables of `/compare` and `/compare/<product>`, rendered from
 * `site/comparisons.json` (ADR 0104, ADR 0116). The hub compares approaches:
 * Workhorse and each category, with a count of the products behind each mark.
 * A product page compares Workhorse with one product.
 *
 * A status shows an icon and a word, so it does not depend on colour. A
 * competitor cell carries a small number that points to its source in the list
 * at the end of the page. A row with a note or a guide opens a detail row under
 * it. The detail rows are in the static HTML, with the `hidden` attribute.
 *
 * `site/scripts/mdx-to-markdown.ts` replaces the `<ComparisonTable />` tag
 * with the same facts as Markdown for the agent twin.
 */

type WorkhorseCell = ComparisonRow["workhorse"];
type Cell = WorkhorseCell | CompetitorCell;
type Status = "Supported" | "Partial" | "Planned" | "Not supported" | "Absent";

/** The glyph of each status. Each one has its own shape, so no status depends on its colour. */
const statusGlyph: Readonly<Record<Status, string>> = {
  Supported:
    '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m4.8 8.2 2.1 2.1 4.3-4.6" fill="none" stroke="var(--wh-page)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  Partial:
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5Z" fill="currentColor"/>',
  Planned:
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"/>',
  "Not supported":
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 8h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  Absent:
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 8h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
};

function StatusMark({ status }: { readonly status: Status | Mark }) {
  const strong = status === "Supported" || status === "Partial";
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap ${strong ? "text-wh-fg" : "text-wh-muted"}`}
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-4 shrink-0"
        dangerouslySetInnerHTML={{ __html: statusGlyph[status] }}
      />
      {status}
    </span>
  );
}

function FootnoteRef({ number }: { readonly number: number }) {
  return (
    <sup className="ml-1 font-mono text-[11px] leading-none">
      <a
        href={`#source-${number}`}
        aria-label={`Source ${number}`}
        className="text-wh-muted no-underline hover:text-wh-fg"
      >
        {number}
      </a>
    </sup>
  );
}

/** The status or value of one cell, its paid edition, and the number of its source. */
function CellMark({
  cell,
  sources,
}: {
  readonly cell: Cell;
  readonly sources?: readonly SourceReference[];
}) {
  const source = "evidence" in cell && sources ? sourceNumber(sources, cell.source) : undefined;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex items-baseline">
        {"status" in cell ? (
          <StatusMark status={cell.status} />
        ) : (
          <span className="text-wh-fg">{cell.value}</span>
        )}
        {source === undefined ? null : <FootnoteRef number={source} />}
      </span>
      {"paid" in cell && cell.paid ? (
        <span className="text-ui-xs text-wh-muted">
          {cell.paid.status} with {cell.paid.edition}
        </span>
      ) : null}
    </span>
  );
}

const chevron =
  '<path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';

/** One capability: its label, the two marks, and a detail row when there is more to say. */
function MatrixRow({
  row,
  cell,
  product,
  sources,
}: {
  readonly row: ComparisonRow;
  readonly cell: CompetitorCell;
  readonly product: ComparisonProduct;
  readonly sources: readonly SourceReference[];
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const page = row.workhorse.page;
  const hasDetail = Boolean(row.workhorse.note || page || cell.note);

  return (
    <>
      <tr className="wh-cmp-row">
        <th scope="row" className="wh-cmp-label">
          {hasDetail ? (
            <button
              type="button"
              className="wh-cmp-toggle"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={() => setOpen((value) => !value)}
            >
              <span>{row.label}</span>
              <svg
                viewBox="0 0 16 16"
                aria-hidden="true"
                className="wh-cmp-chevron"
                dangerouslySetInnerHTML={{ __html: chevron }}
              />
            </button>
          ) : (
            row.label
          )}
        </th>
        <td className="wh-cmp-cell" data-label="Workhorse">
          <CellMark cell={row.workhorse} />
        </td>
        <td className="wh-cmp-cell" data-label={product.name}>
          <CellMark cell={cell} sources={sources} />
        </td>
      </tr>
      {hasDetail ? (
        <tr id={detailId} className="wh-cmp-detail" hidden={!open}>
          <td colSpan={3}>
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              <div>
                <dt className="wh-mono-label">Workhorse</dt>
                <dd className="mt-1 text-wh-body">
                  {row.workhorse.note ? `${row.workhorse.note} ` : null}
                  {page ? (
                    <a href={page} className="wh-link-underline">
                      Read the Workhorse guide
                    </a>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="wh-mono-label">
                  {product.name} {product.version}
                </dt>
                <dd className="mt-1 text-wh-body">
                  {cell.note ?? cellText(cell)}
                  <FootnoteRef number={sourceNumber(sources, cell.source)} />
                </dd>
              </div>
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** The summary matrix of one product page, one row group for each area. */
function ProductMatrix({ product }: { readonly product: ComparisonProduct }) {
  const sources = productSources(product);
  return (
    <div className="not-prose wh-cmp my-8">
      <table className="wh-cmp-table">
        <caption className="sr-only">
          Workhorse and {product.name} {product.version}, capability by capability
        </caption>
        <thead>
          <tr>
            <th scope="col">Capability</th>
            <th scope="col">Workhorse</th>
            <th scope="col">
              {product.name} <span className="font-mono text-wh-muted">{product.version}</span>
            </th>
          </tr>
        </thead>
        {productGroups(product)
          .filter(({ rows }) => rows.length > 0)
          .map(({ group, rows }) => (
            <tbody key={group.id} id={group.id}>
              <tr className="wh-cmp-group">
                <th scope="rowgroup" colSpan={3}>
                  {group.title}
                </th>
              </tr>
              {rows.map(({ row, cell }) => (
                <MatrixRow key={row.id} row={row} cell={cell} product={product} sources={sources} />
              ))}
            </tbody>
          ))}
      </table>
      <p className="mt-3 text-ui-xs text-wh-muted">
        Open a capability to read its notes. A small number links to the source of the fact, at the
        end of the page.
      </p>
    </div>
  );
}

/** One dot for each product of an approach cell, filled as far as the product supports the capability. */
function ProductDots({ cell }: { readonly cell: ApproachCell }) {
  return (
    <span className="wh-apx-dots" aria-hidden="true">
      {cell.products.map(({ product, mark }) => (
        <span
          key={product.slug}
          className="wh-apx-dot"
          data-mark={mark}
          title={`${product.name}: ${mark}`}
        />
      ))}
    </span>
  );
}

function ApproachMark({ cell }: { readonly cell: ApproachCell }) {
  return (
    <span className="flex flex-col gap-1">
      <StatusMark status={cell.mark} />
      <span className="text-ui-xs text-wh-muted">{approachCount(cell)}</span>
      <ProductDots cell={cell} />
    </span>
  );
}

/**
 * The hub matrix: one row for each capability, one column for Workhorse and
 * one for each category. A category cell counts its products, so a reader
 * sees how far an approach goes, not only one product. The head of each
 * column says what the approach is. Below 1024px the head becomes a list
 * above the rows, and each row stacks into a grid of labelled cells.
 */
const workhorseSummary = `${siteConfig.tagline}. Workers in eight languages use one SQL protocol. No broker or server runs beside the database.`;

function ApproachMatrix() {
  const categories = hubCategories();
  return (
    <div className="not-prose wh-apx my-10">
      <table className="wh-apx-table">
        <caption className="sr-only">
          Workhorse and each approach, capability by capability. An approach counts its products.
        </caption>
        <thead>
          <tr>
            <th scope="col">Capability</th>
            <th scope="col" data-workhorse="">
              <span className="wh-apx-name">Workhorse</span>
              <span className="wh-apx-summary">{workhorseSummary}</span>
            </th>
            {categories.map(({ category, products }) => (
              <th key={category.id} scope="col">
                <span className="wh-apx-name">{category.label}</span>
                <span className="wh-apx-summary">{category.summary}</span>
                <span className="wh-apx-meta">{products.length} products compared</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {approachCapabilities.map((capability) => (
            <tr key={capability.row}>
              <th scope="row">
                <span className="wh-apx-label">{capability.label}</span>
                <span className="wh-apx-rule">{capability.rule}</span>
              </th>
              <td data-workhorse="" data-label="Workhorse">
                <StatusMark status={workhorseMark(capability)} />
              </td>
              {categories.map(({ category, products }) => (
                <td key={category.id} data-label={category.label}>
                  <ApproachMark cell={approachCell(capability, products)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 max-w-3xl text-ui-xs text-wh-muted text-pretty">
        An approach is Supported when every product in it supports the capability in its free
        edition, and Not supported when no product supports it, even in part. A dot is one product.
        Each product page gives its own status and the source of each fact.
      </p>
    </div>
  );
}

/** The hub without `product`, or the matrix of one product page with it. */
export function ComparisonTable({ product }: { readonly product?: string }) {
  return product ? <ProductMatrix product={comparisonProduct(product)} /> : <ApproachMatrix />;
}

/** The numbered sources at the end of a page. */
export function ComparisonSources({ sources }: { readonly sources: readonly SourceReference[] }) {
  return (
    <section aria-labelledby="sources" className="mt-16">
      <h2 id="sources" className="text-ui-m font-semibold text-wh-fg">
        Sources
      </h2>
      <ol className="mt-4 grid gap-1.5 text-ui-xs text-wh-muted">
        {sources.map((source) => (
          <li key={source.url} id={`source-${source.number}`} className="flex gap-3 scroll-mt-24">
            <span className="w-6 shrink-0 text-right font-mono">{source.number}.</span>
            <a href={source.url} className="break-all hover:text-wh-fg" rel="noreferrer noopener">
              {source.url.replace(/^https:\/\//, "")}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
