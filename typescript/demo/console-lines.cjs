"use strict";

// Splits the output of a demo process into lines for the two launchers, `scripts/dev.ts` and
// `container-entrypoint.mjs`, which write each line with the name of the process in front.

const { StringDecoder } = require("node:string_decoder");

/**
 * A longer line goes out in parts of at most this many UTF-16 code units, so a line without an end
 * cannot fill memory.
 */
const MAX_LINE_LENGTH = 64 * 1024;

/**
 * Calls `onLine` for each line of `stream`, without the line end. A line longer than
 * `MAX_LINE_LENGTH` comes in parts, and a part does not cut a character in two. A last line without
 * a line end comes when the stream ends or fails. A failed stream gives no error to the caller,
 * because the process that wrote it still stops in the usual way.
 *
 * When `onLine` returns `false`, the output is full. The reader then stops the stream until `output`
 * emits `drain`, so the process waits as it did when it wrote to the output itself. Only the chunk
 * that the reader already has goes on. If `output` fails instead, the reader goes on and does not
 * stop again, so the caller still gets the last lines of the process.
 *
 * @param {import("node:stream").Readable} stream
 * @param {import("node:events").EventEmitter} output
 * @param {(line: string) => boolean} onLine
 */
function readLines(stream, output, onLine) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let waiting = false;
  let outputFailed = false;
  let ended = false;
  const resume = () => {
    output.off("drain", resume);
    output.off("error", fail);
    waiting = false;
    stream.resume();
  };
  const fail = () => {
    outputFailed = true;
    resume();
  };
  const emit = (line) => {
    if (onLine(line) !== false || waiting || outputFailed) return;
    waiting = true;
    stream.pause();
    output.once("drain", resume);
    output.once("error", fail);
  };
  // Gives the parts of `text` that are longer than the limit, and returns the rest.
  const emitParts = (text) => {
    let rest = text;
    while (rest.length > MAX_LINE_LENGTH) {
      const last = rest.charCodeAt(MAX_LINE_LENGTH - 1);
      const cut = last >= 0xd800 && last <= 0xdbff ? MAX_LINE_LENGTH - 1 : MAX_LINE_LENGTH;
      emit(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    return rest;
  };
  const take = (text, end) => {
    if (ended) return;
    pending += text;
    let start = 0;
    for (let index = pending.indexOf("\n"); index !== -1; index = pending.indexOf("\n", start)) {
      const line = pending.slice(start, index);
      emit(emitParts(line.endsWith("\r") ? line.slice(0, -1) : line));
      start = index + 1;
    }
    pending = emitParts(pending.slice(start));
    if (end) {
      ended = true;
      if (pending !== "") emit(pending);
      pending = "";
    }
  };
  stream.on("data", (chunk) => take(decoder.write(chunk), false));
  stream.on("end", () => take(decoder.end(), true));
  stream.on("error", () => take(decoder.end(), true));
}

module.exports = { MAX_LINE_LENGTH, readLines };
