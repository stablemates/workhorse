import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const orders = pgTable(
  "ironshift_demo_order",
  {
    id: uuid().primaryKey(),
    customerEmail: text("customer_email").notNull(),
    description: text().notNull(),
    status: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [index("ironshift_demo_order_created_at_idx").on(table.createdAt)],
);
