import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client, type QueryResult, type QueryResultRow } from "pg";
import { isMissing, parseEnvironment, updateEnvironment } from "./environment-file.js";

const ontrackAgentDsn = "ONTRACK_AGENT_DSN";

export interface OntrackSessionConfiguration {
  dsn: string;
  sessionName: string;
}

export interface OntrackPreflightResult {
  sessionName: string;
  projectId: string;
  projectKey: "WH";
}

interface PgClient {
  connect(): Promise<void>;
  query<Row extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
  end(): Promise<void>;
}

export function validateOntrackAgentDsn(dsn: string): OntrackSessionConfiguration {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error("ONTRACK_AGENT_DSN must be an absolute PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("ONTRACK_AGENT_DSN must be an absolute PostgreSQL URL");
  }
  if (url.password || url.searchParams.has("password")) {
    throw new Error("ONTRACK_AGENT_DSN must not contain a password");
  }
  let sessionName: string;
  try {
    sessionName = decodeURIComponent(url.username);
  } catch {
    throw new Error("ONTRACK_AGENT_DSN has an invalid Session username");
  }
  if (!sessionName.trim()) throw new Error("ONTRACK_AGENT_DSN must name an Agent Session");
  if (url.hostname !== "pg.ontrack.sh" || url.port !== "35500") {
    throw new Error("ONTRACK_AGENT_DSN must target pg.ontrack.sh:35500");
  }
  if (url.pathname !== "/postgres") {
    throw new Error("ONTRACK_AGENT_DSN must target the postgres database");
  }
  if (url.searchParams.get("sslmode") !== "require") {
    throw new Error("ONTRACK_AGENT_DSN must require TLS");
  }
  if (url.hash) throw new Error("ONTRACK_AGENT_DSN must not contain a fragment");
  return { dsn: url.toString(), sessionName };
}

export function ontrackAgentDsnForSession(dsn: string, sessionName: string): string {
  if (!sessionName.trim()) throw new Error("The checkout Session name must not be blank");
  const validated = validateOntrackAgentDsn(dsn);
  const url = new URL(validated.dsn);
  url.username = sessionName;
  url.password = "";
  return url.toString();
}

export async function configureOntrackSession(options: {
  checkoutRoot: string;
  sessionName: string;
  sourceRoot?: string;
}): Promise<OntrackSessionConfiguration> {
  const sourceRoot = options.sourceRoot ?? options.checkoutRoot;
  const sourcePath = join(sourceRoot, ".env");
  const targetPath = join(options.checkoutRoot, ".env");
  const sourceContents = await requiredEnvironmentFile(sourcePath);
  const sourceDsn = parseEnvironment(sourceContents)[ontrackAgentDsn];
  if (!sourceDsn) {
    throw new Error(
      `${sourcePath} must define ${ontrackAgentDsn}; ambient values are not accepted`,
    );
  }
  const dsn = ontrackAgentDsnForSession(sourceDsn, options.sessionName);
  const target =
    sourcePath === targetPath
      ? { contents: sourceContents, exists: true }
      : await optionalEnvironmentFile(targetPath, sourceContents);
  const updated = updateEnvironment(target.contents, { [ontrackAgentDsn]: dsn });
  if (!target.exists || updated !== target.contents) {
    await writeFile(targetPath, updated, { mode: 0o600 });
  }
  await chmod(targetPath, 0o600);
  return { dsn, sessionName: options.sessionName };
}

export async function preflightOntrackSession(options: {
  dsn: string;
  sessionName: string;
  pgpassPath?: string;
  clientFactory?: (dsn: string) => PgClient;
}): Promise<OntrackPreflightResult> {
  const validated = validateOntrackAgentDsn(options.dsn);
  if (validated.sessionName !== options.sessionName) {
    throw new Error(
      `ONTRACK_AGENT_DSN names Session ${validated.sessionName}, expected ${options.sessionName}`,
    );
  }
  const pgpassPath = options.pgpassPath ?? join(homedir(), ".pgpass");
  const pgpass = await stat(pgpassPath).catch((error: unknown) => {
    if (isMissing(error)) throw new Error(`${pgpassPath} is required for Ontrack authentication`);
    throw error;
  });
  if (!pgpass.isFile() || (pgpass.mode & 0o777) !== 0o600) {
    throw new Error(`${pgpassPath} must be a regular file with mode 0600`);
  }

  const client: PgClient = options.clientFactory
    ? options.clientFactory(validated.dsn)
    : (new Client({
        host: "pg.ontrack.sh",
        port: 35_500,
        database: "postgres",
        user: validated.sessionName,
        connectionTimeoutMillis: 30_000,
        query_timeout: 30_000,
        statement_timeout: 30_000,
        ssl: { rejectUnauthorized: false },
      }) as unknown as PgClient);
  try {
    await client.connect();
    const projects = await client.query<{ id: string; key: string }>(
      "select id, key from projects where key = $1 order by id",
      ["WH"],
    );
    if (projects.rows.length !== 1 || projects.rows[0]?.key !== "WH") {
      throw new Error(
        `Expected exactly one visible Workhorse Project, found ${projects.rows.length}`,
      );
    }
    return {
      sessionName: options.sessionName,
      projectId: projects.rows[0].id,
      projectKey: "WH",
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function requiredEnvironmentFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`${path} is required; ambient ${ontrackAgentDsn} is not accepted`);
    }
    throw error;
  }
}

async function optionalEnvironmentFile(
  path: string,
  fallback: string,
): Promise<{ contents: string; exists: boolean }> {
  try {
    return { contents: await readFile(path, "utf8"), exists: true };
  } catch (error) {
    if (isMissing(error)) return { contents: fallback, exists: false };
    throw error;
  }
}
