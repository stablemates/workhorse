import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

/** A longer line goes out in parts of this length, so a line without an end cannot fill memory. */
export declare const MAX_LINE_LENGTH: number;

/**
 * Calls `onLine` for each line of `stream`, without the line end. When `onLine` returns `false`,
 * the reader stops the stream until `output` emits `drain`.
 */
export declare function readLines(
  stream: Readable,
  output: EventEmitter,
  onLine: (line: string) => boolean,
): void;
