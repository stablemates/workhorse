import { SeverityNumber, logs, type LogAttributes } from "@opentelemetry/api-logs";

const logger = logs.getLogger("@workhorse-js/demo");

function writeConsole(
  severity: "debug" | "info" | "error",
  message: string,
  attributes: LogAttributes,
  exception?: unknown,
): void {
  const values = Object.keys(attributes).length === 0 ? [] : [attributes];
  if (exception === undefined) console[severity](`[workhorse-demo] ${message}`, ...values);
  else console[severity](`[workhorse-demo] ${message}`, ...values, exception);
}

function emit(
  severityNumber: SeverityNumber,
  severityText: "DEBUG" | "INFO" | "ERROR",
  eventName: string,
  message: string,
  attributes: LogAttributes,
  exception?: unknown,
): void {
  logger.emit({
    severityNumber,
    severityText,
    eventName,
    body: message,
    attributes,
    ...(exception === undefined ? {} : { exception }),
  });
  writeConsole(
    severityText.toLowerCase() as "debug" | "info" | "error",
    message,
    attributes,
    exception,
  );
}

export const demoLogger = {
  debug(eventName: string, message: string, attributes: LogAttributes = {}): void {
    emit(SeverityNumber.DEBUG, "DEBUG", eventName, message, attributes);
  },
  info(eventName: string, message: string, attributes: LogAttributes = {}): void {
    emit(SeverityNumber.INFO, "INFO", eventName, message, attributes);
  },
  error(
    eventName: string,
    message: string,
    exception: unknown,
    attributes: LogAttributes = {},
  ): void {
    emit(SeverityNumber.ERROR, "ERROR", eventName, message, attributes, exception);
  },
};
