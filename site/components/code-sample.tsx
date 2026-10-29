import type { ReactNode } from "react";

import landingCode from "@/.source/landing-code.json";
import { LanguageLogo, languages, type LanguageId } from "@/components/languages";
import { Tabs } from "@/components/tabs";
import type { LandingSnippetId } from "@/lib/landing-snippets";

/**
 * Pre-highlighted markup, one entry per snippet in `lib/landing-snippets.ts`,
 * written by `scripts/gen-landing-code.ts`. Rendering finished markup keeps
 * Shiki out of the browser bundle and ships the landing page's code as plain
 * HTML with zero client JavaScript.
 */
const rendered = landingCode as Record<LandingSnippetId, string>;

/**
 * Whether `id` names a snippet that `lib/landing-snippets.ts` defines. The
 * check reads the highlighted markup, which has one entry per snippet, so a
 * caller does not pull the snippet sources into the browser bundle.
 */
export function isLandingSnippetId(id: string): id is LandingSnippetId {
  return Object.hasOwn(rendered, id);
}

function Highlighted({ snippet }: { snippet: LandingSnippetId }) {
  // oxlint-disable-next-line react/no-danger -- build-time Shiki output from our own snippet sources.
  return <div dangerouslySetInnerHTML={{ __html: rendered[snippet] }} />;
}

const plainCache = new Map<LandingSnippetId, string>();

/**
 * The code of a snippet without its token markup, still escaped as HTML. The
 * highlighted markup is about six times the size of the code, because each
 * token gets its own element.
 */
function plainMarkup(snippet: LandingSnippetId): string {
  let plain = plainCache.get(snippet);
  if (plain === undefined) {
    plain = rendered[snippet].replace(/<[^>]*>/g, "");
    plainCache.set(snippet, plain);
  }
  return plain;
}

/**
 * The code of a hidden panel, so a search engine and the Markdown twin read
 * every language. The panel gets its highlighted markup when a reader selects it.
 */
function Plain({ snippet }: { snippet: LandingSnippetId }) {
  return (
    <pre>
      {/* oxlint-disable-next-line react/no-danger -- build-time Shiki output from our own snippet sources, without its tags. */}
      <code dangerouslySetInnerHTML={{ __html: plainMarkup(snippet) }} />
    </pre>
  );
}

export interface CodeTab {
  /** The tab label, such as "TypeScript" or "Prisma". It is the accessible name of the tab. */
  label: string;
  /** The language of the code. The Markdown twin names it on the code fence. */
  language: LanguageId;
  /** Show the logo of `language` before the label. Only a language tab does. */
  logo: boolean;
  /** File name shown in the frame bar, so a reader knows where the code lives. */
  file: string;
  snippet: LandingSnippetId;
  /** One line explaining what the snippet proves. Rendered under the frame. */
  note?: ReactNode;
}

/** A tab for a language: its proper name and its logo. */
export function languageTab(
  language: LanguageId,
  file: string,
  snippet: LandingSnippetId,
  note?: ReactNode,
): CodeTab {
  return { label: languages[language].name, language, logo: true, file, snippet, note };
}

/**
 * A tabbed group of code samples.
 *
 * Every panel stays in the markup, hidden when its tab is not selected, so the
 * prerendered page and its Markdown twin (`scripts/gen-landing-twin.ts`) hold
 * every language. Only the selected panel holds the highlighted markup, which
 * keeps a page with many groups small. `name` labels the tab list for
 * assistive technology. A `framed` group sits on its own panel. A `bare` group
 * sits on the surface around it.
 *
 * A language tab points at the logos of `LanguageLogoSprite`, so a page that
 * shows a group renders the sprite once.
 */
export function CodeTabs({
  name,
  tabs,
  meta,
  variant = "framed",
}: {
  name: string;
  tabs: readonly CodeTab[];
  meta?: string;
  variant?: "framed" | "bare";
}) {
  return (
    <Tabs.Root
      variant="pill"
      className={`wh-tabs not-prose ${variant === "framed" ? "wh-frame" : "wh-tabs-bare"}`}
    >
      {(selected) => (
        <>
          <div className="wh-scroll-x p-2">
            <Tabs.List aria-label={`${name} code`} className="w-max">
              {tabs.map((tab, index) => (
                <Tabs.Tab key={tab.label} value={index} data-language={tab.language}>
                  {tab.logo ? <LanguageLogo language={tab.language} /> : null}
                  {tab.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </div>

          {tabs.map((tab, index) => (
            <Tabs.Panel
              key={tab.label}
              value={index}
              keepMounted
              className="wh-tab-panel"
              render={<figure />}
            >
              <figcaption className="flex items-center justify-between gap-4 px-4 pb-1 pt-1">
                <span className="font-mono text-ui-xs text-wh-faint">{tab.file}</span>
                {meta ? <span className="wh-mono-label">{meta}</span> : null}
              </figcaption>
              {index === selected ? (
                <Highlighted snippet={tab.snippet} />
              ) : (
                <Plain snippet={tab.snippet} />
              )}
              {tab.note ? (
                <figcaption className="mx-2 mb-2 rounded-ui-s bg-wh-page px-3 py-2.5 text-ui-s text-wh-muted">
                  {tab.note}
                </figcaption>
              ) : null}
            </Tabs.Panel>
          ))}
        </>
      )}
    </Tabs.Root>
  );
}
