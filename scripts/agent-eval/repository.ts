/**
 * The scratch repository a task E session starts in.
 *
 * SM-704 measures the start point a packaged skill exists for: an agent working inside an
 * application that already depends on the SDK, asked to add a job, and handed no URL. The
 * repository is small and real. It has a `package.json` that depends on `@stablemates/workhorse`
 * and `pg`, one module that inserts the order row the task text describes, and a README that
 * points nowhere. `npm install` runs for real, so `node_modules/@stablemates/workhorse/README.md`
 * is present the way it is in any project that installed the package; that README carries the one
 * router pointer ADR 0049 put there, and whether the session finds it is what the run measures.
 *
 * The files live here as strings rather than as a tracked directory because `tsconfig.scripts.json`
 * typechecks every `.ts` under `scripts/`, and a fixture application is not part of this
 * repository's program.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const repositoryFiles: Readonly<Record<string, string>> = {
  "package.json": `${JSON.stringify(
    {
      name: "orders-app",
      private: true,
      type: "module",
      scripts: { build: "tsc -p tsconfig.json" },
      dependencies: { "@stablemates/workhorse": "^0.1.2", pg: "^8" },
      devDependencies: { "@types/pg": "^8", typescript: "^5" },
    },
    null,
    2,
  )}\n`,
  "tsconfig.json": `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        outDir: "dist",
        rootDir: "src",
      },
      include: ["src"],
    },
    null,
    2,
  )}\n`,
  "README.md": [
    "# orders-app",
    "",
    "An internal service that records orders in PostgreSQL.",
    "",
  ].join("\n"),
  "src/db.ts": [
    'import { Pool } from "pg";',
    "",
    "export const pool = new Pool({ connectionString: process.env.DATABASE_URL });",
    "",
  ].join("\n"),
  "src/orders.ts": [
    'import { pool } from "./db.js";',
    "",
    "export interface NewOrder {",
    "  readonly id: string;",
    "  readonly email: string;",
    "}",
    "",
    "export async function createOrder(order: NewOrder): Promise<void> {",
    '  await pool.query("INSERT INTO orders (id, email, status) VALUES ($1, $2, $3)", [',
    "    order.id,",
    "    order.email,",
    '    "new",',
    "  ]);",
    "}",
    "",
  ].join("\n"),
};

/** The package the repository depends on, which is what the session has to trace to its docs. */
export const repositoryPackage = "@stablemates/workhorse";

function runCommand(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${String(code)}: ${stderr}`));
    });
  });
}

/** Write the repository under `scratch` and install its dependencies. Needs npm and the network. */
export async function prepareRepository(scratch: string): Promise<string> {
  const root = path.join(scratch, "orders-app");
  for (const [name, body] of Object.entries(repositoryFiles)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  await runCommand("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], root);
  return root;
}
