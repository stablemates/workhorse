// Prisma 7 reads the connection URL for Migrate here, not from prisma/schema.prisma.
// `prisma generate` needs no URL, so the install succeeds when DATABASE_URL_TEST is not set.
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: process.env.DATABASE_URL_TEST },
});
