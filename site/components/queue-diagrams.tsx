import type { ReactNode } from "react";

/*
 * The two line diagrams of the landing page, in one drawing style: solid
 * boxes with one stroke width, sans labels in sentence case, mono text only
 * for code and table names, and one amber path. Both drawings use the same
 * view box and the same rows, so they line up side by side. The colors come
 * from the `.wh-dg` classes in `marketing.css`, so the drawings follow the
 * color scheme. Each claim a diagram makes must match `docs/features.md`.
 */

const width = 440;
const height = 356;

function Svg({ label, children }: { label: string; children: ReactNode }) {
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      className="wh-dg mx-auto h-auto w-full max-w-md"
    >
      {children}
    </svg>
  );
}

function Box({
  x,
  y,
  w,
  h,
  hot = false,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  hot?: boolean;
}) {
  return (
    <rect
      x={x + 0.5}
      y={y + 0.5}
      width={w - 1}
      height={h - 1}
      rx={10}
      className={hot ? "dg-box dg-hot" : "dg-box"}
    />
  );
}

/** A table inside the PostgreSQL box: a filled area with no edge. */
function Well({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return <rect x={x} y={y} width={w} height={h} rx={6} className="dg-well" />;
}

function Label({
  x,
  y,
  children,
  anchor = "start",
  tone = "default",
}: {
  x: number;
  y: number;
  children: string;
  anchor?: "start" | "middle" | "end";
  tone?: "default" | "quiet" | "hot";
}) {
  return (
    <text x={x} y={y} textAnchor={anchor} className={`dg-label dg-label-${tone}`}>
      {children}
    </text>
  );
}

function Code({
  x,
  y,
  children,
  hot = false,
}: {
  x: number;
  y: number;
  children: string;
  hot?: boolean;
}) {
  return (
    <text x={x} y={y} className={hot ? "dg-code dg-hot-text" : "dg-code"}>
      {children}
    </text>
  );
}

function Wire({ d, hot = false }: { d: string; hot?: boolean }) {
  return <path d={d} className={hot ? "dg-wire dg-hot" : "dg-wire"} />;
}

function Dot({ x, y, hot = false }: { x: number; y: number; hot?: boolean }) {
  return <circle cx={x} cy={y} r={3} className={hot ? "dg-dot dg-hot-fill" : "dg-dot"} />;
}

/** A row of rounded placeholders, as a box shows the work inside it. */
function Pills({
  x,
  y,
  count,
  width: pill = 28,
  hot,
}: {
  x: number;
  y: number;
  count: number;
  width?: number;
  hot?: number;
}) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <rect
          key={index}
          x={x + index * (pill + 6)}
          y={y}
          width={pill}
          height={8}
          rx={4}
          className={index === hot ? "dg-hot-fill" : "dg-pill"}
        />
      ))}
    </>
  );
}

function Cylinder({ cx, y }: { cx: number; y: number }) {
  const x = cx - 22;
  return (
    <g>
      <path d={`M${x} ${y + 7} v34 a22 7 0 0 0 44 0 v-34`} className="dg-box" />
      <ellipse cx={cx} cy={y + 7} rx={22} ry={7} className="dg-box" />
    </g>
  );
}

/*
 * The shared grid: the main column spans x 20 to 280 with its center at 150,
 * and the side column is centered at 370. The rows start at y 8, 176, and 284.
 */

/** A typical task queue: the application writes twice, a broker holds the tasks, and workers poll it. */
export function TypicalQueueDiagram() {
  return (
    <Svg label="A typical task queue: the application writes to its database and publishes to a broker, and workers poll the broker and write results to the database.">
      <Box x={20} y={8} w={260} h={96} />
      <Label x={36} y={32}>
        App
      </Label>
      <Code x={36} y={62}>
        db.insert(order)
      </Code>
      <Code x={36} y={84}>
        broker.publish(task)
      </Code>

      {/* The first write goes to the database at the side. */}
      <Wire d="M280 56 H348" />
      <Label x={314} y={48} anchor="middle" tone="quiet">
        Write
      </Label>
      <Label x={370} y={20} anchor="middle">
        Database
      </Label>
      <Cylinder cx={370} y={30} />

      {/* The second write goes to the broker. */}
      <Wire d="M150 104 V176" />
      <Label x={160} y={144} tone="quiet">
        Outbox or dual write
      </Label>

      <Box x={20} y={176} w={260} h={60} />
      <Label x={36} y={200}>
        Broker
      </Label>
      <Pills x={36} y={214} count={6} />

      <Wire d="M150 236 V258 M60 258 H240 M60 258 V284 M150 258 V284 M240 258 V284" />
      <Dot x={150} y={258} />
      <Label x={250} y={252} tone="quiet">
        Poll
      </Label>
      {[60, 150, 240].map((cx) => (
        <g key={cx}>
          <Box x={cx - 40} y={284} w={80} h={56} />
          <Label x={cx - 28} y={306}>
            Worker
          </Label>
          <rect x={cx - 28} y={318} width={56} height={8} rx={4} className="dg-pill" />
        </g>
      ))}

      {/* The workers write their results back to the database. */}
      <Wire d="M280 312 H370 V78" />
      <Label x={380} y={226} tone="quiet">
        Results
      </Label>
    </Svg>
  );
}

/** Workhorse: the application and the workers use one PostgreSQL database, and the task commits with the data. */
export function WorkhorseDiagram() {
  return (
    <Svg label="Workhorse: the application inserts its row and enqueues the task in one PostgreSQL transaction, and workers claim tasks from the same database.">
      <Box x={20} y={8} w={260} h={124} hot />
      <Label x={36} y={32} tone="hot">
        App
      </Label>
      <Code x={36} y={60}>
        BEGIN
      </Code>
      <Code x={36} y={80}>
        insert order
      </Code>
      <Code x={36} y={100} hot>
        {"queue.enqueue(..., { client })"}
      </Code>
      <Code x={36} y={120}>
        COMMIT
      </Code>

      <Box x={320} y={8} w={100} h={124} />
      <Label x={336} y={32}>
        Workers
      </Label>
      {[52, 74, 96].map((y) => (
        <rect key={y} x={336} y={y} width={68} height={8} rx={4} className="dg-pill" />
      ))}

      {/* The one transaction: the application row and the task commit together. */}
      <Wire d="M150 132 V184" hot />
      <Dot x={150} y={132} hot />
      <Label x={160} y={162} tone="hot">
        One transaction
      </Label>

      <Wire d="M370 132 V184" />
      <Label x={360} y={156} anchor="end" tone="quiet">
        Claim with
      </Label>
      <text x={360} y={172} textAnchor="end" className="dg-code">
        SKIP LOCKED
      </text>

      <Box x={20} y={184} w={400} h={156} />
      <Label x={36} y={208}>
        PostgreSQL
      </Label>
      <Well x={36} y={224} w={176} h={100} />
      <Code x={52} y={248}>
        orders
      </Code>
      <Pills x={52} y={266} count={3} width={38} hot={2} />
      <Pills x={52} y={288} count={3} width={38} />
      <Well x={228} y={224} w={176} h={100} />
      <Code x={244} y={248}>
        tasks
      </Code>
      <Pills x={244} y={266} count={3} width={38} hot={0} />
      <Pills x={244} y={288} count={3} width={38} />
      <Wire d="M178 270 H244" hot />
    </Svg>
  );
}
