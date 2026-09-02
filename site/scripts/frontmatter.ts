/**
 * Reads MDX frontmatter without a YAML parser. A page's frontmatter is flat
 * `key: value` lines, and the build needs only the few keys it prints, so a
 * line match is enough and keeps the generator free of a parser dependency.
 */

const block = /^---\r?\n([\s\S]*?)\r?\n---/;

/** The value of `key` in the frontmatter of `source`, with quotes removed. */
export function frontmatterValue(source: string, key: string): string | undefined {
  const match = block.exec(source);
  if (!match?.[1]) return undefined;
  const line = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(match[1]);
  if (!line?.[1]) return undefined;
  return line[1].trim().replace(/^["']|["']$/g, "");
}

/** The body of `source` with its frontmatter removed and leading blank lines dropped. */
export function stripFrontmatter(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trimStart();
}
