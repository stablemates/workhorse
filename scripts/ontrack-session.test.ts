import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryResult, QueryResultRow } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureOntrackSession,
  ontrackAgentDsnForSession,
  preflightOntrackSession,
  validateOntrackAgentDsn,
} from "./ontrack-session.js";

const safeDsn = "postgres://workhorse@pg.ontrack.sh:35500/postgres?sslmode=require";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("checkout Ontrack Session", () => {
  it.each([
    "not-a-url",
    "https://workhorse@pg.ontrack.sh:35500/postgres?sslmode=require",
    "postgres://workhorse:secret@pg.ontrack.sh:35500/postgres?sslmode=require",
    "postgres://workhorse@localhost:35500/postgres?sslmode=require",
    "postgres://workhorse@pg.ontrack.sh:35500/other?sslmode=require",
    "postgres://workhorse@pg.ontrack.sh:35500/postgres",
    "postgres://pg.ontrack.sh:35500/postgres?sslmode=require",
  ])("rejects unsafe DSN %s", (dsn) => {
    expect(() => validateOntrackAgentDsn(dsn)).toThrow();
  });

  it("encodes the exact linked-worktree Session without preserving credentials", () => {
    const rewritten = ontrackAgentDsnForSession(safeDsn, "feature/one");
    expect(rewritten).toBe("postgres://feature%2Fone@pg.ontrack.sh:35500/postgres?sslmode=require");
    expect(validateOntrackAgentDsn(rewritten).sessionName).toBe("feature/one");
  });

  it("copies only the primary DSN into a linked checkout and preserves its other values", async () => {
    const primary = await temporaryDirectory("primary");
    const linked = await temporaryDirectory("linked");
    await writeFile(join(primary, ".env"), `${safeDsnLine()}\nPRIMARY_ONLY=yes\n`);
    await writeFile(join(linked, ".env"), "CHECKOUT_ONLY=yes\nONTRACK_AGENT_DSN=stale\n");

    const configured = await configureOntrackSession({
      checkoutRoot: linked,
      sourceRoot: primary,
      sessionName: "feature/one",
    });
    const contents = await readFile(join(linked, ".env"), "utf8");
    expect(configured.sessionName).toBe("feature/one");
    expect(contents).toContain("CHECKOUT_ONLY=yes");
    expect(contents).not.toContain("PRIMARY_ONLY=yes");
    expect(contents).toContain("ONTRACK_AGENT_DSN=postgres://feature%2Fone@");
    expect((await stat(join(linked, ".env"))).mode & 0o777).toBe(0o600);
  });

  it("creates a missing linked environment even when its Session name already matches", async () => {
    const primary = await temporaryDirectory("same-session-primary");
    const linked = await temporaryDirectory("same-session-linked");
    await writeFile(join(primary, ".env"), `${safeDsnLine()}\nPRIMARY_ONLY=yes\n`);
    await configureOntrackSession({
      checkoutRoot: linked,
      sourceRoot: primary,
      sessionName: "workhorse",
    });
    expect(await readFile(join(linked, ".env"), "utf8")).toContain("PRIMARY_ONLY=yes");
    expect((await stat(join(linked, ".env"))).mode & 0o777).toBe(0o600);
  });

  it("refuses an ambient fallback when the checkout-local DSN is missing", async () => {
    const checkout = await temporaryDirectory("missing");
    await writeFile(join(checkout, ".env"), "UNRELATED=value\n");
    vi.stubEnv("ONTRACK_AGENT_DSN", safeDsn);
    await expect(
      configureOntrackSession({ checkoutRoot: checkout, sessionName: "workhorse" }),
    ).rejects.toThrow("ambient values are not accepted");
  });

  it("checks pgpass mode and proves exactly one visible WH Project", async () => {
    const checkout = await temporaryDirectory("preflight");
    const pgpassPath = join(checkout, ".pgpass");
    await writeFile(pgpassPath, "redacted\n", { mode: 0o600 });
    const client = new FakeClient();
    await expect(
      preflightOntrackSession({
        dsn: safeDsn,
        sessionName: "workhorse",
        pgpassPath,
        clientFactory: () => client,
      }),
    ).resolves.toEqual({
      sessionName: "workhorse",
      projectId: "workhorse-project",
      projectKey: "WH",
    });
    expect(client.values).toEqual(["WH"]);
    expect(client.ended).toBe(true);

    await chmod(pgpassPath, 0o644);
    await expect(
      preflightOntrackSession({
        dsn: safeDsn,
        sessionName: "workhorse",
        pgpassPath,
        clientFactory: () => new FakeClient(),
      }),
    ).rejects.toThrow("mode 0600");
  });
});

class FakeClient {
  values: unknown[] = [];
  ended = false;

  async connect(): Promise<void> {}

  async query<Row extends QueryResultRow>(
    _text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.values = values;
    return {
      rows: [{ id: "workhorse-project", key: "WH" }] as unknown as Row[],
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
    };
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `workhorse-ontrack-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function safeDsnLine(): string {
  return `ONTRACK_AGENT_DSN=${safeDsn}`;
}
