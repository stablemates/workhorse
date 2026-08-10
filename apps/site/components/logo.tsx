import Image from "next/image";

/**
 * Canonical Workhorse brand assets, copied from `@workhorse/dashboard` so the
 * site, the operator dashboard, and the demo all present one identity.
 *
 * The source wordmark artwork is light-on-transparent. The dashboard darkens it
 * for light surfaces with the same filter values reused here, so the mark stays
 * legible in both schemes without shipping a second asset.
 */
export function WorkhorseMark({
  size = 24,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <Image
      src="/brand/workhorse-mark.svg"
      alt=""
      aria-hidden
      width={size}
      height={size}
      priority
      className={className}
    />
  );
}

/**
 * Lockup proportions are tuned against the artwork's own transparent padding.
 * The mark artwork occupies a 360x307 region of its 512x512 view box
 * (70% wide, 60% tall), so its layout box must be far larger than the wordmark
 * before the horse reads as the dominant element. The wordmark artwork, by
 * contrast, is full-bleed 895x53, so every pixel of its height is ink and its
 * width scales at ~16.9x that height.
 *
 * A 40px mark box renders about 28x24px of visible horse and still clears the
 * 56px nav with 8px of breathing room top and bottom. Pairing it with a 9px
 * wordmark (~152px wide) makes the horse about 2.7x the type height, up from
 * 1.7x before, and shrinks the lockup to ~194px so it stays comfortable next to
 * a mobile menu button. The gap is tightened to 2px because the mark's own
 * transparent margin already contributes ~6px of optical spacing at this box
 * size.
 */
export function WorkhorseWordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-0.5 ${className}`}>
      <WorkhorseMark size={40} className="size-[40px] shrink-0" />
      <Image
        src="/brand/workhorse-wordmark.svg"
        alt="Workhorse"
        width={895}
        height={53}
        priority
        className="h-[9px] w-auto brightness-[0.26] contrast-[1.25] dark:brightness-100 dark:contrast-100"
      />
    </span>
  );
}
