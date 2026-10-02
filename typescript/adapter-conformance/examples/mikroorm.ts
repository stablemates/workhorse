import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineEntity, p } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { createKyselyAdapter } from "@stablemates/workhorse-kysely";

export const MikroOrder = defineEntity({
  name: "MikroOrder",
  tableName: "mikro_order",
  schema: "public",
  properties: {
    id: p.integer().primary().autoincrement(),
    reference: p.string().unique(),
  },
});

export function createMikroOrm(databaseUrl: string) {
  return MikroORM.init({
    clientUrl: databaseUrl,
    entities: [MikroOrder],
    driverOptions: { options: "-c search_path=public" },
    pool: { min: 0, max: 2 },
  });
}

export async function acceptMikroOrder(orm: MikroORM, reference: string) {
  const workhorse = createKyselyAdapter(orm.em.fork().getKysely());
  return orm.em.fork().transactional(async (transactionalEm) => {
    const order = transactionalEm.create(MikroOrder, { reference });
    await transactionalEm.flush();
    const executor = transactionalEm.getKysely();
    const taskId = await workhorse.forTransaction(executor).enqueue("order.accepted", {
      orderId: order.id,
    });
    return { orderId: order.id, taskId };
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (import.meta.url === invokedPath) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required; use a disposable example database");
  const orm = await createMikroOrm(databaseUrl);
  try {
    await orm.schema.create();
    process.stdout.write(`${JSON.stringify(await acceptMikroOrder(orm, "example-order"))}\n`);
  } finally {
    await orm.close();
  }
}
