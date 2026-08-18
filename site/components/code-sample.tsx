import type { ReactNode } from "react";

import landingCode from "@/.source/landing-code.json";
import type { LandingSnippetId } from "@/lib/landing-snippets";

/**
 * Pre-highlighted markup, one entry per snippet in `lib/landing-snippets.ts`,
 * written by `scripts/gen-landing-code.ts`. Rendering finished markup keeps
 * Shiki out of the browser bundle and ships the landing page's code as plain
 * HTML with zero client JavaScript.
 */
const rendered = landingCode as Record<LandingSnippetId, string>;

function Highlighted({ snippet }: { snippet: LandingSnippetId }) {
  // oxlint-disable-next-line react/no-danger -- build-time Shiki output from our own snippet sources.
  return <div dangerouslySetInnerHTML={{ __html: rendered[snippet] }} />;
}

/** A statically highlighted code sample inside the standard code frame. */
export function CodeSample({
  snippet,
  title,
  meta,
}: {
  snippet: LandingSnippetId;
  title?: string;
  meta?: string;
}) {
  return (
    <figure className="wh-frame not-prose">
      {title ? (
        <figcaption className="wh-frame-bar flex items-center justify-between gap-4 px-4 py-2.5">
          <span className="font-mono text-[12px] text-fd-muted-foreground">{title}</span>
          {meta ? <span className="wh-mono-label">{meta}</span> : null}
        </figcaption>
      ) : null}
      <Highlighted snippet={snippet} />
    </figure>
  );
}

export interface CodeTab {
  /** Short switcher label. Doubles as the accessible name of the radio. */
  label: string;
  /** File name shown in the frame bar, so a reader knows where the code lives. */
  file: string;
  snippet: LandingSnippetId;
  /** One line explaining what the snippet proves. Rendered under the frame. */
  note?: ReactNode;
}

/**
 * A tabbed group of code samples.
 *
 * Every panel is highlighted at build time and the switcher is a native radio
 * group styled by `.wh-tabs` in `global.css`, so the whole component ships no
 * client JavaScript and keeps arrow-key navigation for free. `name` must be
 * unique per group on a page, since it is the radio group identity.
 */
export function CodeTabs({
  name,
  tabs,
  meta,
}: {
  name: string;
  tabs: readonly CodeTab[];
  meta?: string;
}) {
  return (
    <div className="wh-tabs wh-frame not-prose">
      {tabs.map((tab, index) => (
        <input
          key={tab.label}
          type="radio"
          id={`${name}-${index}`}
          name={name}
          defaultChecked={index === 0}
          aria-label={tab.label}
        />
      ))}

      <div className="wh-tablist wh-frame-bar flex items-center gap-1 overflow-x-auto px-2 py-2">
        {tabs.map((tab, index) => (
          <label key={tab.label} className="wh-tab" htmlFor={`${name}-${index}`}>
            {tab.label}
          </label>
        ))}
      </div>

      {tabs.map((tab) => (
        <figure key={tab.label} className="wh-tab-panel">
          <figcaption className="wh-rule flex items-center justify-between gap-4 border-b px-4 py-2">
            <span className="font-mono text-[12px] text-fd-muted-foreground">{tab.file}</span>
            {meta ? <span className="wh-mono-label">{meta}</span> : null}
          </figcaption>
          <Highlighted snippet={tab.snippet} />
          {tab.note ? (
            <figcaption className="wh-rule wh-frame-bar border-t px-4 py-2.5 text-[13px] leading-relaxed text-fd-muted-foreground">
              {tab.note}
            </figcaption>
          ) : null}
        </figure>
      ))}
    </div>
  );
}
