import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  csharpMemberName,
  findInlineCSharpSql,
  renderCSharpCatalogue,
} from "./sql-catalogue-csharp.js";

const claim = {
  name: "claim_v1",
  arity: 3,
  contract: 'SELECT * FROM workhorse.claim_v1($1::text, $2::text, $3::integer) AS "x\\y"',
  catalogues: ["protocol"],
};

describe("the C# SQL catalogue", () => {
  it("names each statement in Pascal case", () => {
    expect(csharpMemberName("claim_v1")).toBe("ClaimV1");
    expect(csharpMemberName("complete_many_and_claim_v1")).toBe("CompleteManyAndClaimV1");
  });

  it("keeps each native placeholder and escapes the SQL as a C# string", () => {
    const source = renderCSharpCatalogue({
      namespace: "Workhorse.Internal",
      className: "SqlCatalogue",
      summary: "The catalogue.",
      statements: [claim],
    });

    expect(source).toContain(
      '"SELECT * FROM workhorse.claim_v1($1::text, $2::text, $3::integer) AS \\"x\\\\y\\""',
    );
    expect(source).toContain("internal static readonly Statement ClaimV1 = new(");
    expect(source).toContain("[\n        ClaimV1,\n    ];");
    expect(source).not.toContain("ClientProtocolVersion");
  });

  it("writes an empty list for a catalogue without statements", () => {
    const source = renderCSharpCatalogue({
      namespace: "Workhorse.AspNetCore.Internal",
      className: "DashboardSqlCatalogue",
      summary: "The dashboard catalogue.",
      statements: [],
    });

    expect(source).toContain("internal static readonly IReadOnlyList<Statement> All =\n    [];");
  });

  it("refuses two statements with one member name", () => {
    expect(() =>
      renderCSharpCatalogue({
        namespace: "Workhorse.Internal",
        className: "SqlCatalogue",
        summary: "The catalogue.",
        statements: [claim, { ...claim, name: "claim__v1" }],
      }),
    ).toThrow("C# SQL catalogue member ClaimV1 is not unique");
  });
});

describe("inline .NET SQL", () => {
  let repository = "";

  afterEach(async () => {
    if (repository) await rm(repository, { recursive: true, force: true });
  });

  async function place(relative: string, source: string): Promise<void> {
    const filename = path.join(repository, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, source);
  }

  it("refuses an Npgsql command with literal SQL in a shipped project", async () => {
    repository = await mkdtemp(path.join(tmpdir(), "workhorse-inline-csharp-"));
    await place("dotnet/src/Workhorse/Inline.cs", 'var c = new NpgsqlCommand("SELECT 1", conn);\n');
    await place(
      "dotnet/src/Workhorse.AspNetCore/Inline.cs",
      '\nusing var c = source.CreateCommand($"SELECT {x}");\ncommand.CommandText = @"SELECT 2";\n',
    );
    expect(await findInlineCSharpSql(repository)).toEqual([
      "dotnet/src/Workhorse.AspNetCore/Inline.cs:2",
      "dotnet/src/Workhorse.AspNetCore/Inline.cs:3",
      "dotnet/src/Workhorse/Inline.cs:1",
    ]);
  });

  it("accepts catalogue SQL, generated files, build output, and the tests", async () => {
    repository = await mkdtemp(path.join(tmpdir(), "workhorse-inline-csharp-"));
    const inline = 'new NpgsqlCommand("SELECT 1");\n';
    await place(
      "dotnet/src/Workhorse/Client.cs",
      "new NpgsqlCommand(SqlCatalogue.ClaimV1.Sql, connection);\n",
    );
    await place("dotnet/src/Workhorse/Internal/SqlCatalogue.g.cs", inline);
    await place("dotnet/src/Workhorse/obj/Debug/Inline.cs", inline);
    await place("dotnet/tests/Workhorse.Tests/Inline.cs", inline);
    expect(await findInlineCSharpSql(repository)).toEqual([]);
  });

  it("finds no violation in this repository", async () => {
    repository = "";
    expect(await findInlineCSharpSql(path.resolve(import.meta.dirname, ".."))).toEqual([]);
  });
});
