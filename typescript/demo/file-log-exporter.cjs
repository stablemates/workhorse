"use strict";

const { appendFile, mkdir, rename, rm, stat } = require("node:fs/promises");
const { dirname, resolve } = require("node:path");
const { ExportResultCode, hrTimeToMilliseconds } = require("@opentelemetry/core");

function safePathSegment(value) {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "unknown";
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * The path and rotation limits of one demo log file: `<root>/<environment>/<service><extension>`.
 *
 * The default root is the repository's `logs/` directory, two levels above this file. Resolving
 * from `__dirname` rather than the working directory keeps the destination stable no matter which
 * directory spawned the process. Every demo worker resolves the same path from the same variables.
 */
function demoLogFile(serviceName, environment, extension, env = process.env) {
  const root = env.WORKHORSE_DEMO_LOG_DIRECTORY
    ? resolve(env.WORKHORSE_DEMO_LOG_DIRECTORY)
    : resolve(__dirname, "..", "..", "logs");
  return {
    path: resolve(
      root,
      safePathSegment(environment),
      `${safePathSegment(serviceName)}${extension}`,
    ),
    maxBytes: positiveInteger(
      env.WORKHORSE_DEMO_LOG_MAX_BYTES,
      10 * 1_024 * 1_024,
      "WORKHORSE_DEMO_LOG_MAX_BYTES",
    ),
    archives: positiveInteger(env.WORKHORSE_DEMO_LOG_ARCHIVES, 5, "WORKHORSE_DEMO_LOG_ARCHIVES"),
  };
}

function serializeLogRecord(record) {
  const span = record.spanContext;
  return {
    timestamp: new Date(hrTimeToMilliseconds(record.hrTime)).toISOString(),
    observedTimestamp: new Date(hrTimeToMilliseconds(record.hrTimeObserved)).toISOString(),
    severityText: record.severityText,
    severityNumber: record.severityNumber,
    eventName: record.eventName,
    body: record.body,
    attributes: record.attributes,
    resource: record.resource.attributes,
    scope: {
      name: record.instrumentationScope.name,
      version: record.instrumentationScope.version,
      attributes: record.instrumentationScope.attributes,
    },
    ...(span ? { traceId: span.traceId, spanId: span.spanId, traceFlags: span.traceFlags } : {}),
  };
}

/**
 * Appends text to one file. It rotates the file before a line would take it past `maxBytes`, and
 * keeps `archives` numbered archives. Writes run in order, one at a time.
 */
class RotatingFile {
  constructor(options) {
    this.path = options.path;
    this.maxBytes = options.maxBytes;
    this.archives = options.archives;
    this.pending = Promise.resolve();
  }

  async fileSize() {
    try {
      return (await stat(this.path)).size;
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
  }

  async rotate() {
    await rm(`${this.path}.${this.archives}`, { force: true });
    for (let index = this.archives - 1; index >= 1; index -= 1) {
      try {
        await rename(`${this.path}.${index}`, `${this.path}.${index + 1}`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    try {
      await rename(this.path, `${this.path}.1`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  /** Appends complete lines, each with its line break. A line never spans two files. */
  async writeLines(lines) {
    await mkdir(dirname(this.path), { recursive: true });
    let size = await this.fileSize();
    let payload = "";
    let payloadBytes = 0;
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line);
      if (size + payloadBytes + lineBytes > this.maxBytes && (size > 0 || payloadBytes > 0)) {
        if (payloadBytes > 0) await appendFile(this.path, payload, "utf8");
        await this.rotate();
        size = 0;
        payload = "";
        payloadBytes = 0;
      }
      payload += line;
      payloadBytes += lineBytes;
    }
    if (payloadBytes > 0) await appendFile(this.path, payload, "utf8");
  }

  /** Queues the lines after every earlier write. The returned promise settles with this write. */
  append(lines) {
    const write = this.pending.then(() => this.writeLines(lines));
    this.pending = write.catch(() => {});
    return write;
  }

  flush() {
    return this.pending;
  }
}

class RotatingFileLogExporter {
  constructor(options) {
    this.file = new RotatingFile(options);
  }

  export(records, callback) {
    const lines = records.map((record) => `${JSON.stringify(serializeLogRecord(record))}\n`);
    void this.file.append(lines).then(
      () => callback({ code: ExportResultCode.SUCCESS }),
      (error) => callback({ code: ExportResultCode.FAILED, error }),
    );
  }

  forceFlush() {
    return this.file.flush();
  }

  shutdown() {
    return this.file.flush();
  }
}

module.exports = { RotatingFile, RotatingFileLogExporter, demoLogFile };
