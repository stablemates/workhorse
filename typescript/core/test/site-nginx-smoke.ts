// Serves the built documentation site through the real `site/nginx.conf` and
// proves the content negotiation it describes. `site-smoke.ts` runs the same
// bundle through the vite preview server, which knows nothing of `Accept`, so
// this is the only check of the behaviour the site image ships. It is opt-in,
// because the CI images that run `check` carry no nginx.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const webRoot = resolve(repositoryRoot, "site/dist/client");
const port = 32_000 + Math.floor(Math.random() * 1_000);

function checkpoint(fields: Record<string, unknown>): void {
  console.log(`JCODE_CHECKPOINT ${JSON.stringify(fields)}`);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// 1. The binary. `WORKHORSE_NGINX` names one explicitly; otherwise `PATH`, then
// the Debian location that is not on a non-root user's `PATH`.
function findNginx(): string | undefined {
  const override = process.env.WORKHORSE_NGINX;
  if (override !== undefined) return isExecutable(override) ? override : undefined;
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).map((entry) => resolve(entry, "nginx")),
    "/usr/sbin/nginx",
  ];
  return candidates.find((candidate) => candidate !== "/nginx" && isExecutable(candidate));
}

// 2. `mime.types` lives beside the compiled-in configuration file; the fragment
// depends on the mapping it builds, so the wrapper has to include the same one.
function findMimeTypes(nginx: string): string {
  const version = spawnSync(nginx, ["-V"], { encoding: "utf8" });
  const confPath = /--conf-path=(\S+)/.exec(`${version.stdout}${version.stderr}`)?.[1];
  const candidates = [
    ...(confPath === undefined ? [] : [dirname(confPath)]),
    "/etc/nginx",
    "/opt/homebrew/etc/nginx",
    "/usr/local/etc/nginx",
  ].map((directory) => resolve(directory, "mime.types"));
  const found = candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (found === undefined) {
    throw new Error(`nginx is installed at ${nginx} but none of ${candidates.join(", ")} exists`);
  }
  return found;
}

const nginx = findNginx();
if (nginx === undefined) {
  console.log("site-nginx-smoke: skipped, nginx is not installed");
  checkpoint({ message: "Documentation site nginx smoke skipped", skipped: true });
  process.exit(0);
}
if (!(await exists(resolve(webRoot, "index.html")))) {
  throw new Error(`${webRoot} holds no built site; run pnpm docs:build first`);
}
const mimeTypes = findMimeTypes(nginx);

// 3. The fragment is written for the image: it listens on 8080 and serves
// /usr/share/nginx/html. Both lines are asserted to occur exactly once, so a
// rewrite that stops matching fails here rather than by binding the wrong port.
const directory = await mkdtemp(resolve(tmpdir(), "workhorse-site-nginx-"));
await Promise.all([mkdir(resolve(directory, "logs")), mkdir(resolve(directory, "tmp"))]);
const fragmentSource = await readFile(resolve(repositoryRoot, "site/nginx.conf"), "utf8");
function replaceOnce(source: string, needle: string, replacement: string): string {
  const occurrences = source.split(needle).length - 1;
  if (occurrences !== 1) {
    throw new Error(`site/nginx.conf carries "${needle}" ${occurrences} times, expected once`);
  }
  return source.replace(needle, replacement);
}
const fragment = replaceOnce(
  replaceOnce(fragmentSource, "listen 8080 default_server;", `listen 127.0.0.1:${port};`),
  "root /usr/share/nginx/html;",
  `root ${webRoot};`,
);
const fragmentPath = resolve(directory, "site.conf");
const wrapperPath = resolve(directory, "nginx.conf");
// The wrapper is what proves the fragment works as a `conf.d` include: the
// image's own nginx.conf includes it inside an `http` block that has already
// included mime.types. The temp paths keep nginx off the `/var/lib/nginx`
// defaults a non-root user cannot write.
const temp = ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"]
  .map((name) => `  ${name}_temp_path ${resolve(directory, "tmp", name)};`)
  .join("\n");
await writeFile(fragmentPath, fragment);
await writeFile(
  wrapperPath,
  [
    "daemon off;",
    `pid ${resolve(directory, "nginx.pid")};`,
    "error_log stderr;",
    "events {}",
    "http {",
    `  include ${mimeTypes};`,
    "  default_type application/octet-stream;",
    `  access_log ${resolve(directory, "logs", "access.log")};`,
    temp,
    `  include ${fragmentPath};`,
    "}",
    "",
  ].join("\n"),
);

const syntax = spawnSync(nginx, ["-t", "-p", directory, "-c", wrapperPath], { encoding: "utf8" });
if (syntax.status !== 0) {
  await rm(directory, { recursive: true, force: true });
  throw new Error(`nginx -t rejected site/nginx.conf\n${syntax.stderr}`);
}

// 4. Serve, then run the vector table.
const server = spawn(nginx, ["-p", directory, "-c", wrapperPath], {
  cwd: directory,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [server.stdout!, server.stderr!]) {
  stream.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
}

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

// Node's `fetch` sends `Accept: */*` when none is given, and the no-header case
// is the one a plain `curl` or a crawler sends, so requests go through
// `node:http`, which sends only what it is told.
function get(path: string, accept: string | undefined): Promise<Response> {
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: accept === undefined ? {} : { Accept: accept },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolveResponse({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

interface Vector {
  path: string;
  accept: string | undefined;
  status: number;
  /** A prefix of `Content-Type`; the charset parameter is asserted where it matters. */
  type: string;
  /** `true` for `Vary: Accept` exactly, `false` for no `Vary` header at all. */
  vary: boolean;
  cacheControl?: string;
  token?: string;
  /** The twin's path; the negotiated body must equal it byte for byte. */
  twin?: string;
  /** Parsed JSON body must satisfy this. */
  json?: (body: unknown) => boolean;
}

const markdownOnly = "text/markdown";
const markdownFirst = "text/markdown, text/html, */*";
const openCode =
  "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
const chrome =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
const rejectsMarkdown = "text/markdown;q=0, text/html";

function twinVectors(path: string, twin: string): Vector[] {
  return [
    ...[markdownOnly, markdownFirst, openCode].map((accept) => ({
      path,
      accept,
      status: 200,
      type: "text/markdown; charset=utf-8",
      vary: true,
      twin,
    })),
    ...[undefined, "*/*", chrome, rejectsMarkdown].map((accept) => ({
      path,
      accept,
      status: 200,
      type: "text/html",
      vary: true,
      token: "<!DOCTYPE html>",
    })),
  ];
}

const notes: string[] = [];
const vectors: Vector[] = [
  ...twinVectors("/", "/index.md"),
  ...twinVectors("/docs", "/docs.md"),
  ...twinVectors("/docs/quickstart", "/docs/quickstart.md"),
  ...twinVectors("/docs/quickstart/", "/docs/quickstart.md"),
];
if (await exists(resolve(webRoot, "about.md"))) {
  vectors.push(...twinVectors("/about", "/about.md"));
} else {
  notes.push("site/dist/client/about.md is absent; the /about vectors were skipped");
}

// The blog index page has no twin, so a Markdown-only client gets a 406 that
// names the HTML instead, while a client that also takes HTML gets the page.
// The index is prerendered even with zero posts (nothing links it then, but
// the route exists), so these vectors hold either way; a post's twin is
// checked only when there is a post.
const blogIndex = JSON.parse(
  await readFile(resolve(repositoryRoot, "site/.source/blog-index.json"), "utf8"),
) as { posts: { url: string }[] };
vectors.push(
  {
    path: "/blog",
    accept: markdownOnly,
    status: 406,
    type: "text/plain",
    vary: true,
    cacheControl: "no-store",
    token: "/blog is available as: text/html",
  },
  { path: "/blog", accept: openCode, status: 200, type: "text/html", vary: true },
  { path: "/blog", accept: undefined, status: 200, type: "text/html", vary: true },
);
if (blogIndex.posts.length > 0) {
  const post = blogIndex.posts[0]!.url;
  vectors.push(...twinVectors(post, `${post}.md`));
}

const notFoundJson = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  (body as { error?: { code?: unknown } }).error?.code === "not_found";
vectors.push(
  // A missing page answers in the representation the client asked for, and
  // the status stays 404 in every one of them.
  {
    path: "/nope",
    accept: undefined,
    status: 404,
    type: "text/html",
    vary: true,
    token: "This page does not exist",
  },
  { path: "/nope", accept: "*/*", status: 404, type: "text/html", vary: true },
  // ADR 0064 renamed two documentation slugs; the old URLs redirect permanently.
  {
    path: "/docs/job-dependencies",
    accept: undefined,
    status: 301,
    type: "text/html",
    vary: false,
  },
  { path: "/docs/child-jobs", accept: undefined, status: 301, type: "text/html", vary: false },
  {
    path: "/nope",
    accept: markdownOnly,
    status: 404,
    type: "text/markdown; charset=utf-8",
    vary: true,
    token: "llms.txt",
  },
  {
    path: "/nope",
    accept: openCode,
    status: 404,
    type: "text/markdown; charset=utf-8",
    vary: true,
  },
  {
    path: "/nope",
    accept: "application/json",
    status: 404,
    type: "application/json; charset=utf-8",
    vary: true,
    json: notFoundJson,
  },
  // The search index is the one JSON file without an extension; a missing
  // /api/ path is JSON whatever the client accepts.
  {
    path: "/api/nope",
    accept: undefined,
    status: 404,
    type: "application/json; charset=utf-8",
    vary: true,
    json: notFoundJson,
  },
  { path: "/api/search", accept: undefined, status: 200, type: "application/json", vary: false },
  // A file named with its extension is one representation: no negotiation, no Vary.
  {
    path: "/docs/quickstart.md",
    accept: markdownOnly,
    status: 200,
    type: "text/markdown; charset=utf-8",
    vary: false,
  },
  {
    path: "/docs/quickstart.md",
    accept: undefined,
    status: 200,
    type: "text/markdown; charset=utf-8",
    vary: false,
  },
  { path: "/llms.txt", accept: markdownOnly, status: 200, type: "text/plain", vary: false },
  { path: "/sitemap.xml", accept: markdownOnly, status: 200, type: "text/xml", vary: false },
  { path: "/up", accept: markdownOnly, status: 200, type: "text/plain", vary: false, token: "ok" },
  // The visible 404 page is an ordinary page; the bodies error_page serves
  // are internal, so a direct request gets a 404 rather than an indexable 200.
  { path: "/not-found", accept: undefined, status: 200, type: "text/html", vary: true },
  { path: "/404.md", accept: undefined, status: 404, type: "text/html", vary: true },
  {
    path: "/404.md",
    accept: markdownOnly,
    status: 404,
    type: "text/markdown; charset=utf-8",
    vary: true,
  },
  { path: "/not-found/index.html", accept: undefined, status: 404, type: "text/html", vary: true },
);
if (await exists(resolve(webRoot, "openapi.json"))) {
  vectors.push({
    path: "/openapi.json",
    accept: markdownOnly,
    status: 200,
    type: "application/json",
    vary: false,
    json: (body) => typeof body === "object" && body !== null && "openapi" in body,
  });
} else {
  notes.push("site/dist/client/openapi.json is absent; its vector was skipped");
}
const assets = await readdir(resolve(webRoot, "assets")).catch(() => [] as string[]);
if (assets.length > 0) {
  vectors.push({
    path: `/assets/${assets[0]!}`,
    accept: markdownOnly,
    status: 200,
    type: "",
    vary: false,
    cacheControl: "max-age=31536000, public, immutable",
  });
} else {
  notes.push("site/dist/client/assets is empty; its vector was skipped");
}

function describe(vector: Vector): string {
  return `${vector.path} with ${vector.accept === undefined ? "no Accept" : `Accept: ${vector.accept}`}`;
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`nginx exited early\n${output}`);
    try {
      const up = await get("/up", undefined);
      if (up.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // nginx refuses connections until its worker has bound the port.
    }
    await sleep(50);
  }
  if (!ready) throw new Error(`Timed out waiting for nginx\n${output}`);

  const failures: string[] = [];
  for (const vector of vectors) {
    const response = await get(vector.path, vector.accept);
    const problems: string[] = [];
    const contentType = String(response.headers["content-type"] ?? "");
    const vary = response.headers.vary;
    const cacheControl = response.headers["cache-control"];
    if (response.status !== vector.status) {
      problems.push(`status ${response.status}, expected ${vector.status}`);
    }
    if (!contentType.startsWith(vector.type)) {
      problems.push(`Content-Type ${contentType}, expected a ${vector.type} prefix`);
    }
    if (vector.vary && vary !== "Accept") {
      problems.push(`Vary ${String(vary)}, expected exactly Accept`);
    }
    if (!vector.vary && vary !== undefined) {
      problems.push(`Vary ${String(vary)}, expected no Vary header`);
    }
    if (vector.cacheControl !== undefined && cacheControl !== vector.cacheControl) {
      problems.push(`Cache-Control ${String(cacheControl)}, expected ${vector.cacheControl}`);
    }
    const text = response.body.toString("utf8");
    if (vector.token !== undefined && !text.includes(vector.token)) {
      problems.push(
        `body omits ${JSON.stringify(vector.token)}: ${JSON.stringify(text.slice(0, 80))}`,
      );
    }
    if (vector.twin !== undefined) {
      const direct = await get(vector.twin, undefined);
      if (direct.status !== 200) problems.push(`${vector.twin} returned ${direct.status}`);
      else if (!direct.body.equals(response.body)) {
        problems.push(`negotiated body differs from ${vector.twin}`);
      }
    }
    if (vector.json !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        problems.push(`body is not JSON: ${JSON.stringify(text.slice(0, 80))}`);
      }
      if (parsed !== undefined && !vector.json(parsed)) {
        problems.push(`JSON body has the wrong shape: ${text.slice(0, 120)}`);
      }
    }
    if (problems.length > 0) failures.push(`${describe(vector)}: ${problems.join("; ")}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} of ${vectors.length} vectors failed\n${failures.join("\n")}`,
    );
  }
  const accessLog = await readFile(resolve(directory, "logs", "access.log"), "utf8").catch(
    () => "",
  );
  if (accessLog !== "") {
    throw new Error(`site/nginx.conf wrote an origin access log:\n${accessLog}`);
  }
  for (const note of notes) console.log(`site-nginx-smoke: ${note}`);
  checkpoint({
    message: "Documentation site nginx smoke passed",
    skipped: false,
    vectors: vectors.length,
    notes,
  });
} finally {
  // 5. `-s quit` is the graceful stop; the signal is the fallback for a master
  // that never read its pid file.
  if (server.exitCode === null) {
    const exited = new Promise<void>((resolveExit) => {
      server.once("exit", () => resolveExit());
    });
    spawnSync(nginx, ["-s", "quit", "-p", directory, "-c", wrapperPath]);
    await Promise.race([
      exited,
      sleep(2_000).then(() => {
        if (server.exitCode === null) server.kill("SIGTERM");
      }),
    ]);
    await Promise.race([exited, sleep(2_000)]);
  }
  await rm(directory, { recursive: true, force: true });
}
