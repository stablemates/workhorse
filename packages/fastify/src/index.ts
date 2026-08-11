import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  WorkhorseRuntime,
  type WorkhorseAdapter,
  type WorkhorseRuntimeContext,
  type WorkhorseRuntimeOptions,
  type WorkhorseRuntimeWorkerDefinition,
} from "@workhorse/core";

export type FastifyWorkhorseContext<TTransaction> = WorkhorseRuntimeContext<TTransaction>;

declare module "fastify" {
  interface FastifyRequest {
    workhorse: FastifyWorkhorseContext<never>;
  }
}

export type FastifyWorkerDefinition = WorkhorseRuntimeWorkerDefinition;
export type FastifyWorkhorseOptions = WorkhorseRuntimeOptions;

/** Owns Workhorse worker startup and shutdown for one Fastify application process. */
export class FastifyWorkhorse<TTransaction> extends WorkhorseRuntime<TTransaction> {
  constructor(adapter: WorkhorseAdapter<TTransaction>, options: FastifyWorkhorseOptions = {}) {
    super(adapter, options, "FastifyWorkhorse");
  }

  /** Recover the adapter's transaction type after Fastify's global request augmentation. */
  contextFor(_request: FastifyRequest): FastifyWorkhorseContext<TTransaction> {
    return this.context;
  }
}

/** Register request context and bind Workhorse startup and shutdown to Fastify's lifecycle. */
export async function registerWorkhorse<TTransaction>(
  fastify: FastifyInstance,
  workhorse: FastifyWorkhorse<TTransaction>,
): Promise<void> {
  fastify.decorateRequest("workhorse");
  fastify.addHook("onRequest", async (request) => {
    request.workhorse = workhorse.context as FastifyWorkhorseContext<never>;
  });
  fastify.addHook("onReady", async () => {
    try {
      workhorse.start();
    } catch (error) {
      await workhorse.stop();
      throw error;
    }
  });
  fastify.addHook("preClose", async () => workhorse.quiesce());
  fastify.addHook("onClose", async () => workhorse.stop());
}
