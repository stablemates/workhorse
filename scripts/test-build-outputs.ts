export const requiredTestBuildOutputs = [
  "typescript/core/dist/src/index.js",
  "dashboard/app/dist/library/index.js",
  "typescript/dashboard/dist/index.js",
  "typescript/dashboard/development/browser/index.html",
  "typescript/dashboard/development/src/browser.tsx",
  "typescript/dashboard-server/dist/index.js",
  "dashboard/app/dist/app/index.html",
  "typescript/dashboard-server/dist/app/index.html",
  "typescript/drizzle/dist/index.js",
  "typescript/kysely/dist/index.js",
  "typescript/prisma/dist/index.js",
  "typescript/typeorm/dist/index.js",
] as const;

/** Complete artifacts reused by smoke checks after the full-build fingerprint passes. */
export const fullBuildOutputDirectories = [
  ...new Set(
    requiredTestBuildOutputs
      .filter((file) => file.includes("/dist/"))
      .map((file) => file.split("/dist/")[0] + "/dist"),
  ),
  "typescript/dashboard/development",
  "typescript/demo/dist",
  "typescript/otel/dist",
  "site/dist",
  "python/dist",
  "dashboard/v1/bundle",
];
