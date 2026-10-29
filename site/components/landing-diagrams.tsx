import type { ReactNode } from "react";

/*
 * Static concept diagrams for the features page. A feature group shows one
 * diagram or one code sample. Pure HTML and CSS: like the code samples, they
 * ship no client JavaScript. Every identifier a diagram names must appear in
 * the matching snippet in `lib/landing-snippets.ts`, which is itself verified
 * against the API surface.
 *
 * They use the drawing style of `components/queue-diagrams.tsx`: a hairline
 * frame on the page color, sans labels in sentence case, mono text only for
 * code, thin connectors, and one element in amber. The colors are scoped to
 * the frame as `--dg-*` variables. The one element each diagram is about takes
 * `--dg-accent`, the amber key color. A finished element is the lighter
 * `--dg-line` or `--dg-mark` step, so it stays apart from the accent. Small text uses `--dg-muted` or `--dg-soft`,
 * which keep 4.5:1 contrast on the page. `--dg-mark` is for marks that are
 * not text.
 */

/** Shared hairline frame so all diagrams read as one family. */
function Diagram({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-ui-m border border-(--dg-hair) text-(--dg-ink) [--dg-accent:#cf9148] [--dg-fill:#f4f4f4] [--dg-hair:#e7e7e7] [--dg-ink:#000000] [--dg-line:#cdcdcd] [--dg-mark:#7d7d7d] [--dg-muted:#555555] [--dg-soft:#555555] dark:[--dg-accent:#cf9148] dark:[--dg-fill:#2b2b2b] dark:[--dg-hair:#3d3d3d] dark:[--dg-ink:#f4f4f4] dark:[--dg-line:#565656] dark:[--dg-mark:#838383] dark:[--dg-muted:#ababab] dark:[--dg-soft:#ababab]">
      <p className="px-4 pt-3.5 text-ui-xs font-medium text-(--dg-soft) sm:px-5">{label}</p>
      {/* A narrow screen scrolls the drawing sideways, so a keyboard user can focus the region. */}
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="overflow-x-auto px-4 pt-3 pb-4 sm:px-5"
      >
        {children}
      </div>
    </div>
  );
}

/** A secondary caption under or beside a diagram element. */
const caption = "text-ui-xs text-(--dg-muted)";

/* Chips are filled, not outlined. Only a ghost chip, a step that never runs, keeps a dashed edge. */
const chipTone = {
  line: "bg-(--dg-fill)",
  ghost: "border border-dashed border-(--dg-line) text-(--dg-muted)",
} as const;

function Chip({ tone = "line", children }: { tone?: keyof typeof chipTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-ui-s px-2.5 py-1.5 text-ui-s leading-none ${chipTone[tone]}`}
    >
      {children}
    </span>
  );
}

/** A horizontal hairline connector between chips. */
function Wire({ className = "w-5" }: { className?: string }) {
  return <span aria-hidden className={`h-px shrink-0 border-t border-(--dg-line) ${className}`} />;
}

/* ---------- Retries and deadlines ---------- */

export function RetriesDiagram() {
  return (
    <Diagram label="Exponential backoff, bounded twice">
      <div className="flex items-center">
        <Chip>try 1</Chip>
        <Wire className="w-3" />
        <Chip>+1s</Chip>
        <Wire className="w-6" />
        <Chip>+2s</Chip>
        <Wire className="w-12" />
        <Chip>+4s</Chip>
        <Wire className="w-5" />
        <span
          aria-hidden
          className="mx-2 h-8 w-0.5 shrink-0 rounded-full bg-(--dg-accent)"
          title="deadline"
        />
        <div className="flex flex-col gap-1">
          <span className="text-ui-xs leading-none text-(--dg-soft)">deadline: kickoff</span>
          <Chip tone="ghost">remaining attempts never run</Chip>
        </div>
      </div>
    </Diagram>
  );
}

/* ---------- Flow control ---------- */

/** A slot inside a tenant's cap: filled while a task is active. */
function Slot({ tone = "off" }: { tone?: "focus" | "done" | "off" }) {
  const fill = {
    focus: "bg-(--dg-accent)",
    done: "bg-(--dg-mark)",
    off: "border border-(--dg-line)",
  }[tone];
  return <span aria-hidden className={`h-3.5 w-7 rounded-ui-xs ${fill}`} />;
}

/** A task waiting on the queue side of the admission gate. */
function WaitingDot() {
  return <span aria-hidden className="size-2.5 shrink-0 rounded-full border border-(--dg-mark)" />;
}

/**
 * The admission gate, drawn as one vertical rule: tasks queue on the left, the
 * per-key slots sit on the right, and nothing crosses while the key's slots
 * are full. Rows keep zero vertical gap so the gate is unbroken.
 */
export function FlowControlDiagram() {
  const gate = "border-l border-(--dg-line) pl-4";
  const heading = "pb-2 text-ui-xs leading-none text-(--dg-soft)";
  return (
    <Diagram label='Queue "mail" with maxActivePerKey: 2'>
      <div className="min-w-[30rem]">
        <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,15rem)] items-center">
          <span />
          <span className={`${heading} pr-4 text-right`}>waiting</span>
          <span className={`${heading} ${gate}`}>active, cap 2</span>

          <span className="py-2 font-mono text-ui-s tracking-tight">tenant:acme</span>
          <span className="flex items-center justify-end gap-1.5 py-2 pr-4">
            <WaitingDot />
            <WaitingDot />
          </span>
          <span className={`flex items-center gap-1.5 py-2 ${gate}`}>
            <Slot tone="focus" />
            <Slot tone="focus" />
            <span className={`pl-1.5 ${caption}`}>full, so two tasks wait</span>
          </span>

          <span className="py-2 font-mono text-ui-s tracking-tight">tenant:bloom</span>
          <span className="py-2 pr-4" />
          <span className={`flex items-center gap-1.5 py-2 ${gate}`}>
            <Slot tone="done" />
            <Slot />
            <span className={`pl-1.5 ${caption}`}>room for one more</span>
          </span>
        </div>

        <div className="mt-3 flex items-center gap-4 border-t border-(--dg-hair) pt-3.5">
          <span className="w-[6.5rem] shrink-0 font-mono text-ui-s tracking-tight">
            provider-api
          </span>
          <span aria-hidden className="flex h-2 w-44 overflow-hidden rounded-full">
            <span className="flex-1 bg-(--dg-ink)" />
            <span className="flex-1 bg-(--dg-line)" />
          </span>
          <span className={caption}>100 per second, bursting to 200</span>
        </div>
      </div>
    </Diagram>
  );
}
