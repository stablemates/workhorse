import {
  type ComparisonProduct,
  type ComparisonRow,
  cellText,
  checkedLine,
  comparisonProduct,
  comparisons,
  hubRows,
  isPublished,
  productGroups,
  productUrl,
} from "@/lib/comparisons";

/**
 * The comparison tables, rendered from `site/comparisons.json` (ADR 0104).
 *
 * `<ComparisonTable />` renders the hub matrix: one table for each category and
 * one row for each product. `<ComparisonTable product="<slug>" />` renders the
 * table of one product page. No page types a fact by hand, so a page and the
 * hub cannot disagree, and the quarterly check edits one file.
 *
 * `site/scripts/mdx-to-markdown.ts` replaces the tag with the same tables as
 * Markdown for the agent twin.
 */

type Cell = ComparisonRow["workhorse"] | ComparisonProduct["cells"][string];

const cellClass = "wh-rule border-b py-3 pr-6 align-baseline last:pr-0";

function Head({ columns }: { columns: readonly string[] }) {
  return (
    <thead>
      <tr className="wh-rule border-b">
        {columns.map((column) => (
          <th key={column} className="wh-mono-label py-2 pr-6 text-left font-normal last:pr-0">
            {column}
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

function ProductTable({ product }: { product: ComparisonProduct }) {
  return (
    <div className="not-prose mt-6 flex flex-col gap-8 text-[14.5px] leading-relaxed">
      <p className="text-fd-muted-foreground">{checkedLine(product)}</p>
      {productGroups(product)
        .filter(({ rows }) => rows.length > 0)
        .map(({ group, rows }) => (
          <div key={group.id} className="overflow-x-auto">
            <table className="w-full border-collapse">
              <caption className="pb-2 text-left font-semibold">{group.title}</caption>
              <Head columns={["Capability", "Workhorse", `${product.name} ${product.version}`]} />
              <tbody>
                {rows.map(({ row, cell }) => (
                  <tr key={row.id}>
                    <th scope="row" className={`${cellClass} w-1/4 text-left font-normal`}>
                      {row.label}
                    </th>
                    <td className={cellClass}>
                      <CellContent cell={row.workhorse} />
                    </td>
                    <td className={cellClass}>
                      <CellContent cell={cell} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

function HubTable() {
  const columns = hubRows();
  return (
    <div className="not-prose mt-6 flex flex-col gap-10 text-[14px] leading-relaxed">
      {comparisons.categories.map((category) => (
        <section key={category.id}>
          <h3 id={category.id} className="text-lg font-semibold">
            {category.title}
          </h3>
          <p className="mt-2 text-fd-muted-foreground">{category.summary}</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse">
              <Head columns={["Product", ...columns.map((row) => row.label), "Checked"]} />
              <tbody>
                <tr>
                  <th scope="row" className={`${cellClass} text-left font-semibold`}>
                    Workhorse
                  </th>
                  {columns.map((row) => (
                    <td key={row.id} className={cellClass}>
                      <CellContent cell={row.workhorse} />
                    </td>
                  ))}
                  <td className={`${cellClass} text-fd-muted-foreground`}>—</td>
                </tr>
                {comparisons.products
                  .filter((product) => product.category === category.id)
                  .map((product) => (
                    <tr key={product.slug}>
                      <th scope="row" className={`${cellClass} text-left font-normal`}>
                        {isPublished(product) ? (
                          <a href={productUrl(product)} className="wh-link-underline font-semibold">
                            {product.name}
                          </a>
                        ) : (
                          <span className="font-semibold">{product.name}</span>
                        )}
                        <span className="ml-1.5 font-mono text-[12px] text-fd-muted-foreground">
                          {product.version}
                        </span>
                      </th>
                      {columns.map((row) => {
                        const cell = product.cells[row.id];
                        return (
                          <td key={row.id} className={cellClass}>
                            {cell ? <CellContent cell={cell} /> : null}
                          </td>
                        );
                      })}
                      <td className={`${cellClass} whitespace-nowrap`}>
                        <time dateTime={product.checked}>{product.checked}</time>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

/** The hub matrix without `product`, or the table of one product page with it. */
export function ComparisonTable({ product }: { readonly product?: string }) {
  return product ? <ProductTable product={comparisonProduct(product)} /> : <HubTable />;
}
