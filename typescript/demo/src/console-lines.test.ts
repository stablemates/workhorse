import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MAX_LINE_LENGTH, readLines } from "../console-lines.cjs";

function nextTurn() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("readLines", () => {
  it("gives each line without its line end, and the last line when the stream ends", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    readLines(stream, new EventEmitter(), (line) => (lines.push(line), true));
    stream.write("first\r\nsec");
    stream.write("ond\n\nfatal: no line end");
    await nextTurn();
    expect(lines).toEqual(["first", "second", ""]);
    stream.end();
    await nextTurn();
    expect(lines).toEqual(["first", "second", "", "fatal: no line end"]);
  });

  it("keeps a character that two chunks split", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    readLines(stream, new EventEmitter(), (line) => (lines.push(line), true));
    const text = Buffer.from("café\n");
    stream.write(text.subarray(0, 4));
    stream.write(text.subarray(4));
    await nextTurn();
    expect(lines).toEqual(["café"]);
  });

  it("gives a line without an end in parts, so it cannot fill memory", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    readLines(stream, new EventEmitter(), (line) => (lines.push(line), true));
    stream.write("x".repeat(MAX_LINE_LENGTH * 2 + 5));
    await nextTurn();
    expect(lines.map((line) => line.length)).toEqual([MAX_LINE_LENGTH, MAX_LINE_LENGTH]);
    stream.end();
    await nextTurn();
    expect(lines.map((line) => line.length)).toEqual([MAX_LINE_LENGTH, MAX_LINE_LENGTH, 5]);
  });

  it("cuts a line with a line end at the same length", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    readLines(stream, new EventEmitter(), (line) => (lines.push(line), true));
    stream.write("x".repeat(MAX_LINE_LENGTH));
    stream.end("1234567\n");
    await nextTurn();
    expect(lines.map((line) => line.length)).toEqual([MAX_LINE_LENGTH, 7]);
  });

  it("does not cut a character in two", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    readLines(stream, new EventEmitter(), (line) => (lines.push(line), true));
    stream.end("x".repeat(MAX_LINE_LENGTH - 1) + "😀");
    await nextTurn();
    expect(lines.map((line) => Buffer.from(line).toString()).join("")).toBe(
      "x".repeat(MAX_LINE_LENGTH - 1) + "😀",
    );
    expect(lines.at(-1)).toBe("😀");
  });

  it("gives the last line and does not throw when the stream fails", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    readLines(stream, new EventEmitter(), (line) => (lines.push(line), true));
    stream.write("fatal: no line end");
    await nextTurn();
    stream.destroy(new Error("read EIO"));
    await nextTurn();
    expect(lines).toEqual(["fatal: no line end"]);
  });

  it("goes on reading when the full output fails instead of draining", async () => {
    const stream = new PassThrough();
    const output = new EventEmitter();
    const lines: string[] = [];
    readLines(stream, output, (line) => (lines.push(line), false));
    stream.write("first\n");
    await nextTurn();
    output.emit("error", new Error("write EPIPE"));
    stream.end("final diagnostic\n");
    await nextTurn();
    expect(lines).toEqual(["first", "final diagnostic"]);
    expect(output.listenerCount("drain")).toBe(0);
  });

  it("stops the stream once while the output is full, and goes on after drain", async () => {
    const stream = new PassThrough();
    const output = new EventEmitter();
    const lines: string[] = [];
    readLines(stream, output, (line) => (lines.push(line), false));
    stream.write("x\n".repeat(12));
    await nextTurn();
    expect(lines).toHaveLength(12);
    expect(stream.isPaused()).toBe(true);
    expect(output.listenerCount("drain")).toBe(1);

    stream.write("after\n");
    await nextTurn();
    expect(lines).toHaveLength(12);
    output.emit("drain");
    await nextTurn();
    expect(lines.at(-1)).toBe("after");
  });
});
