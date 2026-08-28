import { createHash } from "node:crypto";

const schemaTemplatePrefix = "workhorse_test_template_";

export function schemaTemplateName(schema: Buffer, now = new Date()): string {
  const schemaDigest = createHash("sha256").update(schema).digest("hex").slice(0, 16);
  const utcDay = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `${schemaTemplatePrefix}${schemaDigest}_${utcDay}`;
}
