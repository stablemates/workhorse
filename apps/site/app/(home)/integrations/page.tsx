import type { Metadata } from "next";
import Link from "next/link";
import { CodeSample } from "@/components/code-sample";
import { SectionHeading } from "@/components/primitives";
import { demoUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: "Integrations",
  description:
    "Workhorse integration packages for Drizzle, Prisma, TypeORM, Kysely, Hono, and the transport-neutral operator dashboard.",
  alternates: { canonical: "/integrations" },
};

const drizzleSample = `import { createDrizzleAdapter } from "@workhorse/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";

const db = drizzle({ client: pool });
const workhorse = createDrizzleAdapter(db);

await db.transaction(async (tx) => {
  await tx.insert(account).values({ id: accountId });
  // Same transaction, same commit boundary, no outbox relay.
  await workhorse.forTransaction(tx).enqueue("account.created", { accountId });
});`;

const kyselySample = `import { createKyselyAdapter } from "@workhorse/kysely";

const workhorse = createKyselyAdapter(database, { notificationPool: pool });

await database.transaction().execute(async (transaction) => {
  const account = await transaction
    .insertInto("account")
    .values({ email })
    .returning("id")
    .executeTakeFirstOrThrow();
  await workhorse.forTransaction(transaction).enqueue("account.created", {
    accountId: account.id,
  });
});`;

const prismaSample = `import { createPrismaAdapter } from "@workhorse/prisma";

const workhorse = createPrismaAdapter(prisma);

await prisma.$transaction(async (tx) => {
  const account = await tx.account.create({ data: { email } });
  await workhorse.forTransaction(tx).enqueue("account.created", {
    accountId: account.id,
  });
});`;

const typeOrmSample = `import { createTypeOrmAdapter } from "@workhorse/typeorm";

const workhorse = createTypeOrmAdapter(dataSource);

await dataSource.transaction(async (manager) => {
  const account = await manager.save(Account, { email });
  await workhorse.forTransaction(manager).enqueue("account.created", {
    accountId: account.id,
  });
});`;

const honoSample = `import { createWorkhorseAdapter } from "@workhorse/core";
import { HonoWorkhorse, type HonoWorkhorseEnv } from "@workhorse/hono";
import { Hono } from "hono";
import type { PoolClient } from "pg";

const runtime = new HonoWorkhorse<PoolClient>(
  createWorkhorseAdapter({ database: pool, adaptTransaction: (client) => client }),
);
const app = new Hono<HonoWorkhorseEnv<PoolClient>>().use(runtime.middleware());

app.post("/invoices", async (c) => {
  // Typed queue access from the request context.
  await c.var.workhorse.queue.enqueue("invoice.capture", await c.req.json());
  return c.body(null, 202);
});`;

const dashboardSample = `import { Dashboard, WorkhorseThemeProvider } from "@workhorse/dashboard";
import "@workhorse/dashboard/styles.css";

// The dashboard never talks to PostgreSQL. You inject a client, so it works
// behind your own auth, your own transport, and your own base path.
export function Operations() {
  return (
    <WorkhorseThemeProvider>
      <Dashboard client={client} basePath="/workhorse" />
    </WorkhorseThemeProvider>
  );
}`;

const packages = [
  {
    name: "@workhorse/drizzle",
    tag: "ORM adapter",
    lede: "Adapts node-postgres Drizzle databases and caller-owned transactions without pulling Drizzle into the core package. Your transaction still owns the commit boundary.",
    sample: drizzleSample,
    file: "drizzle.ts",
    notes: [
      "forTransaction(tx) binds the queue to an existing Drizzle transaction.",
      "Drizzle stays a peer concern: @workhorse/core has no ORM dependency.",
    ],
  },
  {
    name: "@workhorse/prisma",
    tag: "ORM adapter",
    lede: "Adapts Prisma clients and interactive transaction clients while leaving commit and disconnect ownership with the application.",
    sample: prismaSample,
    file: "prisma.ts",
    notes: [
      "forTransaction(tx) binds enqueue to Prisma's interactive transaction.",
      "An optional node-postgres pool enables notification-assisted worker dispatch.",
    ],
  },
  {
    name: "@workhorse/typeorm",
    tag: "ORM adapter",
    lede: "Adapts TypeORM data sources and transactional entity managers without reaching into TypeORM's internal PostgreSQL driver.",
    sample: typeOrmSample,
    file: "typeorm.ts",
    notes: [
      "forTransaction(manager) uses the transaction-scoped entity manager.",
      "An optional node-postgres pool enables notification-assisted worker dispatch.",
    ],
  },
  {
    name: "@workhorse/kysely",
    tag: "Query builder adapter",
    lede: "Adapts Kysely databases and transaction executors through compiled queries while reusing the caller's PostgreSQL dialect pool for notifications.",
    sample: kyselySample,
    file: "kysely.ts",
    notes: [
      "forTransaction(transaction) keeps enqueue on Kysely's transaction connection.",
      "The PostgreSQL dialect pool remains caller-owned and can provide LISTEN connections.",
    ],
  },
  {
    name: "@workhorse/hono",
    tag: "Framework middleware",
    lede: "Exposes the queue through typed middleware, starts configured workers exactly once, and returns a Node server handle whose idempotent shutdown drains handlers and requests before closing provider-owned resources.",
    sample: honoSample,
    file: "server.ts",
    notes: [
      "Workers start once per process, not once per request.",
      "Shutdown is idempotent: stop claims, drain handlers, then drain requests.",
      "Resources you did not hand over are never closed for you.",
    ],
  },
  {
    name: "@workhorse/dashboard",
    tag: "Operator UI",
    lede: "A separately packaged React operator dashboard with an injected, transport-neutral client boundary, package-owned styles and assets, and audited local controls.",
    sample: dashboardSample,
    file: "operations.tsx",
    notes: [
      "Mount it standalone at / or below a namespace such as /workhorse.",
      "It has no database credentials and no implicit authorization.",
      "Destructive controls require the same actor and reason the protocol does.",
    ],
  },
];

export default function IntegrationsPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-14 lg:px-8">
      <p className="wh-mono-label">Integrations</p>
      <h1 className="mt-4 max-w-3xl text-balance text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
        Adapters that keep the commit boundary where you put it.
      </h1>
      <p className="mt-5 max-w-3xl text-pretty text-[16px] leading-relaxed text-fd-muted-foreground">
        Each integration is a separate package so the core protocol keeps one dependency. None of
        them hide the transaction, and none of them add a second place where job state can live.
      </p>

      <div className="mt-14 space-y-16">
        {packages.map((pkg, index) => (
          <section key={pkg.name}>
            <div className="grid gap-10 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] lg:gap-14">
              <div>
                <SectionHeading
                  index={`${String(index + 1).padStart(2, "0")} / ${pkg.tag}`}
                  title={pkg.name}
                  lede={pkg.lede}
                />
                <ul className="mt-6 space-y-2.5">
                  {pkg.notes.map((note) => (
                    <li
                      key={note}
                      className="flex gap-3 text-[13.5px] leading-relaxed text-fd-muted-foreground"
                    >
                      <span aria-hidden className="wh-accent-text mt-px">
                        —
                      </span>
                      {note}
                    </li>
                  ))}
                </ul>
              </div>
              <CodeSample code={pkg.sample} title={pkg.file} meta="server" />
            </div>
          </section>
        ))}
      </div>

      <section className="wh-panel mt-16 rounded-xl p-6 sm:p-8">
        <p className="wh-mono-label">Not yet supported</p>
        <p className="mt-3 max-w-3xl text-[14.5px] leading-relaxed text-fd-muted-foreground">
          Additional framework adapters are out of scope for this release, as are production
          authentication and RBAC, rate limits, and cross-queue concurrency policies. The protocol
          is plain SQL, so another ORM can implement the same provider boundary independently.
        </p>
        <div className="mt-6 flex flex-wrap gap-6">
          <Link href="/reference" className="wh-link-underline text-[14px] font-medium">
            Read the protocol surface
          </Link>
          <a
            href={demoUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="wh-link-underline text-[14px] font-medium"
          >
            See the dashboard running
          </a>
        </div>
      </section>
    </div>
  );
}
