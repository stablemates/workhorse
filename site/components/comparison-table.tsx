import {
  type ComparisonProduct,
  type ComparisonRow,
  cellText,
  checkedLine,
  comparisonProduct,
  hubCategories,
  hubRows,
  isPublished,
  productGroups,
  productUrl,
} from "@/lib/comparisons";

/**
 * The comparison tables, rendered from `site/comparisons.json` (ADR 0104).
 *
 * `<ComparisonTable />` renders the hub: one collapsible section for each hub
 * row, with one table row for each product, and a table of the versions and the
 * check dates. `<ComparisonTable product="<slug>" />` renders the table of one
 * product page, one collapsible section for each group. No page types a fact by hand, so a page and the
 * hub cannot disagree, and the quarterly check edits one file.
 *
 * A competitor cell states the free edition. If a paid edition reaches a higher
 * status, `cellText` adds it, for example "Partial; Supported with Example Pro",
 * so both tables show the two statuses.
 *
 * `site/scripts/mdx-to-markdown.ts` replaces the tag with the same tables as
 * Markdown for the agent twin.
 *
 * Each section is a native `<details>` element, so it opens without JavaScript
 * and its text is in the static HTML. No table scrolls sideways: a table has a
 * fixed layout, and long words in a cell wrap.
 */

type Cell = ComparisonRow["workhorse"] | ComparisonProduct["cells"][string];

const cellClass = "wh-rule border-b py-3 pr-3 align-baseline break-words last:pr-0";
const tableClass = "w-full table-fixed border-collapse";
/**
 * The docs stylesheet draws each `<details>` as a card, the same as a
 * reference block, and gives each child except the summary a side margin. The
 * table therefore sits in a block wrapper, which takes that margin and keeps
 * the table inside the card.
 */
const detailsClass = "my-3!";

function Head({
  columns,
  className = "",
}: {
  columns: readonly { label: string; width: string }[];
  className?: string;
}) {
  return (
    <thead className={className}>
      <tr className="wh-rule border-b">
        {columns.map((column) => (
          <th
            key={column.label}
            className={`wh-mono-label py-2 pr-3 text-left font-normal tracking-[0.06em] break-words last:pr-0 ${column.width}`}
          >
            {column.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function CellContent({ cell }: { cell: Cell }) {
  const text = cellText(cell);
  const page = "page" in cell ? cell.page : undefined;
  const source = "evidence" in cell ? cell.source : undefined;
  return (
    <>
      {page ? (
        <a href={page} className="wh-link-underline font-semibold">
          {text}
        </a>
      ) : (
        <span className="font-semibold">{text}</span>
      )}
      {cell.note ? <span className="text-fd-muted-foreground">. {cell.note}</span> : null}
      {source ? (
        <a
          href={source}
          className="wh-link-underline ml-1.5 text-[12.5px] text-fd-muted-foreground"
        >
          source
        </a>
      ) : null}
    </>
  );
}

function ProductName({ product }: { product: ComparisonProduct }) {
  return (
    <>
      {isPublished(product) ? (
        <a href={productUrl(product)} className="wh-link-underline font-semibold">
          {product.name}
        </a>
      ) : (
        <span className="font-semibold">{product.name}</span>
      )}
      <span className="ml-1.5 inline-block font-mono text-[12px] whitespace-nowrap text-fd-muted-foreground">
        {product.version}
      </span>
    </>
  );
}

function ProductTable({ product }: { product: ComparisonProduct }) {
  return (
    <div className="not-prose mt-6 text-[14.5px] leading-relaxed">
      <p className="mb-3 text-fd-muted-foreground">{checkedLine(product)}</p>
      {productGroups(product)
        .filter(({ rows }) => rows.length > 0)
        .map(({ group, rows }) => (
          <details key={group.id} id={group.id} open className={detailsClass}>
            <summary>
              {group.title}{" "}
              <span className="font-normal text-fd-muted-foreground">({rows.length})</span>
            </summary>
            <div>
              {/*
               * Below the sm breakpoint, three columns are too narrow. Each row
               * then shows the capability on its own line, and the two cells
               * side by side under a visible label. The text stays the same.
               */}
              <table className={`${tableClass} max-sm:block`}>
                <caption className="sr-only">{group.title}</caption>
                <Head
                  className="max-sm:sr-only"
                  columns={[
                    { label: "Capability", width: "w-[30%]" },
                    { label: "Workhorse", width: "w-[35%]" },
                    { label: `${product.name} ${product.version}`, width: "w-[35%]" },
                  ]}
                />
                <tbody className="max-sm:block">
                  {rows.map(({ row, cell }) => (
                    <tr
                      key={row.id}
                      className="wh-rule max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-3 max-sm:border-b"
                    >
                      <th
                        scope="row"
                        className={`${cellClass} text-left font-normal max-sm:col-span-2 max-sm:border-b-0 max-sm:pb-1 max-sm:font-semibold`}
                      >
                        {row.label}
                      </th>
                      <td className={`${cellClass} max-sm:border-b-0 max-sm:pt-1 max-sm:pr-0`}>
                        <span className="wh-mono-label block tracking-[0.06em] sm:hidden">
                          Workhorse
                        </span>
                        <CellContent cell={row.workhorse} />
                      </td>
                      <td className={`${cellClass} max-sm:border-b-0 max-sm:pt-1`}>
                        <span className="wh-mono-label block tracking-[0.06em] sm:hidden">
                          {product.name}
                        </span>
                        <CellContent cell={cell} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
    </div>
  );
}

/** One section of the hub: one feature, Workhorse first, then each category with its products. */
function HubFeature({ row }: { row: ComparisonRow }) {
  return (
    <details id={row.id} className={detailsClass}>
      <summary>{row.label}</summary>
      <div>
        <table className={tableClass}>
          <caption className="sr-only">{row.label}</caption>
          <Head
            columns={[
              { label: "Product", width: "w-[34%]" },
              { label: row.label, width: "w-[66%]" },
            ]}
          />
          <tbody>
            <tr>
              <th scope="row" className={`${cellClass} text-left font-semibold`}>
                Workhorse
              </th>
              <td className={cellClass}>
                <CellContent cell={row.workhorse} />
              </td>
            </tr>
          </tbody>
          {hubCategories().map(({ category, products }) => (
            <tbody key={category.id}>
              <tr>
                <th
                  colSpan={2}
                  scope="rowgroup"
                  className="wh-mono-label wh-rule border-b pt-5 pb-2 text-left font-normal"
                >
                  {category.title}
                </th>
              </tr>
              {products.map((product) => {
                const cell = product.cells[row.id];
                return (
                  <tr key={product.slug}>
                    <th scope="row" className={`${cellClass} text-left font-normal`}>
                      <ProductName product={product} />
                    </th>
                    <td className={cellClass}>{cell ? <CellContent cell={cell} /> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </details>
  );
}

function HubTable() {
  return (
    <div className="not-prose mt-6 text-[14.5px] leading-relaxed">
      {hubRows().map((row) => (
        <HubFeature key={row.id} row={row} />
      ))}
      {hubCategories().map(({ category, products }) => (
        <section key={category.id} className="mt-10">
          <h3 id={category.id} className="text-lg font-semibold">
            {category.title}
          </h3>
          <p className="mt-2 text-fd-muted-foreground">{category.summary}</p>
          <table className={`${tableClass} mt-4`}>
            <Head
              columns={[
                { label: "Product", width: "w-[50%]" },
                { label: "Version", width: "w-[25%]" },
                { label: "Checked", width: "w-[25%]" },
              ]}
            />
            <tbody>
              {products.map((product) => (
                <tr key={product.slug}>
                  <th scope="row" className={`${cellClass} text-left font-normal`}>
                    {isPublished(product) ? (
                      <a href={productUrl(product)} className="wh-link-underline font-semibold">
                        {product.name}
                      </a>
                    ) : (
                      <span className="font-semibold">{product.name}</span>
                    )}
                  </th>
                  <td className={`${cellClass} font-mono text-[12.5px] whitespace-nowrap`}>
                    {product.version}
                  </td>
                  <td className={cellClass}>
                    <time dateTime={product.checked}>{product.checked}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

/** The hub without `product`, or the table of one product page with it. */
export function ComparisonTable({ product }: { readonly product?: string }) {
  return product ? <ProductTable product={comparisonProduct(product)} /> : <HubTable />;
}
