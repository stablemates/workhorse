import { CodeTabs } from "@/components/code-sample";
import { snippetTabs } from "@/components/feature-tour";
import { TextLink } from "@/components/primitives";
import { Tabs } from "@/components/tabs";
import type { LandingFeatureSnippetId } from "@/lib/landing-snippets";

/*
 * The five pillars of Workhorse on one surface. A row of tabs names the
 * pillars. Selecting one switches the panel below the row: the verified
 * snippet of the pillar in every SDK, and beside it a trace card, the
 * execution journal, that shows what the task did. Every journal row names a
 * call in its snippet, and every note restates `docs/features.md`.
 *
 * From 1024 px the code and the journal sit side by side. Every line of every
 * pillar snippet has 74 columns or fewer, so the code never scrolls sideways
 * at a desktop width. Below 1024 px the journal goes under the code.
 *
 * Every panel keeps its code in every language in the markup, so a search
 * engine and the Markdown twin read all of it. `CodeTabs` highlights only the
 * selected language of each panel.
 *
 * The selected pillar is a sheet in the page color that slides along the
 * row and opens into the panel under it (`.wh-pillars` in `marketing.css`).
 */

/**
 * One bar segment on the time line of a journal row, in percent of the line.
 * `failed` and `held` are the amber segments: a failed attempt, and a wait
 * that holds no worker slot.
 */
interface Segment {
  start: number;
  end: number;
  tone: "run" | "replay" | "wait" | "failed" | "held";
}

interface JournalRow {
  call: string;
  /** One or two words for the row, in the tone of its last segment. */
  status: string;
  segments: readonly Segment[];
  note?: string;
}

interface Pillar {
  id: string;
  label: string;
  title: string;
  snippet: LandingFeatureSnippetId;
  file: string;
  href: string;
  linkLabel: string;
  journal: { task: string; rows: readonly JournalRow[] };
}

const pillars: readonly Pillar[] = [
  {
    id: "retries",
    label: "Checkpoints",
    title: "Code that survives a crash",
    snippet: "checkpoints",
    file: "invoice.ts",
    href: "/docs/durable-execution",
    linkLabel: "Durable execution",
    journal: {
      task: "invoice.issue",
      rows: [
        {
          call: 'checkpoint("charge")',
          status: "Stored",
          segments: [{ start: 0, end: 16, tone: "run" }],
        },
        {
          call: 'checkpoint("render")',
          status: "Crashed",
          segments: [{ start: 18, end: 34, tone: "failed" }],
          note: "Worker crashed · retrying",
        },
        {
          call: 'checkpoint("charge")',
          status: "Replayed",
          segments: [{ start: 50, end: 53, tone: "replay" }],
          note: "Stored result, no second charge",
        },
        {
          call: 'checkpoint("render")',
          status: "Stored",
          segments: [{ start: 54, end: 72, tone: "run" }],
        },
        { call: "sendEmail(...)", status: "Sent", segments: [{ start: 74, end: 88, tone: "run" }] },
      ],
    },
  },
  {
    id: "schedules",
    label: "Schedules",
    title: "Cron with no scheduler process",
    snippet: "schedules",
    file: "deploy.ts",
    href: "/docs/schedules",
    linkLabel: "Schedules",
    journal: {
      task: "nightly-invoice-run",
      rows: [
        {
          call: 'syncSchedules("billing")',
          status: "Synced",
          segments: [{ start: 0, end: 8, tone: "run" }],
        },
        {
          call: "worker 1 · fire 0 2 * * *",
          status: "Fired",
          segments: [{ start: 30, end: 34, tone: "run" }],
        },
        {
          call: "worker 2 · fire 0 2 * * *",
          status: "Skipped",
          segments: [{ start: 30, end: 34, tone: "held" }],
          note: "Same second · no duplicate task",
        },
        {
          call: "invoices.generate",
          status: "Ran",
          segments: [{ start: 36, end: 70, tone: "run" }],
        },
      ],
    },
  },
  {
    id: "flow-control",
    label: "Flow control",
    title: "Limits that bind the whole fleet",
    snippet: "flowControl",
    file: "policies.ts",
    href: "/docs/concurrency-policies",
    linkLabel: "Concurrency policies",
    journal: {
      task: "mail.send",
      rows: [
        { call: "tenant:a", status: "Ran", segments: [{ start: 0, end: 42, tone: "run" }] },
        { call: "tenant:a", status: "Ran", segments: [{ start: 4, end: 48, tone: "run" }] },
        {
          call: "tenant:a",
          status: "Waited",
          segments: [
            { start: 8, end: 42, tone: "held" },
            { start: 43, end: 80, tone: "run" },
          ],
          note: "maxActivePerKey: 2 · waits for a slot",
        },
        { call: "tenant:b", status: "Ran", segments: [{ start: 10, end: 40, tone: "run" }] },
      ],
    },
  },
  {
    id: "waits",
    label: "Signals and waits",
    title: "Wait for days, hold no worker",
    snippet: "externalWaits",
    file: "approval.ts",
    href: "/docs/signals",
    linkLabel: "Signals and human waits",
    journal: {
      task: "release.publish",
      rows: [
        {
          call: 'waitForSignal("security-scan")',
          status: "Received",
          segments: [
            { start: 0, end: 4, tone: "run" },
            { start: 4, end: 36, tone: "wait" },
          ],
        },
        {
          call: 'sendSignal("security-scan")',
          status: "Sent",
          segments: [{ start: 36, end: 40, tone: "run" }],
        },
        {
          call: 'waitForHuman("release-approval")',
          status: "Approved",
          segments: [
            { start: 40, end: 44, tone: "run" },
            { start: 44, end: 84, tone: "held" },
          ],
          note: "Lease released · no worker slot held",
        },
        {
          call: "return { published }",
          status: "Returned",
          segments: [{ start: 84, end: 90, tone: "run" }],
        },
      ],
    },
  },
  {
    id: "dependencies",
    label: "Dependencies",
    title: "Release work when its inputs settle",
    snippet: "dependencies",
    file: "checkout.ts",
    href: "/docs/task-dependencies",
    linkLabel: "Dependencies and child tasks",
    journal: {
      task: "order.fulfill",
      rows: [
        {
          call: "inventory.reserve",
          status: "Succeeded",
          segments: [{ start: 0, end: 24, tone: "run" }],
        },
        {
          call: "order.confirm",
          status: "Released",
          segments: [
            { start: 0, end: 24, tone: "wait" },
            { start: 25, end: 40, tone: "run" },
          ],
        },
        {
          call: 'runChild("charge")',
          status: "Retried",
          segments: [
            { start: 42, end: 54, tone: "failed" },
            { start: 62, end: 78, tone: "run" },
          ],
          note: "payment.capture failed · retrying",
        },
        {
          call: "order.fulfill",
          status: "Succeeded",
          segments: [
            { start: 40, end: 42, tone: "run" },
            { start: 42, end: 78, tone: "wait" },
            { start: 78, end: 84, tone: "run" },
          ],
        },
      ],
    },
  },
];

/** What each bar tone means, in the order the legend lists them. */
const legend = [
  { tone: "run", text: "Runs" },
  { tone: "replay", text: "Replays a stored result" },
  { tone: "wait", text: "Waits" },
  { tone: "failed", text: "Fails" },
  { tone: "held", text: "Waits with no worker slot" },
] as const satisfies readonly { tone: Segment["tone"]; text: string }[];

/** The tones that one journal uses, so its legend lists only those. */
function tonesOf(journal: Pillar["journal"]): ReadonlySet<Segment["tone"]> {
  return new Set(journal.rows.flatMap((row) => row.segments.map((segment) => segment.tone)));
}

function Journal({ journal }: { journal: Pillar["journal"] }) {
  const tones = tonesOf(journal);
  return (
    <figure className="flex min-w-0 flex-col">
      <figcaption className="flex items-baseline justify-between gap-3 pb-4">
        <span className="font-mono text-ui-s font-medium text-wh-fg">{journal.task}</span>
        <span className="text-ui-xs text-wh-muted">Execution journal</span>
      </figcaption>
      <ol className="flex flex-col gap-3.5">
        {journal.rows.map((row, index) => {
          const last = row.segments.at(-1);
          return (
            <li key={`${row.call}-${index}`} className="wh-journal-row">
              <span className="wh-journal-step">{index + 1}</span>
              <span className="wh-journal-call">{row.call}</span>
              <span className="wh-journal-status" data-tone={last?.tone}>
                {row.status}
              </span>
              <div aria-hidden className="wh-journal-track">
                {row.segments.map((segment) => (
                  <span
                    key={segment.start}
                    className="wh-journal-bar"
                    data-tone={segment.tone}
                    style={{
                      insetInlineStart: `${segment.start}%`,
                      inlineSize: `${segment.end - segment.start}%`,
                    }}
                  />
                ))}
              </div>
              {row.note ? <p className="wh-journal-note">{row.note}</p> : null}
            </li>
          );
        })}
      </ol>
      <ul
        aria-hidden
        className="mt-5 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-wh-line pt-4 text-ui-xs text-wh-muted"
      >
        {legend
          .filter((item) => tones.has(item.tone))
          .map((item) => (
            <li key={item.tone} className="flex items-center gap-1.5">
              <span className="wh-journal-bar wh-journal-key" data-tone={item.tone} />
              {item.text}
            </li>
          ))}
      </ul>
    </figure>
  );
}

/** The row of pillar tabs and the panel of the selected pillar. */
export function Pillars() {
  return (
    <Tabs.Root variant="cards" className="wh-pillars">
      {() => (
        <>
          <Tabs.List
            aria-label="Workhorse pillars"
            className="wh-scroll-x flex snap-x lg:grid lg:grid-cols-5"
          >
            {pillars.map((pillar, index) => (
              <Tabs.Tab
                key={pillar.id}
                value={index}
                className="wh-pillar-tab flex w-52 shrink-0 snap-start flex-col items-start gap-1.5 px-5 pb-5 pt-4 text-left lg:w-auto"
              >
                <span className="wh-pillar-label text-ui-xs font-medium">{pillar.label}</span>
                <span className="wh-pillar-title text-pretty text-ui-s font-medium">
                  {pillar.title}
                </span>
              </Tabs.Tab>
            ))}
          </Tabs.List>

          {pillars.map((pillar, index) => (
            <Tabs.Panel key={pillar.id} value={index} keepMounted className="wh-pillar-panel">
              <div className="wh-pillar-code min-w-0 border-b border-wh-line p-2 sm:p-3">
                <CodeTabs
                  name={pillar.label}
                  tabs={snippetTabs(pillar.snippet, pillar.file)}
                  variant="bare"
                />
              </div>
              <div className="flex min-w-0 flex-col gap-6 p-5 sm:p-6">
                <Journal journal={pillar.journal} />
                <p className="mt-auto">
                  <TextLink href={pillar.href}>{pillar.linkLabel}</TextLink>
                </p>
              </div>
            </Tabs.Panel>
          ))}
        </>
      )}
    </Tabs.Root>
  );
}
