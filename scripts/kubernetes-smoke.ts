/**
 * Run the documented Kubernetes deployment on a disposable k3s cluster.
 *
 * The documentation remains the manifest source. This harness replaces only the example image,
 * supplies test Secrets and PostgreSQL, then observes the workloads through Kubernetes and HTTP.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`.toLowerCase();
const cluster = `wh-k8s-${suffix}`;
const context = `k3d-${cluster}`;
const baseImage = `workhorse-kubernetes-smoke-base:${suffix}`;
const image = `workhorse-kubernetes-smoke:${suffix}`;
const documentedImage = "registry.example.com/acme/workhorse-app:1.2.3";
const k3sImage = "rancher/k3s:v1.34.1-k3s1";

interface RunOptions {
  readonly input?: string;
  readonly allowFailure?: boolean;
  readonly quiet?: boolean;
}

async function run(command: string, arguments_: readonly string[], options: RunOptions = {}) {
  if (!options.quiet) process.stdout.write(`$ ${command} ${arguments_.join(" ")}\n`);
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    assert.ok(child.stdout);
    assert.ok(child.stderr);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (!options.quiet) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (!options.quiet) process.stderr.write(text);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code === 0 || options.allowFailure) resolve(result);
      else reject(new Error(`${command} ${arguments_.join(" ")} exited ${result.code}\n${stderr}`));
    });
    if (options.input !== undefined) {
      assert.ok(child.stdin);
      child.stdin.end(options.input);
    }
  });
}

function yamlBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```yaml[^\n]*\n([\s\S]*?)^```$/gm)].map((match) =>
    match[1]!.trimEnd(),
  );
}

function withFixtureImage(manifest: string): string {
  const replacements = manifest.split(documentedImage).length - 1;
  assert.ok(replacements > 0, "Documented manifest omitted the example image");
  return manifest.replaceAll(documentedImage, image);
}

async function kubectl(arguments_: readonly string[], options: RunOptions = {}) {
  return run("kubectl", ["--context", context, ...arguments_], options);
}

async function waitForJob(name: string): Promise<void> {
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const result = await kubectl(["get", "job", name, "-o", "json"], { quiet: true });
      const job = JSON.parse(result.stdout) as {
        status?: { conditions?: Array<{ type?: string; status?: string }> };
      };
      const conditions = job.status?.conditions ?? [];
      if (
        conditions.some((condition) => condition.type === "Complete" && condition.status === "True")
      ) {
        return;
      }
      if (
        conditions.some((condition) => condition.type === "Failed" && condition.status === "True")
      ) {
        throw new Error(`Job ${name} failed`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
    }
    throw new Error(`Timed out waiting for Job ${name}`);
  } catch (error) {
    await kubectl(["get", "job", name, "-o", "wide"], { allowFailure: true });
    await kubectl(["describe", "job", name], { allowFailure: true });
    await kubectl(["logs", `job/${name}`, "--all-containers=true"], { allowFailure: true });
    throw error;
  }
}

async function execInDashboard(arguments_: readonly string[]): Promise<string> {
  const result = await kubectl(
    ["exec", "deployment/workhorse-dashboard", "--", "node", "/app/client.mjs", ...arguments_],
    { quiet: true },
  );
  return result.stdout.trim();
}

const infrastructure = `
apiVersion: v1
kind: Secret
metadata:
  name: postgres
type: Opaque
stringData:
  password: workhorse
---
apiVersion: v1
kind: Secret
metadata:
  name: workhorse-database
type: Opaque
stringData:
  url: postgresql://workhorse:workhorse@postgres:5432/workhorse
---
apiVersion: v1
kind: Secret
metadata:
  name: workhorse-dashboard-auth
type: Opaque
stringData:
  username: operator
  password-hash: scrypt-v1$d29ya2hvcnNlLWF1dGgtc2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:18-alpine
          env:
            - name: POSTGRES_USER
              value: workhorse
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres
                  key: password
            - name: POSTGRES_DB
              value: workhorse
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "workhorse"]
            periodSeconds: 1
            timeoutSeconds: 1
            failureThreshold: 30
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  selector:
    app: postgres
  ports:
    - name: postgres
      port: 5432
      targetPort: 5432
`;

const schemaInstall = `
apiVersion: batch/v1
kind: Job
metadata:
  name: workhorse-schema-install
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: schema
          image: ${image}
          imagePullPolicy: IfNotPresent
          command: ["/bin/sh", "-ec"]
          args:
            - |
              for attempt in $(seq 1 30); do
                workhorse schema install && exit 0
                sleep 1
              done
              exit 1
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: workhorse-database
                  key: url
`;

let previousContext: string | undefined;
try {
  for (const [command, arguments_] of [
    ["docker", ["version"]],
    ["k3d", ["version"]],
    ["kubectl", ["version", "--client"]],
  ] as const) {
    await run(command, arguments_, { quiet: true });
  }
  const current = await run("kubectl", ["config", "current-context"], {
    allowFailure: true,
    quiet: true,
  });
  if (current.code === 0) previousContext = current.stdout.trim() || undefined;

  const reference = await readFile(path.join(repositoryRoot, "docs/kubernetes.md"), "utf8");
  const published = await readFile(
    path.join(repositoryRoot, "site/content/docs/kubernetes.mdx"),
    "utf8",
  );
  const referenceManifests = yamlBlocks(reference);
  const publishedManifests = yamlBlocks(published);
  assert.equal(referenceManifests.length, 3, "The reference must contain three YAML blocks");
  assert.deepEqual(
    publishedManifests,
    referenceManifests,
    "The published and repository manifests must stay identical",
  );

  await run("docker", ["build", "--target", "runtime", "-t", baseImage, "."]);
  await run("docker", [
    "build",
    "-f",
    "typescript/core/test/fixtures/kubernetes-smoke/Dockerfile",
    "--build-arg",
    `BASE_IMAGE=${baseImage}`,
    "-t",
    image,
    ".",
  ]);
  await run("k3d", [
    "cluster",
    "create",
    cluster,
    "--image",
    k3sImage,
    "--servers",
    "1",
    "--agents",
    "0",
    "--wait",
  ]);
  await run("k3d", ["image", "import", image, "--cluster", cluster]);

  const versionResult = await kubectl(["version", "-o", "json"], { quiet: true });
  const version = JSON.parse(versionResult.stdout) as {
    serverVersion?: { gitVersion?: string };
  };
  assert.equal(version.serverVersion?.gitVersion, "v1.34.1+k3s1");

  await kubectl(["apply", "-f", "-"], { input: infrastructure });
  await kubectl(["rollout", "status", "deployment/postgres", "--timeout=120s"]);

  await kubectl(["apply", "-f", "-"], { input: schemaInstall });
  await waitForJob("workhorse-schema-install");
  await kubectl(["logs", "job/workhorse-schema-install"]);

  const [schemaManifest, workerManifest, dashboardManifest] =
    referenceManifests.map(withFixtureImage);
  await kubectl(["apply", "-f", "-"], { input: schemaManifest });
  await waitForJob("workhorse-schema-migrate-1-2-3");
  const migrationLog = await kubectl(["logs", "job/workhorse-schema-migrate-1-2-3"], {
    quiet: true,
  });
  assert.match(migrationLog.stdout, /Workhorse schema v\d+ is already current/);
  assert.match(migrationLog.stdout, /"compatible":\s*true/);

  await kubectl(["apply", "-f", "-"], { input: workerManifest });
  await kubectl(["apply", "-f", "-"], { input: dashboardManifest });
  await kubectl(["rollout", "status", "deployment/workhorse-worker", "--timeout=180s"]);
  await kubectl(["rollout", "status", "deployment/workhorse-dashboard", "--timeout=180s"]);

  assert.equal(await execInDashboard(["dashboard", "http://workhorse-dashboard"]), "protected");

  const workerPods = JSON.parse(
    (
      await kubectl(
        [
          "get",
          "pods",
          "-l",
          "app.kubernetes.io/name=workhorse,app.kubernetes.io/component=worker",
          "-o",
          "json",
        ],
        { quiet: true },
      )
    ).stdout,
  ) as { items: Array<{ metadata: { name: string }; status: { podIP: string } }> };
  assert.equal(workerPods.items.length, 2);
  for (const pod of workerPods.items) {
    assert.equal(
      await execInDashboard(["probe", `http://${pod.status.podIP}:9090/readyz`, "200"]),
      "200",
    );
    assert.equal(
      await execInDashboard(["probe", `http://${pod.status.podIP}:9090/livez`, "200"]),
      "200",
    );
  }

  const taskId = await execInDashboard(["enqueue", "15000"]);
  assert.match(taskId, /^[0-9a-f-]{36}$/);
  const activePod = await execInDashboard(["wait-active", taskId]);
  const target = workerPods.items.find((pod) => pod.metadata.name === activePod);
  assert.ok(target, `Active worker ${activePod} was not a worker Pod`);

  const deleteStartedAt = Date.now();
  await kubectl(["delete", "pod", activePod, "--wait=false"]);
  assert.equal(
    await execInDashboard(["probe", `http://${target.status.podIP}:9090/readyz`, "503"]),
    "503",
  );
  assert.equal(
    await execInDashboard(["probe", `http://${target.status.podIP}:9090/livez`, "200"]),
    "200",
  );
  await kubectl(["wait", "--for=delete", `pod/${activePod}`, "--timeout=120s"]);
  assert.ok(Date.now() - deleteStartedAt < 120_000, "Worker exceeded the Pod grace period");
  assert.equal(await execInDashboard(["wait-state", taskId, "succeeded"]), "succeeded");
  await kubectl(["rollout", "status", "deployment/workhorse-worker", "--timeout=180s"]);

  process.stdout.write(
    `${JSON.stringify({ ok: true, clusterVersion: version.serverVersion?.gitVersion, taskId, drainedPod: activePod })}\n`,
  );
} finally {
  await run("k3d", ["cluster", "delete", cluster], { allowFailure: true });
  await run("docker", ["image", "rm", "-f", image, baseImage], { allowFailure: true });
  if (previousContext) {
    await run("kubectl", ["config", "use-context", previousContext], {
      allowFailure: true,
      quiet: true,
    });
  }
}
