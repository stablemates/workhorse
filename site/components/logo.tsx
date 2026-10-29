import markSvg from "../public/brand/workhorse-mark.svg?raw";

/**
 * Canonical Workhorse brand assets. The dashboard ships copies of the same two
 * files, so the site, the operator dashboard, and the demo present one identity.
 *
 * The mark draws the head in `currentColor` and the mane in the theme amber.
 * The wordmark is single-colour artwork in `currentColor`. Both are inlined
 * rather than loaded through `<img>`, because an image cannot inherit the
 * surrounding text colour, and inlining is what lets one asset follow the
 * light and dark themes.
 */
export function WorkhorseMark({
  size = 24,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={`inline-block shrink-0 *:block *:size-full ${className}`}
      dangerouslySetInnerHTML={{ __html: markSvg }}
    />
  );
}
