import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { DashboardSingleAdminOptions } from "@workhorse-js/dashboard-contract";

const SESSION_COOKIE = "__Host-workhorse-dashboard-session";
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_BODY_BYTES = 4_096;
const MAX_SERVER_SESSIONS = 16;
const MAX_FAILED_LOGINS = 5;
const FAILED_LOGIN_WINDOW_MS = 60_000;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1_024 * 1_024 } as const;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const LOGIN_ERROR_PLACEHOLDER = "<!--__WORKHORSE_LOGIN_ERROR__-->";

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

function loginPage(template: string, failed = false): string {
  const message = failed
    ? '<p class="login-error" role="alert">Invalid username or password.</p>'
    : "";
  if (!template.includes(LOGIN_ERROR_PLACEHOLDER)) {
    throw new Error(`Dashboard login template is missing ${LOGIN_ERROR_PLACEHOLDER}`);
  }
  return template.replace(LOGIN_ERROR_PLACEHOLDER, message);
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
  loginTemplate: string,
): SingleAdminAuthentication {
  loginPage(loginTemplate);
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
      if (request.method === "GET" || request.method === "HEAD")
        return htmlResponse(loginPage(loginTemplate));
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
        return htmlResponse(loginPage(loginTemplate, true), 401);
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
