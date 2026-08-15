import { access } from "node:fs/promises";
import path from "node:path";

const requiredBuildOutputs = [
  "typescript/core/dist/src/index.js",
  "dashboard/app/dist/library/index.js",
  "typescript/dashboard/dist/index.js",
  "typescript/dashboard-server/dist/index.js",
  "dashboard/app/dist/app/index.html",
  "typescript/dashboard-server/dist/app/index.html",
  "typescript/drizzle/dist/index.js",
  "typescript/kysely/dist/index.js",
  "typescript/prisma/dist/index.js",
  "typescript/typeorm/dist/index.js",
] as const;

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const root = path.resolve(process.argv[2] ?? repositoryRoot);
const missing = (
  await Promise.all(
    requiredBuildOutputs.map(async (output) => {
      try {
        await access(path.join(root, output));
        return undefined;
      } catch {
        return output;
      }
    }),
  )
).filter((output): output is (typeof requiredBuildOutputs)[number] => output !== undefined);

if (missing.length > 0) {
  process.stderr.write(
    [
      "Cannot run pnpm test because runtime build output is missing:",
      ...missing.map((output) => `  - ${output}`),
      "Run `pnpm build:runtime`, then retry `pnpm test`.",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}
