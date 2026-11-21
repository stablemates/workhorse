// The types of the parts of `file-log-exporter.cjs` that `scripts/dev.ts` imports. The OpenTelemetry
// preload `telemetry.cjs` is JavaScript and needs no types.

/** The path and the rotation limits of one demo log file. */
export interface DemoLogFile {
  path: string;
  maxBytes: number;
  archives: number;
}

/** Appends lines to one file, and rotates it before a line would take it past `maxBytes`. */
export declare class RotatingFile {
  constructor(file: DemoLogFile);
  append(lines: string[]): Promise<void>;
  flush(): Promise<void>;
}

/**
 * The file `<WORKHORSE_DEMO_LOG_DIRECTORY>/<environment>/<service><extension>` and the rotation
 * limits that the environment sets. It throws when a limit is not a positive integer.
 */
export declare function demoLogFile(
  serviceName: string,
  environment: string,
  extension: string,
  env?: NodeJS.ProcessEnv,
): DemoLogFile;
