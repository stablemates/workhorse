import { ArrowExpand01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, type MouseEvent } from "react";

import diagramSizes from "../lib/diagram-sizes.json";

/** The CSS width and height of each generated diagram, keyed by slug. */
const sizes: Record<string, readonly number[] | undefined> = diagramSizes;

function sizeOf(slug: string) {
  const [width, height] = sizes[slug] ?? [];
  if (width === undefined || height === undefined) {
    throw new Error(`No diagram named ${slug}. Run \`pnpm diagrams:generate\`.`);
  }
  return { width, height };
}

/**
 * One diagram that `scripts/diagrams.ts` generates into `public/diagrams/`. The
 * page shows the light or the dark image of the current theme, and the narrow
 * image on a screen up to 600 px wide, as the guide's `<picture>` does.
 *
 * The column is narrower than a wide diagram, and a phone shows the narrow
 * variant. A click opens the wide image of the current theme at full size in a
 * modal dialog. On a small screen the dialog scrolls horizontally.
 *
 * Each image states its width and height, so the page reserves its space before
 * it loads. The images load lazily: the browser does not load the image of the
 * other theme or the images of a closed dialog, because they are not rendered.
 * Set `eager` only on a diagram in the first screen of its page, where a lazy
 * image delays the main content. Then the browser loads both theme images.
 *
 * Set `narrow` to show the narrow image on every screen, at most 520 px wide.
 * Use it for a diagram whose wide image has too much text to read at the
 * width of the column. The dialog still opens the wide image.
 */
export function Diagram({
  name,
  alt,
  eager = false,
  narrow: narrowOnly = false,
}: {
  name: string;
  alt: string;
  eager?: boolean;
  narrow?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const wide = sizeOf(name);
  const narrow = sizeOf(`${name}-narrow`);
  const loading = eager ? "eager" : "lazy";

  // A click on the dialog itself or on the space around the image closes it.
  function closeOutside(event: MouseEvent<HTMLElement>) {
    if (event.target === event.currentTarget) dialog.current?.close();
  }

  return (
    <>
      <button
        type="button"
        className="not-prose group my-8 block w-full cursor-zoom-in text-left"
        aria-label={`Open the diagram at full size: ${alt}`}
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
      >
        {(["light", "dark"] as const).map((theme) => (
          <picture key={theme} className={theme === "light" ? "dark:hidden" : "hidden dark:block"}>
            {narrowOnly ? null : (
              <source
                media="(max-width: 600px)"
                srcSet={`/diagrams/${name}-narrow-${theme}.png`}
                {...narrow}
              />
            )}
            <img
              src={`/diagrams/${name}${narrowOnly ? "-narrow" : ""}-${theme}.png`}
              alt={alt}
              {...(narrowOnly ? narrow : wide)}
              loading={loading}
              decoding="async"
              className={narrowOnly ? "mx-auto h-auto w-full max-w-[520px]" : "h-auto w-full"}
            />
          </picture>
        ))}
        <span
          aria-hidden
          className="mt-2 flex items-center justify-end gap-1.5 font-mono text-xs text-fd-muted-foreground transition-colors group-hover:text-fd-foreground group-focus-visible:text-fd-foreground"
        >
          <HugeiconsIcon icon={ArrowExpand01Icon} size={13} strokeWidth={1.8} />
          Full size
        </span>
      </button>
      <dialog
        ref={dialog}
        aria-label={alt}
        className="wh-diagram-dialog m-0 h-dvh max-h-none w-dvw max-w-none bg-fd-background p-0 text-fd-foreground"
        onClick={closeOutside}
      >
        <div className="h-full overflow-auto" onClick={closeOutside}>
          <div className="flex min-h-full min-w-fit p-4 sm:p-10" onClick={closeOutside}>
            {(["light", "dark"] as const).map((theme) => (
              <img
                key={theme}
                src={`/diagrams/${name}-${theme}.png`}
                alt={alt}
                {...wide}
                loading="lazy"
                decoding="async"
                className={`m-auto h-auto self-center w-[max(960px,min(1920px,calc(100vw_-_5rem)))] max-w-none ${theme === "light" ? "dark:hidden" : "hidden dark:block"}`}
              />
            ))}
          </div>
        </div>
        <button
          type="button"
          className="fixed top-3 right-3 rounded-md border border-fd-border bg-fd-background p-2 text-fd-muted-foreground hover:text-fd-foreground"
          aria-label="Close the diagram"
          onClick={() => dialog.current?.close()}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.8} aria-hidden />
        </button>
      </dialog>
    </>
  );
}
