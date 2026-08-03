import type { ReactNode } from "react";
import { highlight } from "fumadocs-core/highlight";

/**
 * Server-rendered, syntax-highlighted code sample.
 *
 * Highlighting runs at build time through Shiki and the result is emitted as
 * plain markup, so marketing pages ship zero client JavaScript for code. The
 * `pre`/`code` overrides drop Fumadocs' interactive code block (which is a
 * client component with a copy button) in favour of static elements.
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
  const rendered = await highlight(code, {
    lang,
    themes: { light: "github-light", dark: "github-dark-dimmed" },
    defaultColor: false,
    components: {
      pre: (props) => (
        <pre
          {...props}
          className="overflow-x-auto px-4 py-4 text-[12.5px] leading-[1.75] [&_code]:font-mono"
        />
      ),
    },
  });

  return (
    <figure className="wh-frame not-prose">
      {title ? (
        <figcaption className="wh-frame-bar flex items-center justify-between gap-4 px-4 py-2.5">
          <span className="font-mono text-[12px] text-fd-muted-foreground">{title}</span>
          {meta ? <span className="wh-mono-label">{meta}</span> : null}
        </figcaption>
      ) : null}
      {rendered as ReactNode}
    </figure>
  );
}
