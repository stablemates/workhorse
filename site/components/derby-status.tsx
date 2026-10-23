import type { derbyStatus } from "@/lib/derby";

/**
 * The status line under the Derby. Only the announcement is live, so a screen
 * reader reads it once at each change. The race clock changes on each tick, so
 * it stays visible next to the announcement but outside the live region. A
 * screen reader reads the clock only when the visitor moves to it.
 */
export function DerbyStatusLine({ status }: { status: ReturnType<typeof derbyStatus> }) {
  const tone = status.won ? "text-safety-600 dark:text-safety-400" : "text-fd-muted-foreground";
  return (
    <span className={`font-mono text-xs ${tone}`}>
      <span role="status" aria-live="polite">
        {status.announcement}
      </span>
      {status.clock ? <span> — {status.clock}</span> : null}
    </span>
  );
}
