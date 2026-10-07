import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { DashboardSingleAdminOptions } from "@stablemates/workhorse-dashboard-contract";

const SESSION_COOKIE = "__Host-workhorse-dashboard-session";
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_BODY_BYTES = 4_096;
const MAX_SERVER_SESSIONS = 16;
const MAX_FAILED_LOGINS = 5;
const FAILED_LOGIN_WINDOW_MS = 60_000;
/** Clients whose login reservations the server tracks at once. The oldest entry leaves first. */
const MAX_TRACKED_LOGIN_CLIENTS = 1_024;
/** Password derivations that may run at once across every client. */
const MAX_CONCURRENT_PASSWORD_HASHES = 2;
/** The throttle key of every request whose transport supplied no peer address. */
const UNIDENTIFIED_CLIENT = "unidentified";
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
  handle(
    request: Request,
    loginPath: string,
    logoutPath: string,
    clientAddress?: string,
  ): Promise<Response | null>;
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

/** Read a request body while retaining at most the configured login limit. */
async function readLoginBody(request: Request): Promise<string | undefined> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_LOGIN_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/**
 * The key that login reservations are counted under for one transport peer address.
 *
 * An IPv6 client usually controls a whole /64, so its addresses share one key. An IPv4-mapped IPv6
 * address counts as its IPv4 address. A missing or unparseable address shares one key with every
 * other such request, which is the process-wide window the mode had before.
 */
export function loginThrottleKey(clientAddress: string | undefined): string {
  const address =
    clientAddress
      ?.trim()
      .replace(/^\[|\]$/g, "")
      .replace(/%.*$/, "") ?? "";
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return UNIDENTIFIED_CLIENT;
  const groups = ipv6Groups(address);
  // ::ffff:0:0/96 carries an IPv4 address in its last two groups, however the address is spelled.
  if (groups.slice(0, 6).every((group, index) => group === (index === 5 ? 0xffff : 0))) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** The 16-bit groups of one side of `::`, where a dotted IPv4 tail fills two groups. */
function ipv6GroupValues(part: string): number[] {
  if (!part) return [];
  return part.split(":").flatMap((group) => {
    if (!group.includes(".")) return [Number.parseInt(group, 16)];
    const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map(Number);
    return [(a << 8) | b, (c << 8) | d];
  });
}

/** The eight 16-bit groups of an address that `isIP` already accepted as IPv6. */
export function ipv6Groups(address: string): number[] {
  const [head = "", tail] = address.split("::");
  const headGroups = ipv6GroupValues(head);
  if (tail === undefined) return headGroups;
  const tailGroups = ipv6GroupValues(tail);
  return [
    ...headGroups,
    ...Array<number>(8 - headGroups.length - tailGroups.length).fill(0),
    ...tailGroups,
  ];
}

function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response(null, {
    status: 429,
    headers: { "retry-after": String(retryAfterSeconds), "cache-control": "no-store" },
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
  // Reservation times per throttle key, oldest first. Map order is insertion order, so the first
  // key is the client the server started tracking longest ago.
  const failedLogins = new Map<string, number[]>();
  let activePasswordHashes = 0;

  function deleteExpiredSessions(now: number): void {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
  }

  /** The client's reservations still inside the window, with every expired client removed. */
  function currentLoginFailures(key: string, now: number): number[] {
    for (const [client, reservations] of failedLogins) {
      while ((reservations[0] ?? Number.POSITIVE_INFINITY) <= now - FAILED_LOGIN_WINDOW_MS) {
        reservations.shift();
      }
      if (reservations.length === 0) failedLogins.delete(client);
    }
    const existing = failedLogins.get(key);
    if (existing) return existing;
    while (failedLogins.size >= MAX_TRACKED_LOGIN_CLIENTS) {
      const oldestClient = failedLogins.keys().next().value as string | undefined;
      if (oldestClient === undefined) break;
      failedLogins.delete(oldestClient);
    }
    const reservations: number[] = [];
    failedLogins.set(key, reservations);
    return reservations;
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
    async handle(request, loginPath, logoutPath, clientAddress) {
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
      const contentLengthHeader = request.headers.get("content-length");
      if (contentLengthHeader !== null) {
        if (!/^\d+$/.test(contentLengthHeader)) return new Response(null, { status: 413 });
        const contentLength = Number(contentLengthHeader);
        if (!Number.isSafeInteger(contentLength)) {
          return new Response(null, { status: 413 });
        }
        if (contentLength > MAX_LOGIN_BODY_BYTES) return new Response(null, { status: 413 });
      }
      if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
        return new Response(null, { status: 415 });
      }
      const body = await readLoginBody(request);
      if (body === undefined) return new Response(null, { status: 413 });
      const form = new URLSearchParams(body);
      const username = form.get("username") ?? "";
      const password = form.get("password") ?? "";
      const now = Date.now();
      // The key comes from the transport, never from a Forwarded or X-Forwarded-For value the
      // client wrote itself. A Node host reads those headers only from a peer the operator named as
      // a trusted proxy. One client's failures therefore cannot pause another client's login.
      const client = loginThrottleKey(clientAddress);
      const reservations = currentLoginFailures(client, now);
      if (reservations.length >= MAX_FAILED_LOGINS) {
        return tooManyRequests(
          Math.max(1, Math.ceil(((reservations[0] ?? now) + FAILED_LOGIN_WINDOW_MS - now) / 1_000)),
        );
      }
      // Distinct clients can each submit their own reservations, so the process separately bounds
      // how many scrypt derivations run at once.
      if (activePasswordHashes >= MAX_CONCURRENT_PASSWORD_HASHES) return tooManyRequests(1);
      // Reserve capacity before scrypt yields. Concurrent submissions cannot all observe the same
      // spare slot and create an unbounded password-hashing burst.
      reservations.push(now);
      activePasswordHashes += 1;
      let credentialExpiresAt: number | undefined;
      try {
        credentialExpiresAt = await passwordExpiry(password, now);
      } finally {
        activePasswordHashes -= 1;
      }
      if (username !== credentials.username || credentialExpiresAt === undefined) {
        return htmlResponse(loginPage(loginTemplate, true), 401);
      }
      failedLogins.delete(client);

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
          // The login route sits directly under the mount path, which is where a session starts.
          location: loginPath.slice(0, -"/login".length) || "/",
          "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
          "cache-control": "no-store",
        },
      });
    },
  };
}
