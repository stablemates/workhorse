import type { ReactNode } from "react";
import { highlight } from "fumadocs-core/highlight";

/**
 * Theme pair for every marketing snippet.
 *
 * Both themes are written into the same markup and selected by CSS variables,
 * so they have to be chosen as a pair: `one-light` and `one-dark-pro` share a
 * hue assignment (keywords violet, strings green, types yellow, calls blue),
 * which keeps a snippet legible as the same code in either scheme.
 */
const codeThemes = { light: "one-light", dark: "one-dark-pro" } as const;

async function renderCode(code: string, lang: string) {
  return (await highlight(code, {
    lang,
    themes: codeThemes,
    defaultColor: false,
    components: {
      // Shiki emits per-token colours as `--shiki-light` / `--shiki-dark` custom
      // properties and relies on a `.shiki code span { color: var(--shiki-light) }`
      // rule to apply them. That rule is keyed off the `shiki` class Shiki puts
      // on the `pre`, so the incoming className has to be preserved — replacing
      // it outright renders every token in the inherited foreground colour.
      pre: ({ className, ...props }) => (
        <pre
          {...props}
          className={`${className ?? ""} wh-code-surface overflow-x-auto px-4 py-4 text-[12.5px] leading-[1.75] [&_code]:font-mono`}
        />
      ),
    },
  })) as ReactNode;
}

/**
 * Server-rendered, syntax-highlighted code sample.
 *
 * Highlighting runs at build time through Shiki and the result is emitted as
 * plain markup, so marketing pages ship zero client JavaScript for code. The
 * `pre` override drops Fumadocs' interactive code block (which is a client
 * component with a copy button) in favour of a static element.
 */
export async function CodeSample({
  code,
  lang = "ts",
  title,
  meta,
}: {
  code: string;
  lang?: string;
  title?: string;
  meta?: string;
}) {
  const rendered = await renderCode(code, lang);

  return (
    <figure className="wh-frame not-prose">
      {title ? (
        <figcaption className="wh-frame-bar flex items-center justify-between gap-4 px-4 py-2.5">
          <span className="font-mono text-[12px] text-fd-muted-foreground">{title}</span>
          {meta ? <span className="wh-mono-label">{meta}</span> : null}
        </figcaption>
      ) : null}
      {rendered}
    </figure>
  );
}

export interface CodeTab {
  /** Short switcher label. Doubles as the accessible name of the radio. */
  label: string;
  /** File name shown in the frame bar, so a reader knows where the code lives. */
  file: string;
  code: string;
  lang?: string;
  /** One line explaining what the snippet proves. Rendered under the frame. */
  note?: ReactNode;
}

/**
 * A tabbed group of code samples.
 *
 * Every panel is highlighted on the server and the switcher is a native radio
 * group styled by `.wh-tabs` in `global.css`, so the whole component ships no
 * client JavaScript and keeps arrow-key navigation for free. `name` must be
 * unique per group on a page, since it is the radio group identity.
 */
export async function CodeTabs({
  name,
  tabs,
  meta,
}: {
  name: string;
  tabs: readonly CodeTab[];
  meta?: string;
}) {
  const panels = await Promise.all(tabs.map((tab) => renderCode(tab.code, tab.lang ?? "ts")));

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

      {tabs.map((tab, index) => (
        <figure key={tab.label} className="wh-tab-panel">
          <figcaption className="wh-rule flex items-center justify-between gap-4 border-b px-4 py-2">
            <span className="font-mono text-[12px] text-fd-muted-foreground">{tab.file}</span>
            {meta ? <span className="wh-mono-label">{meta}</span> : null}
          </figcaption>
          {panels[index]}
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
