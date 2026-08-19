import { isMissingDatabaseRelationError } from "@workhorse/core";

export interface SchemaPreparationOperations {
  readVersion(): Promise<number | null>;
  install(): Promise<void>;
  migrate(): Promise<void>;
  installDemo(): Promise<void>;
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
