// Accepts signed GitHub issue deliveries durably, applies a desired label in a worker, and
// recovers missed deliveries explicitly.
//
// Documentation: https://workhorse.run/docs/github

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Admin, Pool, Queue, Worker } from "@stablemates/workhorse";

export interface GitHubScope {
  appId: number;
  installationId: number;
  repositoryId: number;
  owner: string;
  repository: string;
  label: string;
  secret: string;
}

type Issue = { id: number; number: number; state?: string; pull_request?: unknown };
type Delivery = {
  id: number;
  guid: string;
  delivered_at: string;
  status_code: number | null;
  event: string;
  action: string | null;
  repository_id: number | null;
  installation_id: number | null;
};

class IngressError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const queueName = "github-triage";
const maxBodyBytes = 1_048_576;
const redeliveryWindowMs = 3 * 24 * 60 * 60 * 1_000;

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function scopeKey(scope: GitHubScope): string {
  if (
    ![scope.appId, scope.installationId, scope.repositoryId].every(positiveId) ||
    !/^[\w.-]+$/.test(scope.owner) ||
    !/^[\w.-]+$/.test(scope.repository) ||
    !scope.label.trim() ||
    !scope.secret
  ) {
    throw new Error(
      "Explicit app, installation, repository, label and secret configuration is required",
    );
  }
  return `${scope.appId}/${scope.installationId}/${scope.repositoryId}`;
}

export function verifyGitHubSignature(body: Buffer, signature: string, secret: string): boolean {
  if (!secret || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

function scopedIssue(payload: unknown, scope: GitHubScope): Issue {
  const event = payload as {
    repository?: { id?: unknown; full_name?: unknown };
    installation?: { id?: unknown };
    issue?: Issue;
  } | null;
  if (
    event?.repository?.id !== scope.repositoryId ||
    event.repository.full_name !== `${scope.owner}/${scope.repository}` ||
    event.installation?.id !== scope.installationId
  ) {
    throw new IngressError(403, "Repository or installation is outside this receiver's scope");
  }
  if (!positiveId(event.issue?.id) || !positiveId(event.issue.number) || event.issue.pull_request) {
    throw new IngressError(400, "Expected an issue identity, not a pull request");
  }
  return event.issue;
}

export async function installGitHubInbox(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS github_triage;
    CREATE TABLE IF NOT EXISTS github_triage.inbox (
      id uuid PRIMARY KEY,
      scope text NOT NULL,
      delivery text NOT NULL,
      body_digest text NOT NULL,
      source text NOT NULL CHECK (source IN ('webhook', 'reconciliation')),
      issue_id bigint NOT NULL,
      issue_number bigint NOT NULL,
      task_id uuid,
      accepted_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (scope, delivery)
    );
    CREATE TABLE IF NOT EXISTS github_triage.intent (
      scope text NOT NULL,
      issue_id bigint NOT NULL,
      desired_label text NOT NULL,
      inbox_id uuid NOT NULL REFERENCES github_triage.inbox(id),
      task_id uuid,
      applied_at timestamptz,
      PRIMARY KEY (scope, issue_id, desired_label)
    );
  `);
}

async function persistIssue(
  pool: Pool,
  scope: GitHubScope,
  issue: Issue,
  delivery: string,
  digest: string,
  source: "webhook" | "reconciliation",
): Promise<{ inboxId: string; taskId: string }> {
  const scoped = scopeKey(scope);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '4s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    const inboxId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO github_triage.inbox
       (id, scope, delivery, body_digest, source, issue_id, issue_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (scope, delivery) DO NOTHING RETURNING id`,
      [inboxId, scoped, delivery, digest, source, issue.id, issue.number],
    );
    if (!inserted.rowCount) {
      const existing = await client.query<{ id: string; body_digest: string; task_id: string }>(
        "SELECT id, body_digest, task_id FROM github_triage.inbox WHERE scope = $1 AND delivery = $2",
        [scoped, delivery],
      );
      const previous = existing.rows[0]!;
      if (previous.body_digest !== digest) {
        throw new IngressError(409, "Delivery identity was reused with a different body");
      }
      await client.query("COMMIT");
      return { inboxId: previous.id, taskId: previous.task_id };
    }
    const intent = await client.query(
      `INSERT INTO github_triage.intent (scope, issue_id, desired_label, inbox_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING inbox_id`,
      [scoped, issue.id, scope.label, inboxId],
    );
    let taskId: string;
    if (intent.rowCount) {
      taskId = await new Queue(client, queueName).enqueue(
        "github.ensure-label",
        { inboxId },
        {
          concurrencyKey: `${scoped}/issue/${issue.id}`,
          idempotency: { key: `${scoped}/${issue.id}/${scope.label}`, ttlMs: 86_400_000 },
          maxAttempts: 5,
          retryPolicy: { type: "fixed", delayMs: 1_000 },
        },
      );
      await client.query("UPDATE github_triage.intent SET task_id = $1 WHERE inbox_id = $2", [
        taskId,
        inboxId,
      ]);
    } else {
      const existing = await client.query<{ task_id: string }>(
        "SELECT task_id FROM github_triage.intent WHERE scope = $1 AND issue_id = $2 AND desired_label = $3",
        [scoped, issue.id, scope.label],
      );
      taskId = existing.rows[0]!.task_id;
    }
    await client.query("UPDATE github_triage.inbox SET task_id = $1 WHERE id = $2", [
      taskId,
      inboxId,
    ]);
    await client.query("COMMIT");
    return { inboxId, taskId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function acceptGitHubDelivery(
  pool: Pool,
  scope: GitHubScope,
  request: { body: Buffer; signature: string; event: string; delivery: string },
): Promise<{ status: number; inboxId?: string; taskId?: string }> {
  scopeKey(scope);
  if (request.body.length > maxBodyBytes)
    throw new IngressError(413, "Payload exceeds receiver limit");
  if (!verifyGitHubSignature(request.body, request.signature, scope.secret)) {
    throw new IngressError(401, "Invalid raw-body signature");
  }
  if (request.event !== "issues") throw new IngressError(400, "Expected the issues event header");
  if (!/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(request.delivery)) {
    throw new IngressError(400, "Expected a delivery GUID");
  }
  let payload: { action?: string };
  try {
    payload = JSON.parse(request.body.toString("utf8")) as { action?: string };
  } catch {
    throw new IngressError(400, "Invalid JSON");
  }
  const issue = scopedIssue(payload, scope);
  if (payload.action !== "opened") return { status: 204 };
  const accepted = await persistIssue(
    pool,
    scope,
    issue,
    request.delivery.toLowerCase(),
    createHash("sha256").update(request.body).digest("hex"),
    "webhook",
  );
  return { status: 202, ...accepted };
}

export function createGitHubReceiver(pool: Pool, scope: GitHubScope): Server {
  scopeKey(scope);
  return createServer(
    { requestTimeout: 5_000, headersTimeout: 5_000 },
    async (request, response) => {
      const deadline = setTimeout(() => {
        if (!response.writableEnded) response.writeHead(503).end();
      }, 8_000);
      try {
        if (request.method !== "POST" || request.url !== "/github") {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk as Uint8Array);
          size += bytes.length;
          if (size > maxBodyBytes) throw new IngressError(413, "Payload exceeds receiver limit");
          chunks.push(bytes);
        }
        const header = (name: string) => {
          const value = request.headers[name];
          return typeof value === "string" ? value : "";
        };
        const accepted = await acceptGitHubDelivery(pool, scope, {
          body: Buffer.concat(chunks),
          signature: header("x-hub-signature-256"),
          event: header("x-github-event"),
          delivery: header("x-github-delivery"),
        });
        if (!response.writableEnded) response.writeHead(accepted.status).end();
      } catch (error) {
        if (!response.writableEnded) {
          response.writeHead(error instanceof IngressError ? error.status : 503).end();
        }
      } finally {
        clearTimeout(deadline);
      }
    },
  );
}

export class GitHubApi {
  private readonly base: URL;
  private readonly token: () => Promise<string>;
  private readonly transport: typeof fetch;

  constructor(
    token: () => Promise<string>,
    transport: typeof fetch = fetch,
    baseUrl = "https://api.github.com/",
  ) {
    this.token = token;
    this.transport = transport;
    this.base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    if (this.base.protocol !== "https:" || this.base.username || this.base.password) {
      throw new Error("The API base must be a credential-free HTTPS URL");
    }
  }

  async request<Value>(endpoint: string, method = "GET", body?: unknown): Promise<Value> {
    const response = await this.send(new URL(endpoint.replace(/^\//, ""), this.base), method, body);
    return response.status === 204 || response.status === 202
      ? (undefined as Value)
      : ((await response.json()) as Value);
  }

  private async send(url: URL, method: string, body?: unknown): Promise<Response> {
    if (
      url.origin !== this.base.origin ||
      !url.pathname.startsWith(this.base.pathname) ||
      url.username ||
      url.password
    ) {
      throw new Error("Refusing to forward API credentials outside the configured API base");
    }
    const token = await this.token();
    if (!token) throw new Error("An authenticated API credential is required");
    const response = await this.transport(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(`GitHub API returned ${response.status}; operator retry required`);
    return response;
  }

  async list<Value>(endpoint: string): Promise<Value[]> {
    let next: URL | undefined = new URL(endpoint.replace(/^\//, ""), this.base);
    const collectionPath = next.pathname;
    const seen = new Set<string>();
    const values: Value[] = [];
    while (next) {
      if (seen.size >= 100 || seen.has(next.href) || next.pathname !== collectionPath) {
        throw new Error("Pagination exceeded its bound or left the requested collection");
      }
      seen.add(next.href);
      const response = await this.send(next, "GET");
      const page: unknown = await response.json();
      if (!Array.isArray(page)) throw new Error("Expected a paginated API array");
      values.push(...(page as Value[]));
      const link: string | undefined = response.headers
        .get("link")
        ?.split(",")
        .map((part) => part.trim())
        .find((part) => /;\s*rel="next"/.test(part))
        ?.match(/^<([^>]+)>/)?.[1];
      next = link ? new URL(link, next) : undefined;
    }
    return values;
  }
}

function repositoryPath(scope: GitHubScope): string {
  scopeKey(scope);
  return `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repository)}`;
}

async function verifyApiRepository(api: GitHubApi, scope: GitHubScope): Promise<void> {
  const repository = await api.request<{ id: number }>(repositoryPath(scope));
  if (repository.id !== scope.repositoryId) throw new Error("API repository identity changed");
}

export function createGitHubWorker(pool: Pool, scope: GitHubScope, api: GitHubApi): Worker {
  const scoped = scopeKey(scope);
  return new Worker(new Queue(pool, queueName), { queue: queueName, concurrency: 2 }).handle<
    { inboxId: string },
    { applied: boolean }
  >("github.ensure-label", async (payload, context) => {
    return context.checkpoint("desired-label-v1", async () => {
      const accepted = await pool.query<{
        issue_id: string;
        issue_number: string;
        desired_label: string;
        applied_at: Date | null;
      }>(
        `SELECT inbox.issue_id, inbox.issue_number, intent.desired_label, intent.applied_at
         FROM github_triage.inbox inbox JOIN github_triage.intent intent ON intent.inbox_id = inbox.id
         WHERE inbox.id = $1 AND inbox.scope = $2`,
        [payload.inboxId, scoped],
      );
      const intent = accepted.rows[0];
      if (!intent || intent.desired_label !== scope.label)
        throw new Error("Unknown scoped inbox reference");
      if (intent.applied_at) return { applied: true };
      await verifyApiRepository(api, scope);
      const endpoint = `${repositoryPath(scope)}/issues/${intent.issue_number}`;
      const issue = await api.request<Issue & { labels: { name: string }[] }>(endpoint);
      if (String(issue.id) !== intent.issue_id || issue.pull_request)
        throw new Error("API issue identity changed");
      if (issue.state !== "open") return { applied: false };
      if (!issue.labels.some((label) => label.name === scope.label)) {
        await api.request(`${endpoint}/labels`, "POST", { labels: [scope.label] });
      }
      await pool.query(
        "UPDATE github_triage.intent SET applied_at = now() WHERE inbox_id = $1 AND scope = $2",
        [payload.inboxId, scoped],
      );
      return { applied: true };
    });
  });
}

export async function recoverGitHubDeliveries(
  appApi: GitHubApi,
  scope: GitHubScope,
  now = new Date(),
): Promise<number[]> {
  scopeKey(scope);
  const deliveries = await appApi.list<Delivery>("/app/hook/deliveries?per_page=100");
  const attempted = new Set<string>();
  const redelivered: number[] = [];
  for (const delivery of deliveries) {
    const age = now.getTime() - Date.parse(delivery.delivered_at);
    if (
      delivery.event !== "issues" ||
      delivery.action !== "opened" ||
      delivery.repository_id !== scope.repositoryId ||
      delivery.installation_id !== scope.installationId ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > redeliveryWindowMs ||
      (delivery.status_code !== null &&
        delivery.status_code >= 200 &&
        delivery.status_code < 300) ||
      attempted.has(delivery.guid) ||
      !positiveId(delivery.id)
    )
      continue;
    const detail = await appApi.request<{ guid: string; request: { payload: unknown } }>(
      `/app/hook/deliveries/${delivery.id}`,
    );
    scopedIssue(detail.request.payload, scope);
    if (
      detail.guid !== delivery.guid ||
      (detail.request.payload as { action?: string }).action !== "opened"
    ) {
      throw new Error("Delivery inspection identity mismatch");
    }
    await appApi.request(`/app/hook/deliveries/${delivery.id}/attempts`, "POST");
    attempted.add(delivery.guid);
    redelivered.push(delivery.id);
  }
  return redelivered;
}

export async function reconcileGitHubIssues(
  pool: Pool,
  scope: GitHubScope,
  installationApi: GitHubApi,
): Promise<string[]> {
  await verifyApiRepository(installationApi, scope);
  const issues = await installationApi.list<Issue>(
    `${repositoryPath(scope)}/issues?state=open&per_page=100`,
  );
  const tasks: string[] = [];
  for (const issue of issues) {
    if (issue.pull_request || issue.state !== "open") continue;
    if (!positiveId(issue.id) || !positiveId(issue.number))
      throw new Error("Invalid resource issue identity");
    const normalized = JSON.stringify({ id: issue.id, number: issue.number });
    const accepted = await persistIssue(
      pool,
      scope,
      issue,
      `resource:${issue.id}:${scope.label}`,
      createHash("sha256").update(normalized).digest("hex"),
      "reconciliation",
    );
    tasks.push(accepted.taskId);
  }
  return tasks;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function verifyGitHubRecipe(
  databaseUrl: string,
): Promise<{ state: string; labels: string[] }> {
  const pool = new Pool({ connectionString: databaseUrl });
  const scope: GitHubScope = {
    appId: 1121,
    installationId: Date.now(),
    repositoryId: 3,
    owner: "fixture",
    repository: "issues",
    label: "triage",
    secret: "offline-fixture-only",
  };
  const labels = new Set(["keep-human-label"]);
  const transport: typeof fetch = async (input, options) => {
    const endpoint = new URL(String(input));
    if (endpoint.pathname === "/repos/fixture/issues") return Response.json({ id: 3 });
    if (endpoint.pathname === "/repos/fixture/issues/issues/5") {
      return Response.json({
        id: 4,
        number: 5,
        state: "open",
        labels: [...labels].map((name) => ({ name })),
      });
    }
    if (
      endpoint.pathname === "/repos/fixture/issues/issues/5/labels" &&
      options?.method === "POST"
    ) {
      labels.add("triage");
      return Response.json([...labels].map((name) => ({ name })));
    }
    throw new Error("Offline verification refuses every other API request");
  };
  try {
    await installGitHubInbox(pool);
    const body = Buffer.from(
      JSON.stringify({
        action: "opened",
        repository: { id: 3, full_name: "fixture/issues" },
        installation: { id: scope.installationId },
        issue: { id: 4, number: 5 },
      }),
    );
    const request = {
      body,
      signature: `sha256=${createHmac("sha256", scope.secret).update(body).digest("hex")}`,
      event: "issues",
      delivery: randomUUID(),
    };
    const accepted = await acceptGitHubDelivery(pool, scope, request);
    const duplicate = await acceptGitHubDelivery(pool, scope, {
      ...request,
      delivery: randomUUID(),
    });
    if (accepted.taskId !== duplicate.taskId || !accepted.taskId)
      throw new Error("Persistent business identity was not preserved");
    await createGitHubWorker(
      pool,
      scope,
      new GitHubApi(async () => "offline-installation-token", transport),
    ).runOnce();
    const task = await new Admin(pool, queueName).getTask(accepted.taskId);
    if (task?.state !== "succeeded" || !labels.has("triage"))
      throw new Error("Offline triage verification failed");
    return { state: task.state, labels: [...labels] };
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (import.meta.url === invokedPath && process.argv[2] === "--verify") {
  console.log(JSON.stringify(await verifyGitHubRecipe(required("DATABASE_URL"))));
} else if (import.meta.url === invokedPath) {
  const scope: GitHubScope = {
    appId: Number(required("GITHUB_APP_ID")),
    installationId: Number(required("GITHUB_INSTALLATION_ID")),
    repositoryId: Number(required("GITHUB_REPOSITORY_ID")),
    owner: required("GITHUB_OWNER"),
    repository: required("GITHUB_REPOSITORY"),
    label: required("GITHUB_TRIAGE_LABEL"),
    secret: required("GITHUB_WEBHOOK_SECRET"),
  };
  const pool = new Pool({
    connectionString: required("DATABASE_URL"),
    connectionTimeoutMillis: 1_000,
  });
  const installationApi = new GitHubApi(async () => required("GITHUB_INSTALLATION_TOKEN"));
  try {
    switch (process.argv[2]) {
      case "setup":
        await installGitHubInbox(pool);
        break;
      case "receiver": {
        const server = createGitHubReceiver(pool, scope);
        server.listen(Number(process.env.PORT ?? 3_001), "127.0.0.1");
        await new Promise<void>((resolve) => {
          process.once("SIGTERM", () => server.close(() => resolve()));
        });
        break;
      }
      case "worker": {
        const worker = createGitHubWorker(pool, scope, installationApi);
        process.once("SIGTERM", () => worker.stop());
        await worker.run();
        break;
      }
      case "recover":
        console.log(
          await recoverGitHubDeliveries(
            new GitHubApi(async () => required("GITHUB_APP_JWT")),
            scope,
          ),
        );
        break;
      case "reconcile":
        console.log(await reconcileGitHubIssues(pool, scope, installationApi));
        break;
      default:
        throw new Error("Choose setup, receiver, worker, recover or reconcile explicitly");
    }
  } finally {
    await pool.end();
  }
}
