import { createServer, request as httpRequest, type ClientRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_OPERATOR_MAX_CONCURRENT_MUTATIONS,
  DemoOperatorMutationGuard,
} from "./request-guards.js";
import { createDemoRequestListener } from "./request-listener.js";

const MUTATION = "/rpc/dashboard/purgeQueue";

interface Deferred {
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

/** An application whose mutations stay in flight until the test settles them. */
function deferredApplication() {
  const pending: Deferred[] = [];
  const fetch = (request: Request): Response | Promise<Response> => {
    if (new URL(request.url).pathname !== MUTATION) return Response.json({ ok: true });
    return new Promise<Response>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  };
  return { fetch, pending };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(listener: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(listener!);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

/** Send a mutation and keep the request so the test can drop its connection. */
function send(
  port: number,
  path = MUTATION,
): { request: ClientRequest; answer: Promise<{ status: number; body: string }> } {
  const body = "{}";
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    path,
    method: "POST",
    agent: false,
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
  });
  const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
    request.on("response", (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
    });
    request.on("error", reject);
  });
  request.end(body);
  return { request, answer };
}

describe("demo operator mutation slots", () => {
  // The slot used to return on the response's 'close', which a client disconnect fires at once
  // while the mutation still holds its pooled connection (SM-1013). Four abandoned mutations then
  // freed every slot, so a fifth was admitted beside four transactions still running.
  it("holds a slot for a disconnected mutation until its work settles", async () => {
    const application = deferredApplication();
    const closed: Promise<void>[] = [];
    const listener = createDemoRequestListener({
      fetch: application.fetch,
      rateLimiter: { check: () => undefined },
      mutationGuard: new DemoOperatorMutationGuard(),
    });
    const port = await listen((request, response) => {
      closed.push(
        new Promise((resolve) => {
          response.once("close", () => resolve());
        }),
      );
      listener(request, response);
    });

    const abandoned = Array.from({ length: DEMO_OPERATOR_MAX_CONCURRENT_MUTATIONS }, () =>
      send(port),
    );
    for (const { answer } of abandoned) answer.catch(() => undefined);
    await vi.waitFor(() =>
      expect(application.pending).toHaveLength(DEMO_OPERATOR_MAX_CONCURRENT_MUTATIONS),
    );
    for (const { request } of abandoned) request.destroy();
    await Promise.all(closed);

    // A fifth mutation the guard wrongly admits never answers, so report its admission instead.
    const fifth = send(port);
    fifth.answer.catch(() => undefined);
    const refused = await Promise.race([
      fifth.answer,
      vi
        .waitFor(() =>
          expect(application.pending).toHaveLength(DEMO_OPERATOR_MAX_CONCURRENT_MUTATIONS + 1),
        )
        .then(() => ({ status: "admitted beside four running mutations", body: "{}" })),
    ]);
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ message: "Too many concurrent operator mutations" });

    application.pending[0]!.resolve(Response.json({ ok: true }));
    application.pending[1]!.reject(new Error("rolled back"));

    const admitted = send(port);
    await vi.waitFor(() =>
      expect(application.pending).toHaveLength(DEMO_OPERATOR_MAX_CONCURRENT_MUTATIONS + 1),
    );
    application.pending[DEMO_OPERATOR_MAX_CONCURRENT_MUTATIONS]!.resolve(
      Response.json({ ok: true }),
    );
    expect((await admitted.answer).status).toBe(200);
  });

  it("returns each slot once however the request ends", async () => {
    const application = deferredApplication();
    const guard = new DemoOperatorMutationGuard();
    const release = vi.spyOn(guard, "release");
    const port = await listen(
      createDemoRequestListener({
        fetch: application.fetch,
        rateLimiter: { check: () => undefined },
        mutationGuard: guard,
      }),
    );

    const answered = send(port);
    await vi.waitFor(() => expect(application.pending).toHaveLength(1));
    application.pending[0]!.resolve(Response.json({ ok: true }));
    expect((await answered.answer).status).toBe(200);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));

    const abandoned = send(port);
    abandoned.answer.catch(() => undefined);
    await vi.waitFor(() => expect(application.pending).toHaveLength(2));
    abandoned.request.destroy();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(release).toHaveBeenCalledTimes(1);
    application.pending[1]!.resolve(Response.json({ ok: true }));
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("does not start a mutation whose client left while development middleware held it", async () => {
    const application = deferredApplication();
    const continuations: (() => void)[] = [];
    const closed: Promise<void>[] = [];
    const listener = createDemoRequestListener({
      fetch: application.fetch,
      dev: (_request, _response, next) => continuations.push(() => next()),
      rateLimiter: { check: () => undefined },
      mutationGuard: new DemoOperatorMutationGuard(),
    });
    const port = await listen((request, response) => {
      closed.push(
        new Promise((resolve) => {
          response.once("close", () => resolve());
        }),
      );
      listener(request, response);
    });

    const abandoned = Array.from({ length: DEMO_OPERATOR_MAX_CONCURRENT_MUTATIONS }, () =>
      send(port),
    );
    for (const { answer } of abandoned) answer.catch(() => undefined);
    await vi.waitFor(() =>
      expect(continuations).toHaveLength(DEMO_OPERATOR_MAX_CONCURRENT_MUTATIONS),
    );
    for (const { request } of abandoned) request.destroy();
    await Promise.all(closed);
    for (const resume of continuations) resume();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(application.pending).toHaveLength(0);
  });

  it("returns the slot of a mutation the development middleware answers itself", async () => {
    const guard = new DemoOperatorMutationGuard();
    const release = vi.spyOn(guard, "release");
    const port = await listen(
      createDemoRequestListener({
        fetch: () => {
          throw new Error("the application should not see this request");
        },
        dev: (_request, response) => response.end("from development middleware"),
        rateLimiter: { check: () => undefined },
        mutationGuard: guard,
      }),
    );

    expect(await send(port).answer).toEqual({ status: 200, body: "from development middleware" });
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });
});

describe("demo request handling deadline", () => {
  it("answers 504 once handling outlasts the deadline and keeps the slot until the work settles", async () => {
    const application = deferredApplication();
    const guard = new DemoOperatorMutationGuard();
    const release = vi.spyOn(guard, "release");
    const port = await listen(
      createDemoRequestListener({
        fetch: application.fetch,
        rateLimiter: { check: () => undefined },
        mutationGuard: guard,
        handlerTimeoutMs: 100,
      }),
    );

    const answer = await send(port).answer;

    expect(answer.status).toBe(504);
    expect(JSON.parse(answer.body)).toEqual({ message: "Request timed out" });
    expect(release).not.toHaveBeenCalled();
    application.pending[0]!.resolve(Response.json({ ok: true }));
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("leaves an answer inside the deadline untouched", async () => {
    const port = await listen(
      createDemoRequestListener({
        fetch: () => Response.json({ ok: true }),
        rateLimiter: { check: () => undefined },
        mutationGuard: new DemoOperatorMutationGuard(),
        handlerTimeoutMs: 100,
      }),
    );

    expect(await send(port, "/rpc/dashboard/tasks").answer).toEqual({
      status: 200,
      body: '{"ok":true}',
    });
  });
});
