import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { errorEnvelope } from "../src/queue/claim-lease-fence.js";

// `protocol/v1/failures.json` owns the shape PostgreSQL stores for a handler failure. Each SDK
// runs this table, so an operator grouping a dead letter by name reads the same
// field in every language.

/** A message part: text, or one UTF-16 code unit that no strict JSON parser reads from an escape. */
type MessagePart = string | { unpairedSurrogate: string };

interface Fixture {
  id: string;
  error: { declaresName: boolean; declaresStack: boolean; message: string | MessagePart[] };
  redactErrorDetails: boolean;
  envelope: Record<string, string | null>;
}

interface Failures {
  envelope: {
    fields: string[];
    redactedFields: string[];
    redacted: { name: string; message: string };
    genericName: Record<string, string>;
    forbiddenNameCharacters: string[];
  };
  fixtures: Fixture[];
}

const failures = JSON.parse(
  await readFile(new URL("../../../protocol/v1/failures.json", import.meta.url), "utf8"),
) as Failures;

const DECLARED_NAME = "PaymentDeclined";

class PaymentDeclined extends Error {
  override name = DECLARED_NAME;
}

/** The message a fixture describes. A JavaScript string holds an unpaired surrogate as it is. */
function fixtureMessage(message: string | MessagePart[]): string {
  if (typeof message === "string") return message;
  return message
    .map((part) =>
      typeof part === "string"
        ? part
        : String.fromCharCode(Number.parseInt(part.unpairedSurrogate, 16)),
    )
    .join("");
}

/** Build the error a fixture describes, in the way TypeScript declares a name and a stack. */
function fixtureError(fixture: Fixture): Error {
  const message = fixtureMessage(fixture.error.message);
  const error = fixture.error.declaresName ? new PaymentDeclined(message) : new Error(message);
  // A thrown Error carries V8's stack. An error that declares none is one that was never given one.
  if (!fixture.error.declaresStack) error.stack = undefined;
  return error;
}

/** Describe what an envelope's stack is, in the vocabulary the fixture expectation uses. */
function describeStack(envelope: Record<string, unknown>): string {
  if (!("stack" in envelope)) return "absent";
  const stack = envelope["stack"];
  if (stack === null) return "null";
  if (typeof stack === "string" && stack.length > 0) return "string";
  return "other";
}

/** What each fixture expectation accepts. A stack is optional, so `stringOrNull` accepts both. */
const ACCEPTED_STACKS: Record<string, readonly string[]> = {
  string: ["string"],
  stringOrNull: ["string", "null"],
  absent: ["absent"],
};

describe("failure envelope", () => {
  it.each(failures.fixtures)("matches the shared table for $id", (fixture) => {
    const envelope = errorEnvelope(fixtureError(fixture), fixture.redactErrorDetails) as Record<
      string,
      unknown
    >;
    const expectedFields = fixture.redactErrorDetails
      ? failures.envelope.redactedFields
      : failures.envelope.fields;
    expect(Object.keys(envelope).toSorted()).toEqual(expectedFields.toSorted());
    expect(envelope["message"]).toBe(fixture.envelope["message"]);
    const expectedName =
      fixture.envelope["name"] === "$generic"
        ? failures.envelope.genericName["typescript"]
        : fixture.envelope["name"];
    expect(envelope["name"]).toBe(expectedName);
    expect(ACCEPTED_STACKS[fixture.envelope["stack"] ?? "absent"]).toContain(
      describeStack(envelope),
    );
  });

  it("never records a type-system artifact as the name", () => {
    for (const fixture of failures.fixtures) {
      const envelope = errorEnvelope(fixtureError(fixture), fixture.redactErrorDetails) as Record<
        string,
        unknown
      >;
      const name = envelope["name"] as string;
      expect(name.length).toBeGreaterThan(0);
      for (const character of failures.envelope.forbiddenNameCharacters) {
        expect(name).not.toContain(character);
      }
    }
  });

  // PostgreSQL jsonb stores no NUL and no unpaired surrogate (SM-1650). An error can set its own
  // name and stack, so every field is cleaned, not only the message.
  it("replaces the text that jsonb cannot store in every field", () => {
    const error = new Error("a\u0000b \ud800 c \u{1F600}");
    error.name = "Payment\u0000Declined\udc00";
    error.stack = "Error: \u0000\n    at \ud83d";
    expect(errorEnvelope(error)).toEqual({
      name: "Payment\ufffdDeclined\ufffd",
      message: "a\ufffdb \ufffd c \u{1F600}",
      stack: "Error: \ufffd\n    at \ufffd",
    });
    expect(errorEnvelope("thrown \u0000")).toEqual({
      name: "NonErrorThrown",
      message: "thrown \ufffd",
      stack: null,
    });
    const envelope = JSON.stringify(errorEnvelope(error));
    expect(envelope).not.toMatch(/\\u(?:0000|d[89a-f])/i);
  });

  it("records a thrown non-error with a null stack", () => {
    expect(errorEnvelope("not an error")).toEqual({
      name: "NonErrorThrown",
      message: "not an error",
      stack: null,
    });
  });

  it("redacts to exactly what redact_error_details_v1 writes", () => {
    expect(errorEnvelope(new PaymentDeclined("card declined"), true)).toEqual(
      failures.envelope.redacted,
    );
  });
});
