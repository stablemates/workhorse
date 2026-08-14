import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { DashboardSingleAdminOptions } from "@workhorse/dashboard-contract";

const SESSION_COOKIE = "__Host-workhorse-dashboard-session";
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_BODY_BYTES = 4_096;
const MAX_SERVER_SESSIONS = 16;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1_024 * 1_024 } as const;

interface ParsedPasswordHash {
  salt: Buffer;
  digest: Buffer;
}

interface SingleAdminAuthentication {
  authorize(request: Request, basePath: string): true | Response;
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
  const message = failed ? "<p>Invalid username or password.</p>" : "";
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Workhorse login</title></head>
  <body>
    <main>
      <h1>Workhorse</h1>
      ${message}
      <form method="post">
        <label>Username <input name="username" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">Sign in</button>
      </form>
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
  const sessions = new Map<string, number>();

  function deleteExpiredSessions(now: number): void {
    for (const [token, expiresAt] of sessions) {
      if (expiresAt <= now) sessions.delete(token);
    }
  }

  async function passwordMatches(password: string): Promise<boolean> {
    if (password.length > 1_024) return false;
    const candidate = await derivePassword(password, parsedHash.salt, parsedHash.digest.length);
    return timingSafeEqual(candidate, parsedHash.digest);
  }

  return {
    authorize(request, basePath) {
      const token = cookieValue(request);
      if (token) {
        const expiresAt = sessions.get(token);
        if (expiresAt !== undefined && expiresAt > Date.now()) return true;
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
      const validPassword = await passwordMatches(password);
      if (username !== credentials.username || !validPassword)
        return htmlResponse(loginPage(true), 401);

      const now = Date.now();
      deleteExpiredSessions(now);
      while (sessions.size >= MAX_SERVER_SESSIONS) {
        const oldestToken = sessions.keys().next().value as string | undefined;
        if (!oldestToken) break;
        sessions.delete(oldestToken);
      }
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, now + sessionTtlSeconds * 1_000);
      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${sessionTtlSeconds}; HttpOnly; Secure; SameSite=Strict`,
          "cache-control": "no-store",
        },
      });
    },
  };
}
