/**
 * Reading and rewriting `.env` files.
 *
 * Kept apart from worktree-resources.ts so that `with-env.ts`, which runs ahead of every
 * repository command, does not pay to load a PostgreSQL driver it will never use.
 */
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

export async function readEnvironment(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvironment(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
}

// Node's own parser, so a file means what `node --env-file` would make of it: an unquoted `#`
// starts a comment, and quotes end a value before any comment that follows them.
export function parseEnvironment(contents: string): Record<string, string> {
  return parseEnv(contents) as Record<string, string>;
}

export function updateEnvironment(contents: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  const lines = contents ? contents.replace(/\s+$/, "").split(/\r?\n/) : [];
  const updated = lines.map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=).*/);
    if (!match || !remaining.has(match[2]!)) return line;
    const value = remaining.get(match[2]!)!;
    remaining.delete(match[2]!);
    return `${match[1]}${match[2]}${match[3]}${value}`;
  });

  if (updated.length > 0 && remaining.size > 0) updated.push("");
  for (const [key, value] of remaining) updated.push(`${key}=${value}`);
  return `${updated.join("\n")}\n`;
}

export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
