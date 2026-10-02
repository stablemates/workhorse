import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SchemaCompatibilityError, WORKHORSE_SCHEMA_VERSION } from "@stablemates/workhorse";
import { describe, expect, it, vi } from "vitest";
import {
  awaitWorkerSchema,
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

function missing(): SchemaCompatibilityError {
  return new SchemaCompatibilityError("schema-not-installed", "missing", {
    installedVersion: null,
    expectedVersion: 1,
  });
}

describe("demo worker schema wait", () => {
  it("waits in development until the server installs the schema", async () => {
    const assertCompatible = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(missing())
      .mockRejectedValueOnce(missing())
      .mockResolvedValue(undefined);
    const onWait = vi.fn<() => void>();

    await awaitWorkerSchema("development", assertCompatible, onWait, 1);

    expect(assertCompatible).toHaveBeenCalledTimes(3);
    expect(onWait).toHaveBeenCalledOnce();
  });

  it("refuses a missing schema at once in production", async () => {
    const error = missing();
    const assertCompatible = vi.fn<() => Promise<void>>().mockRejectedValue(error);

    await expect(
      awaitWorkerSchema("production", assertCompatible, vi.fn<() => void>(), 1),
    ).rejects.toBe(error);
    expect(assertCompatible).toHaveBeenCalledOnce();
  });

  it("refuses an incompatible development schema at once", async () => {
    const error = new SchemaCompatibilityError("schema-too-old", "old", {
      installedVersion: 1,
      expectedVersion: 2,
    });
    const assertCompatible = vi.fn<() => Promise<void>>().mockRejectedValue(error);

    await expect(
      awaitWorkerSchema("development", assertCompatible, vi.fn<() => void>(), 1),
    ).rejects.toBe(error);
    expect(assertCompatible).toHaveBeenCalledOnce();
  });
});

// ADR 0053 makes migration a pipeline step and forbids a component from migrating on start,
// because no component is a singleton. The demo is the product's own showcase, so a container that
// prepared its own schema would be the documentation contradicting itself in the one place a
// reader can watch it run.
describe("the demo's schema step runs from the pipeline", () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");

  it("keeps schema preparation out of the container entry point", async () => {
    const entrypoint = await readFile(
      resolve(repositoryRoot, "typescript/demo/container-entrypoint.mjs"),
      "utf8",
    );
    // The comment there names the file to say where the step went, so only code counts.
    const code = entrypoint.replace(/^\s*\/\/.*$/gm, "");

    expect(code).not.toContain("prepare-schema.js");
  });

  // The hook that runs the step lives in the private operations repository, where its own suite
  // asserts this same contract against the file that actually executes (ADR 0060). What this
  // repository owns is the requirement: a deployment reading DEPLOYMENT.md must be told to run the
  // step from the pipeline, in the version being deployed, and to fail the deploy when it refuses.
  it("requires it of a deployment, in the contract this repository publishes", async () => {
    const source = await readFile(resolve(repositoryRoot, "typescript/demo/DEPLOYMENT.md"), "utf8");
    // The document is wrapped prose, so a sentence is matched against its collapsed whitespace
    // rather than against wherever the lines happen to break today.
    const contract = source.replaceAll(/\s+/g, " ");

    expect(contract).toContain("node dist/prepare-schema.js");
    expect(contract).toContain("before any container from it starts");
    // Reusing the deployed version is the whole guarantee: a step run from any other image is a
    // different version of the schema tool than the one about to serve traffic.
    expect(contract).toContain("started from the exact version being deployed");
    expect(contract).toContain("must fail the deploy before the container swap");
  });

  // The contract once said the build ships version 51 and that migration finishes there, a release
  // after migration 0053 had made the generated version 52. Each final-version claim is read
  // against the generated constant, so the next migration fails here until the contract follows.
  it("states the build's own final schema version", async () => {
    const source = await readFile(resolve(repositoryRoot, "typescript/demo/DEPLOYMENT.md"), "utf8");
    const contract = source.replaceAll(/\s+/g, " ");
    const version = WORKHORSE_SCHEMA_VERSION;

    expect(contract).toContain(`The current build ships Workhorse schema version ${version};`);
    expect(contract).toContain(`Versions 26 through ${version} are additive`);
    expect(contract).toContain(`after 0025 and leaves the database at version ${version}.`);
    expect(contract).toContain(`Its pre-deploy hook finds version ${version},`);
    // Migration 0052 took the schema from 50 to 51, so the cold-export outage stays tied to that
    // step whatever the final version is.
    expect(contract).toContain("the step to version 51 needs a short exporter outage");
    expect(contract).toContain("Migration 0052 repairs the export ledger");
  });
});
