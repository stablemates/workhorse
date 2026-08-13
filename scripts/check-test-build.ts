import { access } from "node:fs/promises";
import path from "node:path";

const requiredBuildOutputs = [
  "dist/src/index.js",
  "packages/dashboard/dist/index.js",
  "packages/dashboard/dist/app/index.html",
  "packages/drizzle/dist/index.js",
  "packages/kysely/dist/index.js",
  "packages/prisma/dist/index.js",
  "packages/typeorm/dist/index.js",
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
