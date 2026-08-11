"use strict";

const { appendFile, mkdir, rename, rm, stat } = require("node:fs/promises");
const { dirname } = require("node:path");
const { ExportResultCode, hrTimeToMilliseconds } = require("@opentelemetry/core");

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

class RotatingFileLogExporter {
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

  async write(records) {
    await mkdir(dirname(this.path), { recursive: true });
    let size = await this.fileSize();
    let payload = "";
    let payloadBytes = 0;
    for (const record of records) {
      const line = `${JSON.stringify(serializeLogRecord(record))}\n`;
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

  export(records, callback) {
    this.pending = this.pending.then(() => this.write(records));
    void this.pending.then(
      () => callback({ code: ExportResultCode.SUCCESS }),
      (error) => callback({ code: ExportResultCode.FAILED, error }),
    );
  }

  forceFlush() {
    return this.pending;
  }

  shutdown() {
    return this.pending;
  }
}

module.exports = { RotatingFileLogExporter };
