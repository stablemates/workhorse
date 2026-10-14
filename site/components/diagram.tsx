import { ArrowExpand01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, type MouseEvent } from "react";

/**
 * One diagram that `scripts/diagrams.ts` generates into `public/diagrams/`. The
 * page shows the light or the dark image of the current theme, and the narrow
 * image on a screen up to 600 px wide, as the guide's `<picture>` does.
 *
 * The column is narrower than a wide diagram, and a phone shows the narrow
 * variant. A click opens the wide image of the current theme at full size in a
 * modal dialog. On a small screen the dialog scrolls horizontally.
 */
export function Diagram({ name, alt }: { name: string; alt: string }) {
  const dialog = useRef<HTMLDialogElement>(null);

  // A click on the dialog itself or on the space around the image closes it.
  function closeOutside(event: MouseEvent<HTMLElement>) {
    if (event.target === event.currentTarget) dialog.current?.close();
  }

  return (
    <>
      <button
        type="button"
        className="group relative block w-full cursor-zoom-in text-left"
        aria-label={`Open the diagram at full size: ${alt}`}
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
      >
        {(["light", "dark"] as const).map((theme) => (
          <picture key={theme} className={theme === "light" ? "dark:hidden" : "hidden dark:block"}>
            <source media="(max-width: 600px)" srcSet={`/diagrams/${name}-narrow-${theme}.png`} />
            <img src={`/diagrams/${name}-${theme}.png`} alt={alt} />
          </picture>
        ))}
        <span
          aria-hidden
          className="absolute top-2 right-2 rounded-md border border-fd-border bg-fd-background/90 p-1.5 text-fd-muted-foreground opacity-70 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <HugeiconsIcon icon={ArrowExpand01Icon} size={14} strokeWidth={1.8} />
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
