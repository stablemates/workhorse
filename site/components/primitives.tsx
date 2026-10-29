import { ArrowRight01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

/*
 * The shared links of the marketing pages: a text link with an arrow and a
 * link drawn as a button. The frame of those pages is in `frame.tsx`.
 */

/** A link to another page, with an arrow. An external link opens a new tab. */
export function TextLink({
  href,
  external = false,
  children,
}: {
  href: string;
  external?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className="wh-link"
      {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
    >
      {children}
      <HugeiconsIcon
        icon={external ? ArrowUpRight01Icon : ArrowRight01Icon}
        size={16}
        strokeWidth={1.75}
        aria-hidden
      />
    </a>
  );
}

/**
 * A link drawn as a button of the theme: 12 by 24 px of padding, 14/20 medium
 * text, and an 8 px radius (`.wh-button` in `global.css`). Use one primary and
 * at most one secondary in a group. An external link opens a new tab.
 *
 * Its colors come from the stylesheet, which reads the `dark` class that
 * Fumadocs sets before the first paint, so the prerendered button draws in the
 * right scheme at once.
 */
export function ButtonLink({
  href,
  variant,
  external = false,
  children,
}: {
  href: string;
  variant: "primary" | "secondary";
  external?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={`wh-button wh-button-${variant}`}
      {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
    >
      {children}
      {external ? (
        <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={1.75} aria-hidden />
      ) : null}
    </a>
  );
}
