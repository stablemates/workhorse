import type { ReactNode } from "react";

/**
 * Section header used across marketing routes: a monospace index label, a
 * tight title, and an optional lede. Consistent rhythm keeps every page in the
 * same typographic system without a bespoke hero per route.
 */
export function SectionHeading({
  index,
  title,
  lede,
}: {
  index: string;
  title: string;
  lede?: ReactNode;
}) {
  return (
    <div className="max-w-3xl">
      <p className="wh-mono-label">{index}</p>
      <h2 className="mt-3 text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
        {title}
      </h2>
      {lede ? (
        <p className="mt-3 text-pretty text-[15px] leading-relaxed text-fd-muted-foreground">
          {lede}
        </p>
      ) : null}
    </div>
  );
}

/** A full-bleed hairline that separates page bands. */
export function Rule({ label }: { label?: string }) {
  if (!label) return <hr className="wh-rule border-t" />;
  return (
    <div className="flex items-center gap-4">
      <hr className="wh-rule w-8 border-t" />
      <span className="wh-mono-label">{label}</span>
      <hr className="wh-rule flex-1 border-t" />
    </div>
  );
}

/**
 * Dense two-column definition row. It intentionally reads like a schema
 * dictionary rather than a marketing feature card.
 */
export function SpecRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="wh-rule grid gap-1.5 border-t px-5 py-4 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-8">
      <div>
        <dt className="font-mono text-[13px] font-medium tracking-tight">{term}</dt>
      </div>
      <dd className="text-[14px] leading-relaxed text-fd-muted-foreground">{children}</dd>
    </div>
  );
}
