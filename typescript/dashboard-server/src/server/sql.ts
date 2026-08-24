import type { Queryable } from "@stablemates/workhorse";

export interface DashboardSql {
  readonly text: string;
  readonly values: readonly unknown[];
}

function isDashboardSql(value: unknown): value is DashboardSql {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "string" &&
    "values" in value &&
    Array.isArray(value.values)
  );
}

function appendFragment(parts: string[], values: unknown[], fragment: DashboardSql): void {
  parts.push(
    fragment.text.replaceAll(/\$(\d+)/g, (_, index: string) => `$${values.length + Number(index)}`),
  );
  values.push(...fragment.values);
}

interface DashboardSqlTag {
  (strings: TemplateStringsArray, ...parameters: unknown[]): DashboardSql;
  join(fragments: readonly DashboardSql[], separator: DashboardSql): DashboardSql;
}

export const sql: DashboardSqlTag = Object.assign(
  (strings: TemplateStringsArray, ...parameters: unknown[]): DashboardSql => {
    const parts: string[] = [];
    const values: unknown[] = [];
    for (const [index, text] of strings.entries()) {
      parts.push(text);
      if (index >= parameters.length) continue;
      const parameter = parameters[index];
      if (isDashboardSql(parameter)) appendFragment(parts, values, parameter);
      else {
        values.push(parameter);
        parts.push(`$${values.length}`);
      }
    }
    return { text: parts.join(""), values };
  },
  {
    join(fragments: readonly DashboardSql[], separator: DashboardSql): DashboardSql {
      const parts: string[] = [];
      const values: unknown[] = [];
      for (const [index, fragment] of fragments.entries()) {
        if (index > 0) appendFragment(parts, values, separator);
        appendFragment(parts, values, fragment);
      }
      return { text: parts.join(""), values };
    },
  },
);

export interface DashboardDatabase {
  execute<Row extends Record<string, unknown>>(query: DashboardSql): Promise<{ rows: Row[] }>;
}

export function dashboardDatabase(database: Queryable): DashboardDatabase {
  return {
    async execute<Row extends Record<string, unknown>>(query: DashboardSql) {
      const result = await database.query<Row>(query.text, query.values);
      return { rows: result.rows };
    },
  };
}
