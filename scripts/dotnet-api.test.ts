import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { snapshotDrift } from "./api-snapshot.js";
import { dotnetContract } from "./dotnet-api.js";
import { repositoryRoot } from "./packages.js";

// `dotnet-api:check` compares a fresh reading of the built assemblies with the committed snapshot.
// These cases start from the committed file and change the fresh reading the way a C# change would.

const current = readFileSync(path.join(repositoryRoot, dotnetContract.path), "utf8");
const lines = current.split("\n");

function line(predicate: (candidate: string) => boolean): string {
  const found = lines.find(predicate);
  if (found === undefined) throw new Error("The committed api/dotnet.txt has no such line.");
  return found;
}

const enqueue = line(
  (candidate) =>
    candidate.startsWith("Workhorse.Queue: public ") &&
    candidate.includes(" EnqueueAsync<TPayload>("),
);
const auditHeader = "public sealed record Workhorse.AdminAudit";
const auditActor = "Workhorse.AdminAudit: public required string Actor { get; init; }";

describe("api/dotnet.txt", () => {
  it("lists only the namespaces of the four packages", () => {
    // A delegate header can start with `[return: ...]`.
    const headers = lines
      .map((candidate) => candidate.replace(/^(?:\[[^\]]*\] )+/, ""))
      .filter((candidate) => /^(?:public|protected) /.test(candidate));
    const names = headers.map((header) =>
      (
        /^\w+ (?:\w+ )*(?:class|record|struct|interface|enum) (\S+)/.exec(header)?.[1] ??
        /^\w+ delegate .* (\S+?)(?:<[^>]*>)?\(/.exec(header)?.[1]
      )?.replace(/<.*$/, ""),
    );
    expect(names.length).toBeGreaterThan(100);
    for (const name of names) {
      expect(name).toMatch(/^Workhorse\.(?:(?:Hosting|EntityFrameworkCore|AspNetCore)\.)?\w/);
    }
    // Every member line belongs to a type that has a header.
    const declared = new Set(names);
    for (const candidate of lines.filter((member) => /^Workhorse[\w.<>, ]*: /.test(member))) {
      expect(declared.has(candidate.slice(0, candidate.indexOf(": ")).replace(/<.*$/, ""))).toBe(
        true,
      );
    }
  });

  it("holds the lines the cases change", () => {
    expect(lines).toContain(auditHeader);
    expect(lines).toContain(auditActor);
  });

  // Each of these lines once read wrong in a draft of the reader, and each change in its kind would
  // otherwise leave the file the same.
  it.each([
    // A generic value type has its own nullable byte before the bytes of its arguments.
    "public delegate System.Threading.Tasks.ValueTask<object?> Workhorse.AspNetCore.DashboardProcedure(System.Text.Json.JsonElement input, object? actor, System.Threading.CancellationToken cancellationToken)",
    // An enum member shows its number.
    "Workhorse.CancelReason: Requested = 0",
  ])("has the line %s", (expected) => {
    expect(lines).toContain(expected);
  });

  it("passes when the fresh reading matches the committed file", () => {
    expect(snapshotDrift(dotnetContract, current, current)).toBeUndefined();
  });

  it("fails and reports the line as gone when a public member is removed", () => {
    const drift = snapshotDrift(dotnetContract, current, current.replace(`${enqueue}\n`, ""));

    expect(drift).toContain(`${dotnetContract.path} no longer describes this surface`);
    expect(drift).toContain(dotnetContract.generateCommand);
    expect(drift).toContain(`gone (1):\n  ${enqueue}`);
    expect(drift).not.toContain("arrived");
  });

  it("fails and reports both lines when a signature changes", () => {
    const changed = enqueue.replace("(string taskType", "(System.ReadOnlyMemory<char> taskType");
    expect(changed).not.toBe(enqueue);

    const drift = snapshotDrift(dotnetContract, current, current.replace(enqueue, changed));

    expect(drift).toContain(`gone (1):\n  ${enqueue}`);
    expect(drift).toContain(`arrived (1):\n  ${changed}`);
  });

  it("reports a new required property of an existing type as breaking", () => {
    const added = "Workhorse.AdminAudit: public required string Ticket { get; init; }";

    const drift = snapshotDrift(
      dotnetContract,
      current,
      current.replace(auditActor, `${auditActor}\n${added}`),
    );

    expect(drift).toContain(`arrived, breaking under ADR 0107 (1):\n  ${added}`);
    expect(drift).not.toContain("\narrived (");
  });

  it("reports a new init property of an existing type as an addition", () => {
    const added = "Workhorse.AdminAudit: public string? Ticket { get; init; }";

    const drift = snapshotDrift(
      dotnetContract,
      current,
      current.replace(auditActor, `${auditActor}\n${added}`),
    );

    expect(drift).toContain(`arrived (1):\n  ${added}`);
    expect(drift).not.toContain("breaking under");
  });

  it("reports a required property of a new type as an addition", () => {
    const fresh = `${current}\npublic sealed record Workhorse.Receipt\nWorkhorse.Receipt: public required string Id { get; init; }\n`;

    const drift = snapshotDrift(dotnetContract, current, fresh);

    expect(drift).toContain("arrived (2):");
    expect(drift).not.toContain("breaking under");
  });

  it("reports a new abstract member of an interface as breaking", () => {
    const handler = line((candidate) =>
      candidate.startsWith("Workhorse.ITaskHandler<TPayload>: public abstract "),
    );
    const added = "Workhorse.ITaskHandler<TPayload>: public abstract string Queue { get; }";

    const drift = snapshotDrift(
      dotnetContract,
      current,
      current.replace(handler, `${handler}\n${added}`),
    );

    expect(drift).toContain(`arrived, breaking under ADR 0107 (1):\n  ${added}`);
  });

  it("reports a new required field of an existing type as breaking", () => {
    const added = "Workhorse.AdminAudit: public required string Ticket";

    const drift = snapshotDrift(
      dotnetContract,
      current,
      current.replace(auditActor, `${auditActor}\n${added}`),
    );

    expect(drift).toContain(`arrived, breaking under ADR 0107 (1):\n  ${added}`);
  });

  it("reports a new abstract member of an abstract record with a protected constructor as breaking", () => {
    const before = [
      "public abstract record Workhorse.Outcome",
      "Workhorse.Outcome: protected Outcome(Workhorse.Outcome original)",
    ];
    const added = "Workhorse.Outcome: public abstract string Describe()";

    const drift = snapshotDrift(dotnetContract, before.join("\n"), [...before, added].join("\n"));

    expect(drift).toContain(`arrived, breaking under ADR 0107 (1):\n  ${added}`);
  });

  it("finds the constructor of a type nested in a generic type", () => {
    const before = [
      "public abstract class Workhorse.Outer<T>.Base",
      "Workhorse.Outer<T>.Base: protected Base()",
    ];
    const added = "Workhorse.Outer<T>.Base: public abstract T Read()";

    const drift = snapshotDrift(dotnetContract, before.join("\n"), [...before, added].join("\n"));

    expect(drift).toContain(`arrived, breaking under ADR 0107 (1):\n  ${added}`);
  });

  it("reads a member line that starts with attributes", () => {
    const before = [
      "public sealed record Workhorse.Receipt",
      "Workhorse.Receipt: public Receipt()",
    ];
    const added = "Workhorse.Receipt: [DisallowNull] public required string Id { get; init; }";

    const drift = snapshotDrift(dotnetContract, before.join("\n"), [...before, added].join("\n"));

    expect(drift).toContain(`arrived, breaking under ADR 0107 (1):\n  ${added}`);
  });

  it("matches a generic interface with variance and several type parameters", () => {
    const before = [
      "public interface Workhorse.IPair<in TLeft, out TRight>",
      "Workhorse.IPair<TLeft, TRight>: public abstract TRight Map(TLeft left)",
    ];
    const added = "Workhorse.IPair<TLeft, TRight>: public required string Name { get; init; }";
    const abstractAdded =
      "Workhorse.IPair<TLeft, TRight>: public abstract TLeft Back(TRight right)";

    const drift = snapshotDrift(
      dotnetContract,
      before.join("\n"),
      [...before, added, abstractAdded].join("\n"),
    );

    expect(drift).toContain(`arrived, breaking under ADR 0107 (2):`);
  });

  it("reports a new abstract member of a class without a visible constructor as an addition", () => {
    const context = line((candidate) =>
      candidate.startsWith("Workhorse.TaskGroupContext: public abstract "),
    );
    const added =
      "Workhorse.TaskGroupContext: public abstract System.Threading.Tasks.Task SealAsync()";

    const drift = snapshotDrift(
      dotnetContract,
      current,
      current.replace(context, `${context}\n${added}`),
    );

    expect(drift).toContain(`arrived (1):\n  ${added}`);
    expect(drift).not.toContain("breaking under");
  });
});
