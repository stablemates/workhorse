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
      src="/brand/workhorse-mark.png"
      alt=""
      aria-hidden
      width={size}
      height={size}
      priority
      className={className}
    />
  );
}

export function WorkhorseWordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <WorkhorseMark size={26} className="size-[26px]" />
      <Image
        src="/brand/workhorse-wordmark.png"
        alt="Workhorse"
        width={895}
        height={53}
        priority
        className="h-[15px] w-auto brightness-[0.26] contrast-[1.25] dark:brightness-100 dark:contrast-100"
      />
    </span>
  );
}
