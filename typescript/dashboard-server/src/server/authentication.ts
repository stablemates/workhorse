import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { DashboardSingleAdminOptions } from "@workhorse/dashboard-contract";

const SESSION_COOKIE = "__Host-workhorse-dashboard-session";
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_BODY_BYTES = 4_096;
const MAX_SERVER_SESSIONS = 16;
const MAX_FAILED_LOGINS = 5;
const FAILED_LOGIN_WINDOW_MS = 60_000;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1_024 * 1_024 } as const;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

interface ParsedPasswordHash {
  salt: Buffer;
  digest: Buffer;
}

interface SessionRecord {
  expiresAt: number;
}

interface SingleAdminAuthentication {
  authorize(request: Request, basePath: string): { actor: string } | Response;
  handle(request: Request, loginPath: string, logoutPath: string): Promise<Response | null>;
}

function parsePasswordHash(value: string): ParsedPasswordHash {
  const [scheme, saltValue, digestValue, ...extra] = value.split("$");
  const salt = Buffer.from(saltValue ?? "", "base64url");
  const digest = Buffer.from(digestValue ?? "", "base64url");
  if (scheme !== "scrypt-v1" || extra.length > 0 || salt.length < 16 || digest.length !== 32) {
    throw new TypeError(
      "Dashboard password hash must use scrypt-v1$<base64url-salt>$<base64url-digest>",
    );
  }
  return { salt, digest };
}

function loginPage(failed = false): string {
  const message = failed
    ? '<p class="login-error" role="alert">Invalid username or password.</p>'
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width">
    <meta name="color-scheme" content="light dark">
    <title>Sign in · Workhorse</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --background: #f4f6f8;
        --panel: #ffffff;
        --border: #ccd3da;
        --text: #1f252b;
        --muted: #626f7b;
        --field: #ffffff;
        --button: #535e68;
        --button-hover: #454e57;
        --error: #c92a2a;
      }
      * { box-sizing: border-box; }
      body {
        align-items: center;
        background: var(--background);
        color: var(--text);
        display: flex;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
        padding: 24px;
      }
      main { max-width: 420px; width: 100%; }
      .brand { align-items: center; display: flex; gap: 10px; margin-bottom: 20px; }
      .brand svg { height: 42px; width: 42px; }
      .brand-name { font-size: 25px; font-weight: 750; letter-spacing: -0.04em; }
      .login-panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 32px;
      }
      h1 { font-size: 24px; letter-spacing: -0.025em; margin: 0 0 8px; }
      .intro { color: var(--muted); line-height: 1.5; margin: 0 0 24px; }
      form { display: grid; gap: 18px; }
      label { display: grid; font-size: 14px; font-weight: 650; gap: 7px; }
      input {
        background: var(--field);
        border: 1px solid var(--border);
        border-radius: 5px;
        color: var(--text);
        font: inherit;
        min-height: 42px;
        padding: 9px 11px;
      }
      input:focus { border-color: #768592; outline: 2px solid #ccd3da; outline-offset: 1px; }
      button {
        background: var(--button);
        border: 0;
        border-radius: 5px;
        color: #ffffff;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
        min-height: 42px;
        padding: 9px 16px;
      }
      button:hover { background: var(--button-hover); }
      .login-error { color: var(--error); font-size: 14px; margin: 0 0 18px; }
      @media (prefers-color-scheme: dark) {
        :root {
          --background: #141618;
          --panel: #1a1d20;
          --border: #454e57;
          --text: #f1efea;
          --muted: #afb9c3;
          --field: #202428;
          --button: #768592;
          --button-hover: #8594a1;
          --error: #ff8787;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">
        <svg aria-hidden="true" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
          <path fill="#96938f" d="M388 102v3l-14 19-12 17-8 12 9 2 13 15 9 11 11 13 15 28 14 24 11 19v32l-5 8-5-2-13-23-2-3 9 28h-22l-19-28-10-5-41-17-4-2-12-22-4-6h-1l-7 53v8l34 101 5 15-2 0-5-8-13-16-14-17-11-13-11-14-10-11-9-11-10-11-9-11-14-15-7-8-6-7-2-1 2-4 9-9 8-7 14-14 8-7 8-8 8-7 10-10 6-5 5-5 16-12 16-12-55 15-48 12-21 5-3-1 27-16 25-15 25-15 56-8 9-5 28-17 18-11 18-11zm-32 93 2 4 7 11 5 7 6 1 24 1-5-4-15-10-21-9z"/>
          <path fill="#b8b5b0" d="M267 183l2 1-18 20-8 7-13 13-8 7-12 12-8 7-6 5-35 17-28 13-36 17-13 6-5 2 5-5 10-9 11-9 10-9 11-9 12-11 11-9 13-12 8-7 10-9 5-4 37-15 37-15z"/>
          <path fill="#626f7b" d="m195 271 4 2 21 21 8 7 81 81 2 1v2l4 2 14 14 7 6-3 0-16-10-18-10-23-13-24-13-23-13-23-12-22-12-26-14-15-8v-2l24-13 23-13z"/>
        </svg>
        <span class="brand-name">Workhorse</span>
      </div>
      <section class="login-panel">
        <h1>Sign in</h1>
        <p class="intro">Sign in to the operator dashboard.</p>
        ${message}
        <form method="post">
          <label>Username <input name="username" autocomplete="username" required autofocus></label>
          <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
          <button type="submit">Sign in</button>
        </form>
      </section>
    </main>
  </body>
</html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function cookieValue(request: Request): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
  return undefined;
}

function derivePassword(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/** Build the bounded server-side session boundary used by the standalone dashboard. */
export function createSingleAdminAuthentication(
  credentials: DashboardSingleAdminOptions,
): SingleAdminAuthentication {
  if (!credentials.username || credentials.username.length > 256) {
    throw new TypeError("Dashboard administrator username must contain 1 through 256 characters");
  }
  const parsedHash = parsePasswordHash(credentials.passwordHash);
  if (
    Boolean(credentials.previousPasswordHash) !== Boolean(credentials.previousPasswordHashExpiresAt)
  ) {
    throw new TypeError("Dashboard previous password hash and expiry must be configured together");
  }
  const previousHash = credentials.previousPasswordHash
    ? parsePasswordHash(credentials.previousPasswordHash)
    : undefined;
  const previousHashExpiresAt = credentials.previousPasswordHashExpiresAt
    ? Date.parse(credentials.previousPasswordHashExpiresAt)
    : undefined;
  if (
    previousHashExpiresAt !== undefined &&
    (!ISO_TIMESTAMP.test(credentials.previousPasswordHashExpiresAt ?? "") ||
      !Number.isFinite(previousHashExpiresAt))
  ) {
    throw new TypeError("Dashboard previous password hash expiry must be an ISO 8601 timestamp");
  }
  const sessionTtlSeconds = credentials.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  if (
    !Number.isInteger(sessionTtlSeconds) ||
    sessionTtlSeconds < 60 ||
    sessionTtlSeconds > 24 * 60 * 60
  ) {
    throw new RangeError(
      "Dashboard session lifetime must be an integer from 60 through 86400 seconds",
    );
  }
  const sessions = new Map<string, SessionRecord>();
  const failedLogins: number[] = [];

  function deleteExpiredSessions(now: number): void {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
  }

  function deleteOldLoginFailures(now: number): void {
    while ((failedLogins[0] ?? Number.POSITIVE_INFINITY) <= now - FAILED_LOGIN_WINDOW_MS) {
      failedLogins.shift();
    }
  }

  async function passwordExpiry(password: string, now: number): Promise<number | undefined> {
    if (password.length > 1_024) return undefined;
    const candidate = await derivePassword(password, parsedHash.salt, parsedHash.digest.length);
    if (timingSafeEqual(candidate, parsedHash.digest)) return Number.POSITIVE_INFINITY;
    if (!previousHash || previousHashExpiresAt === undefined || previousHashExpiresAt <= now) {
      return undefined;
    }
    const previousCandidate = await derivePassword(
      password,
      previousHash.salt,
      previousHash.digest.length,
    );
    return timingSafeEqual(previousCandidate, previousHash.digest)
      ? previousHashExpiresAt
      : undefined;
  }

  return {
    authorize(request, basePath) {
      const token = cookieValue(request);
      if (token) {
        const session = sessions.get(token);
        if (session !== undefined && session.expiresAt > Date.now()) {
          return { actor: credentials.username };
        }
        sessions.delete(token);
      }
      const pathname = new URL(request.url).pathname;
      if (
        request.method === "GET" &&
        !pathname.startsWith(`${basePath}/rpc`) &&
        !pathname.startsWith(`${basePath}/assets/`)
      ) {
        return new Response(null, {
          status: 302,
          headers: { location: `${basePath}/login` },
        });
      }
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    },
    async handle(request, loginPath, logoutPath) {
      const url = new URL(request.url);
      if (url.pathname === logoutPath) {
        if (request.method !== "POST") {
          return new Response(null, { status: 405, headers: { allow: "POST" } });
        }
        const token = cookieValue(request);
        if (token) sessions.delete(token);
        return new Response(null, {
          status: 303,
          headers: {
            location: loginPath,
            "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
            "cache-control": "no-store",
          },
        });
      }
      if (url.pathname !== loginPath) return null;
      if (request.method === "GET" || request.method === "HEAD") return htmlResponse(loginPage());
      if (request.method !== "POST") {
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD, POST" } });
      }
      const contentLength = Number(request.headers.get("content-length") ?? "0");
      if (contentLength > MAX_LOGIN_BODY_BYTES) return new Response(null, { status: 413 });
      if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
        return new Response(null, { status: 415 });
      }
      const body = await request.text();
      if (Buffer.byteLength(body) > MAX_LOGIN_BODY_BYTES)
        return new Response(null, { status: 413 });
      const form = new URLSearchParams(body);
      const username = form.get("username") ?? "";
      const password = form.get("password") ?? "";
      const now = Date.now();
      deleteOldLoginFailures(now);
      if (failedLogins.length >= MAX_FAILED_LOGINS) {
        const retryAfter = Math.max(
          1,
          Math.ceil(((failedLogins[0] ?? now) + FAILED_LOGIN_WINDOW_MS - now) / 1_000),
        );
        return new Response(null, {
          status: 429,
          headers: { "retry-after": String(retryAfter), "cache-control": "no-store" },
        });
      }
      // Reserve capacity before scrypt yields. Concurrent submissions cannot all observe the same
      // spare slot and create an unbounded password-hashing burst.
      failedLogins.push(now);
      const credentialExpiresAt = await passwordExpiry(password, now);
      if (username !== credentials.username || credentialExpiresAt === undefined) {
        return htmlResponse(loginPage(true), 401);
      }
      failedLogins.length = 0;

      deleteExpiredSessions(now);
      while (sessions.size >= MAX_SERVER_SESSIONS) {
        const oldestToken = sessions.keys().next().value as string | undefined;
        if (!oldestToken) break;
        sessions.delete(oldestToken);
      }
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Math.min(now + sessionTtlSeconds * 1_000, credentialExpiresAt);
      const maxAge = Math.ceil((expiresAt - now) / 1_000);
      sessions.set(token, { expiresAt });
      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
          "cache-control": "no-store",
        },
      });
    },
  };
}
