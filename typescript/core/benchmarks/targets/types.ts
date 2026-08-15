import type { Pool } from "pg";
import type { CompetitorTargetName } from "../competitor-baseline.js";

export interface WorkItem {
  id: string;
  payload: Record<string, unknown>;
}
export interface TargetCapabilities {
  bulkEnqueue: true;
  nativeWorkerLoop: boolean;
  claimLatencyComparable: boolean;
  fencingComparable: boolean;
  successRetention: "retained" | "deleted";
}
export interface TargetMetadata {
  name: CompetitorTargetName;
  packageName: string;
  version: string;
  schema: string;
  queue: string;
  configuration: Record<string, unknown>;
  capabilities: TargetCapabilities;
  notes: string[];
}
export interface CompetitorTarget {
  metadata: TargetMetadata;
  reset(): Promise<void>;
  setup(): Promise<void>;
  enqueueMany(items: readonly WorkItem[]): Promise<void>;
  startConsumers(concurrency: number): Promise<void>;
  observeExactCompletions(expected: number, timeoutMs: number): Promise<void>;
  completedCount(): number;
  stop(): Promise<void>;
  close(): Promise<void>;
}
export abstract class CompletionTarget implements CompetitorTarget {
  abstract metadata: TargetMetadata;
  protected completed = new Set<string>();
  protected recordCompletion(id: string): void {
    if (this.completed.has(id))
      throw new Error(`${this.metadata.name} executed benchmark job ${id} more than once`);
    this.completed.add(id);
  }
  abstract reset(): Promise<void>;
  abstract setup(): Promise<void>;
  abstract enqueueMany(items: readonly WorkItem[]): Promise<void>;
  abstract startConsumers(concurrency: number): Promise<void>;
  abstract stop(): Promise<void>;
  abstract close(): Promise<void>;
  completedCount(): number {
    return this.completed.size;
  }
  async observeExactCompletions(expected: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.completed.size < expected && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 2));
    if (this.completed.size !== expected)
      throw new Error(`${this.metadata.name} completed ${this.completed.size}/${expected} jobs`);
  }
}
export async function dropSchema(pool: Pool, schema: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("unsafe schema identifier");
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}
