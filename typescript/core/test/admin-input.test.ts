import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCursor, parseDateRange, readDeliveryPayload } from "../src/cli/admin-input.js";

describe("admin continuation input", () => {
  it("preserves microsecond timestamps exactly", () => {
    const cursor = { finishedAt: "2026-09-07 12:00:00.123456+00", taskId: "task" };
    expect(parseCursor(JSON.stringify(cursor), ["finishedAt", "taskId"])).toEqual(cursor);
  });

  it.each([
    "null",
    "[]",
    "false",
    "{",
    '{"taskId":"task"}',
    '{"finishedAt":"time","taskId":"task","extra":"value"}',
    '{"finishedAt":"time","taskId":12}',
  ])("rejects malformed cursor %s", (value) => {
    expect(() => parseCursor(value, ["finishedAt", "taskId"])).toThrow("--cursor must be a JSON");
  });

  it("normalizes timezone offsets in date filters", () => {
    const [after, before] = parseDateRange(
      "2026-09-07T12:00:00-04:00",
      "2026-09-07T17:00:00Z",
      "created",
    );
    expect(after?.toISOString()).toBe("2026-09-07T16:00:00.000Z");
    expect(before?.toISOString()).toBe("2026-09-07T17:00:00.000Z");
  });
});

describe("external-wait payload input", () => {
  it.each(["null", "false", "0", '""', "[]", '{"approved":true}'])(
    "accepts JSON value %s without treating it as missing",
    async (value) => {
      expect(await readDeliveryPayload(value, undefined)).toEqual(JSON.parse(value));
    },
  );

  it("reads JSON from a file and reports errors without disclosing its content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workhorse-delivery-"));
    const file = path.join(root, "decision.json");
    try {
      await writeFile(file, '{"approved":true}');
      expect(await readDeliveryPayload(undefined, file)).toEqual({ approved: true });
      await writeFile(file, "invalid private value");
      await expect(readDeliveryPayload(undefined, file)).rejects.toThrow(
        "Delivery payload must be valid JSON",
      );
      await expect(readDeliveryPayload(undefined, path.join(root, "missing"))).rejects.toThrow(
        "Could not read --payload-file",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects numeric overflow instead of delivering a silently substituted null", async () => {
    await expect(readDeliveryPayload('{"amount":1e400}', undefined)).rejects.toThrow(
      "Delivery payload must be valid JSON",
    );
  });

  it("requires exactly one payload source", async () => {
    await expect(readDeliveryPayload(undefined, undefined)).rejects.toThrow("exactly one");
    await expect(readDeliveryPayload("null", "file.json")).rejects.toThrow("exactly one");
  });
});
