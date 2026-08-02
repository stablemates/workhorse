#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runWorkerProcess } from "../worker-process.js";
import type { WorkerProcessDefinition } from "../worker-process.js";

const USAGE = `Usage:
  workhorse worker --config <compiled-module> [--shutdown-timeout-ms <milliseconds>]
  workhorse --help

Commands:
  worker  Load a default-exported worker process definition and run it until shutdown.

The configuration must be JavaScript that the current Node.js process can import. Compile TypeScript
configuration files before invoking the packaged CLI.
`;

interface WorkerCommandOptions {
  config: string;
  shutdownTimeoutMs?: number;
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive safe integer`);
  }
  return parsed;
}

function parseWorkerOptions(args: readonly string[]): WorkerCommandOptions {
  const config = valueAfter(args, "--config");
  if (!config) throw new Error("worker requires --config <compiled-module>");
  const timeout = valueAfter(args, "--shutdown-timeout-ms");
  const recognized = new Set(["--config", "--shutdown-timeout-ms"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) throw new Error(`Unexpected worker argument: ${argument}`);
    if (!recognized.has(argument)) throw new Error(`Unknown worker option: ${argument}`);
    index += 1;
  }
  return {
    config,
    shutdownTimeoutMs:
      timeout === undefined ? undefined : parsePositiveInteger(timeout, "--shutdown-timeout-ms"),
  };
}

function isWorkerProcessDefinition(value: unknown): value is WorkerProcessDefinition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkerProcessDefinition>;
  return typeof candidate.adapter === "function" && Array.isArray(candidate.workers);
}

async function loadDefinition(configPath: string): Promise<WorkerProcessDefinition> {
  const absolutePath = path.resolve(process.cwd(), configPath);
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to import worker configuration at ${absolutePath}`, { cause: error });
  }
  if (!isWorkerProcessDefinition(module.default)) {
    throw new Error(
      `Worker configuration at ${absolutePath} must default-export defineWorkerProcess({...})`,
    );
  }
  return module.default;
}

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (command !== "worker") throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  if (args[1] === "--help" || args[1] === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  const options = parseWorkerOptions(args.slice(1));
  const definition = await loadDefinition(options.config);
  await runWorkerProcess(definition, { shutdownTimeoutMs: options.shutdownTimeoutMs });
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
}
