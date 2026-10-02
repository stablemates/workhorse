import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChildConflictError,
  type ChildTaskRequest,
  type HandlerContext,
  type Json,
  Queue,
  type TaskContractVersion,
  TaskContractValidationError,
  Worker,
} from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";
import { SQL_STATEMENTS } from "../src/queue/sql-catalogue.generated.js";

const { pool, queue, admin } = createIntegrationTestContext(import.meta.url);
const childApis = ["runChild", "runChildren", "runChildrenAll"] as const;
type ChildApi = (typeof childApis)[number];

afterEach(() => vi.restoreAllMocks());

const v1: TaskContractVersion = {
  payloadSchema: {
    type: "object",
    properties: { value: { type: "integer" } },
    required: ["value"],
    additionalProperties: false,
  },
  resultSchema: { type: "integer" },
  maxPayloadBytes: 512,
  maxResultBytes: 256,
  sensitivePayloadKeys: ["secret"],
  sensitiveResultKeys: ["receipt"],
};

function contractedQueue(currentVersion: string, currentContract: TaskContractVersion): Queue {
  return new Queue(pool, "default", {
    contracts: {
      "contract-child": { currentVersion, versions: { [currentVersion]: currentContract } },
    },
  });
}

function childrenFor(api: ChildApi): ChildTaskRequest[] {
  return (api === "runChild" ? ["first"] : ["first", "second"]).map((name, index) => ({
    name,
    type: "contract-child",
    payload: { value: index + 1 },
    options: { queue: "children" },
  }));
}

async function runChildren(
  context: HandlerContext,
  api: ChildApi,
  children: ChildTaskRequest[],
): Promise<Json> {
  if (api === "runChild") {
    const child = children[0]!;
    return context.runChild(child.name, child.type, child.payload, child.options);
  }
  return context[api](children);
}

function parentWorker(childQueue: Queue, api: ChildApi, children = childrenFor(api)): Worker {
  const worker = new Worker(childQueue, { queue: "parents", workerId: "parent-worker" });
  worker.handle("contract-parent", (_payload, context) => runChildren(context, api, children));
  return worker;
}

async function storedChildren(parentId: string) {
  const result = await pool.query(
    `SELECT edge.child_name, edge.child_task_id, edge.request_fingerprint, task.contract_version,
            task.payload_max_bytes, task.result_max_bytes, task.payload_redact_keys,
            task.result_redact_keys
       FROM workhorse.task_child edge JOIN workhorse.task task ON task.id = edge.child_task_id
      WHERE edge.parent_task_id = $1 ORDER BY edge.child_name`,
    [parentId],
  );
  return result.rows;
}

async function completeChildren(count: number) {
  for (let index = 0; index < count; index += 1) {
    const child = await queue.claim("child-worker", { queue: "children" });
    expect(child).not.toBeNull();
    expect(await queue.complete(child!, "child-worker", index + 10)).toBe(true);
  }
}

describe("child contract replay", () => {
  it.each(
    childApis.flatMap((api) =>
      ["accepts", "rejects", "limits"].map((validation) => ({ api, validation })),
    ),
  )(
    "$api joins the stored child after the new contract $validation its payload",
    async ({ api, validation }) => {
      const initial = contractedQueue("v1", v1);
      await initial.syncContracts();
      const parentId = await initial.enqueue("contract-parent", null, {
        queue: "parents",
        maxAttempts: 1,
      });
      expect(await parentWorker(initial, api).runOnce()).toBe(true);
      await expect(admin.getTask(parentId)).resolves.toMatchObject({ state: "blocked" });
      const stored = await storedChildren(parentId);
      expect(stored).toHaveLength(api === "runChild" ? 1 : 2);
      for (const child of stored) {
        expect(child).toMatchObject({
          contract_version: "v1",
          payload_max_bytes: 512,
          result_max_bytes: 256,
          payload_redact_keys: ["secret"],
          result_redact_keys: ["receipt"],
        });
      }

      const advanced = contractedQueue("v2", {
        ...v1,
        payloadSchema: validation === "rejects" ? { type: "string" } : v1.payloadSchema,
        maxPayloadBytes: validation === "limits" ? 1 : 1024,
        maxResultBytes: 1024,
        sensitivePayloadKeys: ["newSecret"],
        sensitiveResultKeys: ["newReceipt"],
      });
      await advanced.syncContracts();
      await completeChildren(stored.length);
      const queries = vi.spyOn(pool, "query");
      expect(await parentWorker(advanced, api).runOnce()).toBe(true);
      const writes = queries.mock.calls.filter(
        ([statement]) =>
          statement ===
          SQL_STATEMENTS[api === "runChild" ? "create_child_v2" : "create_children_v1"],
      );
      expect(writes).toHaveLength(validation === "accepts" ? 2 : 1);
      await expect(admin.getTask(parentId)).resolves.toMatchObject({
        state: "succeeded",
        currentAttempt: 1,
        result:
          api === "runChild"
            ? 10
            : api === "runChildren"
              ? {
                  first: { status: "succeeded", result: 10 },
                  second: { status: "succeeded", result: 11 },
                }
              : { first: 10, second: 11 },
      });
      expect(await storedChildren(parentId)).toEqual(stored);
      // Loading the retained version must not change which version a new enqueue uses.
      const newTask = await advanced
        .enqueue("contract-child", validation === "rejects" ? "new" : { value: 3 })
        .then(
          (id) => admin.getTask(id),
          (error: unknown) => error,
        );
      expect(newTask).toMatchObject(
        validation === "limits" ? { name: "TaskValueSizeLimitError" } : { contractVersion: "v2" },
      );
    },
  );

  it.each(childApis)(
    "%s joins an uncontracted child after its type gains a contract",
    async (api) => {
      const parentId = await queue.enqueue("contract-parent", null, {
        queue: "parents",
        maxAttempts: 1,
      });
      expect(await parentWorker(queue, api).runOnce()).toBe(true);
      const stored = await storedChildren(parentId);
      expect(stored.every((child) => child.contract_version === null)).toBe(true);
      const advanced = contractedQueue("v2", { ...v1, payloadSchema: { type: "string" } });
      await advanced.syncContracts();
      await completeChildren(stored.length);
      expect(await parentWorker(advanced, api).runOnce()).toBe(true);
      await expect(admin.getTask(parentId)).resolves.toMatchObject({ state: "succeeded" });
      expect(await storedChildren(parentId)).toEqual(stored);
    },
  );

  it.each(
    childApis.flatMap((api) =>
      ["payload", "type", "options"].map((changedField) => ({ api, changedField })),
    ),
  )(
    "$api preserves a changed-$changedField conflict after the contract advances",
    async ({ api, changedField }) => {
      const initial = contractedQueue("v1", v1);
      await initial.syncContracts();
      const parentId = await initial.enqueue("contract-parent", null, { queue: "parents" });
      expect(await parentWorker(initial, api).runOnce()).toBe(true);
      const stored = await storedChildren(parentId);
      await completeChildren(stored.length);
      const advanced = contractedQueue("v2", { ...v1, maxResultBytes: 1024 });
      await advanced.syncContracts();
      const parent = await advanced.claim("parent-worker", { queue: "parents" });
      expect(parent?.id).toBe(parentId);
      const changed = childrenFor(api);
      if (changedField === "payload") changed[0]!.payload = { value: 99 };
      if (changedField === "type") changed[0]!.type = "other-child";
      if (changedField === "options") changed[0]!.options = { queue: "children", priority: 2 };
      const first = changed[0]!;
      const queries = vi.spyOn(pool, "query");
      const operation =
        api === "runChild"
          ? advanced.createChild(
              parent!,
              "parent-worker",
              first.name,
              first.type,
              first.payload,
              first.options,
            )
          : api === "runChildren"
            ? advanced.createChildren(parent!, "parent-worker", changed)
            : advanced.createChildrenAll(parent!, "parent-worker", changed);
      await expect(operation).rejects.toBeInstanceOf(ChildConflictError);
      expect(
        queries.mock.calls.filter(
          ([statement]) =>
            statement ===
            SQL_STATEMENTS[api === "runChild" ? "create_child_v2" : "create_children_v1"],
        ),
      ).toHaveLength(api === "runChild" && changedField === "type" ? 1 : 2);
      expect(await storedChildren(parentId)).toEqual(stored);
    },
  );

  it.each(["runChildren", "runChildrenAll"] as const)(
    "%s preserves a changed-set conflict after the contract advances",
    async (api) => {
      const initial = contractedQueue("v1", v1);
      await initial.syncContracts();
      const parentId = await initial.enqueue("contract-parent", null, { queue: "parents" });
      expect(await parentWorker(initial, api).runOnce()).toBe(true);
      const stored = await storedChildren(parentId);
      await completeChildren(stored.length);
      const advanced = contractedQueue("v2", { ...v1, maxResultBytes: 1024 });
      await advanced.syncContracts();
      const parent = await advanced.claim("parent-worker", { queue: "parents" });
      const changed = childrenFor(api).slice(0, 1);
      await expect(
        api === "runChildren"
          ? advanced.createChildren(parent!, "parent-worker", changed)
          : advanced.createChildrenAll(parent!, "parent-worker", changed),
      ).rejects.toBeInstanceOf(ChildConflictError);
      expect(await storedChildren(parentId)).toEqual(stored);
    },
  );

  it.each(childApis)("%s rejects a new invalid child before creating any child", async (api) => {
    const initial = contractedQueue("v1", v1);
    await initial.syncContracts();
    await initial.enqueue("contract-parent", null);
    const parent = await initial.claim("parent-worker");
    const children = childrenFor(api);
    children[0]!.payload = "invalid";
    await expect(
      api === "runChild"
        ? initial.createChild(parent!, "parent-worker", "first", "contract-child", "invalid")
        : api === "runChildren"
          ? initial.createChildren(parent!, "parent-worker", children)
          : initial.createChildrenAll(parent!, "parent-worker", children),
    ).rejects.toBeInstanceOf(TaskContractValidationError);
    expect(await storedChildren(parent!.id)).toEqual([]);
  });
});
