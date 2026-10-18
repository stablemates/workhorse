import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findInlineJavaSql } from "./sql-catalogue-java-inline.js";

const inline = 'connection.prepareStatement("INSERT INTO account (id) VALUES (?)");\n';
let repository = "";

async function place(relative: string, source = inline): Promise<void> {
  const filename = path.join(repository, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, source);
}

describe("inline JVM SQL", () => {
  afterEach(async () => {
    if (repository) await rm(repository, { recursive: true, force: true });
  });

  it("refuses a string-literal JDBC call in an SDK module", async () => {
    repository = await mkdtemp(path.join(tmpdir(), "workhorse-inline-sql-"));
    await place("jvm/workhorse/src/main/java/run/workhorse/Inline.java");
    await place("jvm/workhorse-kotlin/src/main/kotlin/run/workhorse/kotlin/Inline.kt");
    expect(await findInlineJavaSql(repository)).toEqual([
      "jvm/workhorse-kotlin/src/main/kotlin/run/workhorse/kotlin/Inline.kt:1",
      "jvm/workhorse/src/main/java/run/workhorse/Inline.java:1",
    ]);
  });

  it("accepts the same call in the documentation snippets of jvm/examples", async () => {
    repository = await mkdtemp(path.join(tmpdir(), "workhorse-inline-sql-"));
    await place("jvm/examples/src/main/java/run/workhorse/examples/JdbcTransaction.java");
    await place("jvm/examples/src/main/kotlin/run/workhorse/examples/JdbcTransaction.kt");
    expect(await findInlineJavaSql(repository)).toEqual([]);
  });

  it("covers a directory named examples in another place", async () => {
    repository = await mkdtemp(path.join(tmpdir(), "workhorse-inline-sql-"));
    await place("jvm/workhorse/examples/Inline.java");
    await place("jvm/workhorse/src/main/java/run/workhorse/examples/Inline.java");
    expect(await findInlineJavaSql(repository)).toEqual([
      "jvm/workhorse/examples/Inline.java:1",
      "jvm/workhorse/src/main/java/run/workhorse/examples/Inline.java:1",
    ]);
  });

  it("finds no violation in this repository", async () => {
    repository = "";
    expect(await findInlineJavaSql(path.resolve(import.meta.dirname, ".."))).toEqual([]);
  });
});
