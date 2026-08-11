import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const port = 32_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;

const site = spawn("pnpm", ["--filter", "@workhorse/site", "start"], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
  },
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
for (const stream of [site.stdout!, site.stderr!]) {
  stream.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (site.exitCode !== null) throw new Error(`Documentation site exited early\n${output}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // A production Next.js server can refuse connections briefly while it initializes.
    }
    await sleep(50);
  }
  if (!ready) throw new Error(`Timed out waiting for documentation site\n${output}`);

  const expectations = [
    ["/", ["Workhorse", "/docs"]],
    ["/docs", ["Workhorse", "TypeScript"]],
    ["/reference", ["Reference", "@workhorse/core"]],
    ["/integrations", ["Drizzle", "Dashboard"]],
    ["/examples", ["Examples", "enqueue"]],
    ["/demo", ["demo.workhorse.run", "live demo"]],
    ["/robots.txt", ["Sitemap"]],
    ["/sitemap.xml", ["<urlset"]],
  ] as const;

  for (const [path, tokens] of expectations) {
    const response = await fetch(`${baseUrl}${path}`);
    const body = await response.text();
    if (!response.ok) throw new Error(`${path} returned ${response.status}\n${body}`);
    for (const token of tokens) {
      if (!body.toLowerCase().includes(token.toLowerCase())) {
        throw new Error(`${path} omitted required token ${token}`);
      }
    }
  }

  const search = await fetch(`${baseUrl}/api/search?query=checkpoint`);
  const searchBody = await search.text();
  if (!search.ok || !search.headers.get("content-type")?.includes("application/json")) {
    throw new Error(`Documentation search was unavailable: ${search.status}\n${searchBody}`);
  }
  if (!searchBody.toLowerCase().includes("checkpoint")) {
    throw new Error(`Documentation search returned no checkpoint result\n${searchBody}`);
  }

  console.log(
    `JCODE_CHECKPOINT ${JSON.stringify({
      message: "Documentation site smoke passed",
      homepage: true,
      docs: true,
      reference: true,
      integrations: true,
      examples: true,
      demo: true,
      search: true,
      discovery: true,
    })}`,
  );
} finally {
  if (site.pid && site.exitCode === null) {
    const exited = new Promise<void>((resolveExit) => site.once("exit", () => resolveExit()));
    if (process.platform === "win32") site.kill("SIGTERM");
    else process.kill(-site.pid, "SIGTERM");
    await Promise.race([
      exited,
      sleep(2_000).then(() => {
        if (site.pid && site.exitCode === null) {
          if (process.platform === "win32") site.kill("SIGKILL");
          else process.kill(-site.pid, "SIGKILL");
        }
      }),
    ]);
  }
}
