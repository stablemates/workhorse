import { isMissingDatabaseRelationError } from "@workhorse-js/core";

export interface ApplicationSchemaOperations {
  assertCompatible(): Promise<void>;
  assertDemoCompatible(): Promise<void>;
  install(): Promise<void>;
  installDemo(): Promise<void>;
}

export interface SchemaPreparationOperations {
  readVersion(): Promise<number | null>;
  install(): Promise<void>;
  migrate(): Promise<void>;
  installDemo(): Promise<void>;
}

/** Keep schema writes in development and make production application startup read-only. */
export async function prepareApplicationSchema(
  mode: "development" | "production",
  operations: ApplicationSchemaOperations,
): Promise<void> {
  if (mode === "production") {
    await operations.assertCompatible();
    await operations.assertDemoCompatible();
    return;
  }

  await operations.install();
  await operations.installDemo();
}

/** Prepare both the Workhorse runtime schema and the demo application's own tables. */
export async function prepareSchema(
  operations: SchemaPreparationOperations,
): Promise<"installed" | "migrated"> {
  try {
    await operations.readVersion();
  } catch (error) {
    if (!isMissingDatabaseRelationError(error)) throw error;
    await operations.install();
    await operations.installDemo();
    return "installed";
  }

  await operations.migrate();
  await operations.installDemo();
  return "migrated";
}
