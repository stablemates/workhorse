import { describe, expect, it, vi } from "vitest";
import {
  prepareApplicationSchema,
  prepareSchema,
  type ApplicationSchemaOperations,
  type SchemaPreparationOperations,
} from "./schema-preparation.js";

function operations(
  overrides: Partial<SchemaPreparationOperations> = {},
): SchemaPreparationOperations {
  return {
    readVersion: vi.fn<SchemaPreparationOperations["readVersion"]>().mockResolvedValue(47),
    install: vi.fn<SchemaPreparationOperations["install"]>().mockResolvedValue(undefined),
    migrate: vi.fn<SchemaPreparationOperations["migrate"]>().mockResolvedValue(undefined),
    installDemo: vi.fn<SchemaPreparationOperations["installDemo"]>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function applicationOperations(
  calls: string[],
  overrides: Partial<ApplicationSchemaOperations> = {},
): ApplicationSchemaOperations {
  return {
    assertCompatible: vi.fn<ApplicationSchemaOperations["assertCompatible"]>(async () => {
      calls.push("assert-core");
    }),
    assertDemoCompatible: vi.fn<ApplicationSchemaOperations["assertDemoCompatible"]>(async () => {
      calls.push("assert-demo");
    }),
    install: vi.fn<ApplicationSchemaOperations["install"]>(async () => {
      calls.push("install-core");
    }),
    installDemo: vi.fn<ApplicationSchemaOperations["installDemo"]>(async () => {
      calls.push("install-demo");
    }),
    ...overrides,
  };
}

describe("demo schema preparation", () => {
  it("validates production schemas without running installers", async () => {
    const calls: string[] = [];
    const subject = applicationOperations(calls);

    await prepareApplicationSchema("production", subject);

    expect(calls).toEqual(["assert-core", "assert-demo"]);
  });

  it("leaves an already-current Workhorse schema unchanged during development", async () => {
    const calls: string[] = [];
    const subject = applicationOperations(calls);

    await prepareApplicationSchema("development", subject);

    expect(calls).toEqual(["assert-core", "install-demo"]);
  });

  it.each(["3F000", "42P01"])(
    "installs a missing Workhorse schema after PostgreSQL error %s",
    async (code) => {
      const calls: string[] = [];
      const subject = applicationOperations(calls, {
        assertCompatible: vi.fn<ApplicationSchemaOperations["assertCompatible"]>(async () => {
          calls.push("assert-core");
          throw Object.assign(new Error("missing schema"), { code });
        }),
      });

      await prepareApplicationSchema("development", subject);

      expect(calls).toEqual(["assert-core", "install-core", "install-demo"]);
    },
  );

  it("does not install over an incompatible development schema", async () => {
    const error = new Error("incompatible schema version");
    const calls: string[] = [];
    const subject = applicationOperations(calls, {
      assertCompatible: vi.fn<ApplicationSchemaOperations["assertCompatible"]>(async () => {
        calls.push("assert-core");
        throw error;
      }),
    });

    await expect(prepareApplicationSchema("development", subject)).rejects.toBe(error);
    expect(calls).toEqual(["assert-core"]);
  });

  it.each(["3F000", "42P01"])(
    "installs a fresh database after PostgreSQL error %s",
    async (code) => {
      const subject = operations({
        readVersion: vi
          .fn<SchemaPreparationOperations["readVersion"]>()
          .mockRejectedValue(Object.assign(new Error("missing schema"), { code })),
      });

      await expect(prepareSchema(subject)).resolves.toBe("installed");
      expect(subject.install).toHaveBeenCalledOnce();
      expect(subject.migrate).not.toHaveBeenCalled();
      expect(subject.installDemo).toHaveBeenCalledOnce();
    },
  );

  it("migrates an installed database before installing the demo tables", async () => {
    const calls: string[] = [];
    const subject = operations({
      readVersion: vi.fn<SchemaPreparationOperations["readVersion"]>(async () => {
        calls.push("read");
        return 45;
      }),
      migrate: vi.fn<SchemaPreparationOperations["migrate"]>(async () => {
        calls.push("migrate");
      }),
      installDemo: vi.fn<SchemaPreparationOperations["installDemo"]>(async () => {
        calls.push("demo");
      }),
    });

    await expect(prepareSchema(subject)).resolves.toBe("migrated");
    expect(calls).toEqual(["read", "migrate", "demo"]);
    expect(subject.install).not.toHaveBeenCalled();
  });

  it("does not treat an unrelated database error as a fresh installation", async () => {
    const error = Object.assign(new Error("authentication failed"), { code: "28P01" });
    const subject = operations({
      readVersion: vi.fn<SchemaPreparationOperations["readVersion"]>().mockRejectedValue(error),
    });

    await expect(prepareSchema(subject)).rejects.toBe(error);
    expect(subject.install).not.toHaveBeenCalled();
    expect(subject.migrate).not.toHaveBeenCalled();
    expect(subject.installDemo).not.toHaveBeenCalled();
  });
});
