import resolved from "@/.source/integrations.json";
import type { Integration, IntegrationCategory } from "@/lib/integrations";

/**
 * The integration catalog, rendered from `site/integrations.json` after
 * `scripts/gen-docs-index.ts` has resolved every version from a `package.json`.
 *
 * Reading the generated file rather than the catalog keeps the version strings
 * out of anyone's hands: the page cannot disagree with the packages, because
 * nobody types the number that appears here.
 */
interface ResolvedIntegration extends Integration {
  readonly supportedRange?: string;
  readonly testedVersion?: string;
}

const catalog = resolved as {
  categories: readonly IntegrationCategory[];
  integrations: readonly ResolvedIntegration[];
};

/** What proves the entry still works, in the words the tier earns. */
function evidence(entry: ResolvedIntegration): string {
  if (entry.tier === "verified") {
    return `Tested against ${entry.peer} ${entry.testedVersion} on every change`;
  }
  return `Checked by hand on ${entry.verifiedOn}`;
}

function Entry({ entry }: { entry: ResolvedIntegration }) {
  return (
    <div className="wh-rule border-t py-5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <a href={`/docs/${entry.slug}`} className="wh-link-underline text-[15px] font-semibold">
          {entry.name}
        </a>
        <span className="wh-mono-label">{entry.tier}</span>
        {entry.package ? (
          <code className="font-mono text-[12.5px] text-fd-muted-foreground">{entry.package}</code>
        ) : null}
      </div>
      <p className="mt-2 text-[14.5px] leading-relaxed">{entry.summary}</p>
      <p className="mt-1 text-[14.5px] leading-relaxed text-fd-muted-foreground">
        {entry.boundary}
      </p>
      <p className="mt-2 font-mono text-[12px] text-fd-muted-foreground">
        {evidence(entry)}
        {entry.supportedRange ? ` · supports ${entry.supportedRange}` : ""}
      </p>
    </div>
  );
}

export function IntegrationCatalog() {
  return (
    <div className="not-prose mt-8 flex flex-col gap-10">
      {catalog.categories.map((category) => {
        const entries = catalog.integrations.filter((entry) => entry.category === category.id);
        if (entries.length === 0) return null;
        return (
          <section key={category.id}>
            <h2 className="text-[19px] font-semibold tracking-tight">{category.title}</h2>
            <p className="mt-1 text-[14.5px] leading-relaxed text-fd-muted-foreground">
              {category.question}
            </p>
            <div className="mt-4">
              {entries.map((entry) => (
                <Entry key={entry.slug} entry={entry} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
