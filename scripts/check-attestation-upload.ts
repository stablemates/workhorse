import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

/**
 * Prove that `uv publish` sends a PEP 740 attestation with every distribution, without publishing.
 *
 * The Release Python dry run creates the `.publish.attestation` files with the same action the
 * publish job uses, then runs this script with the same pinned uv. The script serves an upload
 * endpoint on the loopback interface and points `uv publish` at it with the publish job's arguments.
 * A uv that leaves the attestations behind still exits 0 against PyPI, which is how 0.6.0 shipped
 * unattested (SM-1098), so the check reads what uv sent instead of trusting its exit status.
 *
 * The release workflow runs this with plain `node`, before any dependency is installed, so it
 * imports only Node built-ins.
 */

const attestationSuffix = ".publish.attestation";

function isDistribution(file: string): boolean {
  return file.endsWith(".whl") || file.endsWith(".tar.gz");
}

interface Upload {
  readonly filename: string;
  readonly attestations: number;
}

/** Read the file name and the attestation count from one legacy upload API request. */
function parseUpload(contentType: string, body: Buffer): Upload {
  const boundary = /boundary="?([^";]+)"?/.exec(contentType)?.[1];
  if (boundary === undefined) throw new Error(`upload is not multipart: ${contentType}`);
  let filename = "";
  let attestations = 0;
  // latin1 maps every byte to one code unit, so the binary distribution survives the split.
  for (const part of body.toString("latin1").split(`--${boundary}`)) {
    const [headers = "", ...rest] = part.split("\r\n\r\n");
    const name = /name="([^"]*)"/.exec(headers)?.[1];
    const value = rest.join("\r\n\r\n").replace(/\r\n$/, "");
    if (name === "content") filename = /filename="([^"]*)"/.exec(headers)?.[1] ?? "";
    if (name === "attestations") {
      const parsed = JSON.parse(value) as unknown;
      attestations = Array.isArray(parsed) ? parsed.length : 0;
    }
  }
  return { filename, attestations };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function publish(
  uv: string,
  url: string,
  files: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      uv,
      [
        "publish",
        "--publish-url",
        url,
        "--username",
        "attestation-check",
        "--password",
        "attestation-check",
        "--trusted-publishing",
        "never",
        ...files,
      ],
      { env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`uv publish exited with ${signal ?? String(code)}:\n${output}`));
    });
  });
}

export interface AttestationUploadOptions {
  /** The uv executable. Defaults to `uv` on PATH, the pinned uv in the release workflow. */
  readonly uv?: string;
  /** Extra environment for `uv publish`. */
  readonly environment?: Readonly<Record<string, string>>;
}

/**
 * Upload every file in `directory` to a local endpoint and name each distribution that arrived
 * without an attestation. An empty result means every distribution carried at least one.
 */
export async function attestationUploadProblems(
  directory: string,
  options: AttestationUploadOptions = {},
): Promise<string[]> {
  const files = (await readdir(directory)).toSorted();
  const distributions = files.filter(isDistribution);
  if (distributions.length === 0) return [`${directory} holds no wheel or sdist`];
  const problems = distributions
    .filter((file) => !files.includes(`${file}${attestationSuffix}`))
    .map((file) => `${file} has no ${file}${attestationSuffix} beside it`);

  const uploads: Upload[] = [];
  const server = createServer((request, response) => {
    readBody(request)
      .then((body) => {
        uploads.push(parseUpload(request.headers["content-type"] ?? "", body));
        response.writeHead(200).end("OK");
      })
      .catch((error: unknown) => {
        response.writeHead(400).end(String(error));
      });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = server.address() as AddressInfo;
    // The publish job passes `python/dist/*`, attestation files included, so this does too.
    await publish(
      options.uv ?? "uv",
      `http://127.0.0.1:${String(port)}/legacy/`,
      files.map((file) => path.join(directory, file)),
      options.environment ?? {},
    );
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }

  for (const file of distributions) {
    const upload = uploads.find((entry) => entry.filename === file);
    if (upload === undefined) problems.push(`uv publish did not upload ${file}`);
    else if (upload.attestations === 0)
      problems.push(`uv publish uploaded ${file} without attestations`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [directory, ...rest] = process.argv.slice(2);
  if (directory === undefined || rest.length > 0) {
    process.stderr.write(
      "Usage: node scripts/check-attestation-upload.ts <distribution directory>\n",
    );
    process.exitCode = 64;
  } else {
    try {
      const problems = await attestationUploadProblems(directory);
      if (problems.length > 0) {
        process.stderr.write(`Attestation upload check failed:\n- ${problems.join("\n- ")}\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write(
          `uv publish sent an attestation with every distribution in ${directory}\n`,
        );
      }
    } catch (error) {
      process.stderr.write(`Attestation upload check failed: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  }
}
