import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

/**
 * Serve the packaged browser bundle from memory, compressed to what the browser accepts.
 *
 * Every asset under `assets/` carries a content hash in its name, so a body read once can be
 * served for the life of the process, and the same holds for its compressed forms. The dashboard
 * is a guest in the embedder's server, so it cannot assume a proxy in front of it compresses.
 * Standalone, the demo, and plain Node middleware would otherwise ship the raw bundle on every
 * cold load.
 */

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Formats that are not already compressed; compressing them again only costs CPU. */
const compressibleExtensions: ReadonlySet<string> = new Set([
  ".css",
  ".html",
  ".js",
  ".svg",
  ".txt",
]);

/** Below this a compressed body is no smaller once its framing is counted. */
const compressionThresholdBytes = 1_024;

const cacheControl = "public, max-age=31536000, immutable";

export type AssetEncoding = "br" | "gzip" | "identity";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Quality 9 lands within a few percent of the maximum at a fraction of the first-request cost. */
const brotliOptions = { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } };

const compressors: Record<Exclude<AssetEncoding, "identity">, (body: Buffer) => Promise<Buffer>> = {
  br: (body) => brotliCompressAsync(body, brotliOptions),
  gzip: (body) => gzipAsync(body, { level: 9 }),
};

/**
 * Pick the encoding to serve from an `Accept-Encoding` header, preferring brotli.
 *
 * A listed encoding with `q=0` is refused; anything unlisted is refused too, except that `*`
 * admits both. Browsers only offer brotli over TLS or localhost, so gzip stays in play for plain
 * HTTP deployments.
 */
export function negotiateAssetEncoding(acceptEncoding: string | null): AssetEncoding {
  if (!acceptEncoding) return "identity";
  const offered = new Map<string, number>();
  for (const entry of acceptEncoding.split(",")) {
    const [name = "", ...parameters] = entry.trim().toLowerCase().split(";");
    if (!name) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const [key, value] = parameter.trim().split("=");
      if (key === "q" && value !== undefined) quality = Number(value);
    }
    offered.set(name, Number.isFinite(quality) ? quality : 0);
  }
  const accepts = (name: string): boolean => {
    const explicit = offered.get(name);
    if (explicit !== undefined) return explicit > 0;
    return (offered.get("*") ?? 0) > 0;
  };
  if (accepts("br")) return "br";
  if (accepts("gzip")) return "gzip";
  return "identity";
}

/** True when `If-None-Match` names this representation, so a 304 is the right answer. */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    // A weak validator still identifies the same bytes for a cache revalidation.
    return (trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed) === etag;
  });
}

interface CachedAsset {
  body: Buffer;
  contentType: string;
  /** Strong validator of the identity body; encoded forms append their encoding. */
  hash: string;
  compressible: boolean;
  encoded: Partial<Record<Exclude<AssetEncoding, "identity">, Promise<Buffer>>>;
}

export interface StaticAssetCache {
  /**
   * Serve one request for a path under the bundle's `assets/` directory.
   *
   * `relative` is the path after the mount point, for example `assets/index-abc123.js`. Returns
   * null for anything outside `assets/`, anything that escapes it, and anything missing.
   */
  serve(relative: string, request: Request): Promise<Response | null>;
}

export function createStaticAssetCache(directory: string): StaticAssetCache {
  const assets = new Map<string, Promise<CachedAsset>>();

  const load = (safe: string): Promise<CachedAsset> => {
    const existing = assets.get(safe);
    if (existing) return existing;
    const loading = readFile(join(directory, safe)).then((body): CachedAsset => {
      const extension = extname(safe);
      return {
        body,
        contentType: contentTypes[extension] ?? "application/octet-stream",
        hash: createHash("sha256").update(body).digest("base64url").slice(0, 27),
        compressible:
          compressibleExtensions.has(extension) && body.length >= compressionThresholdBytes,
        encoded: {},
      };
    });
    assets.set(safe, loading);
    // A missing or unreadable file is never remembered: a later deploy may add it, and a cache
    // of failures keyed on attacker-chosen paths would grow without bound.
    loading.catch(() => assets.delete(safe));
    return loading;
  };

  const encode = (asset: CachedAsset, encoding: Exclude<AssetEncoding, "identity">) => {
    const existing = asset.encoded[encoding];
    if (existing) return existing;
    const compressing = compressors[encoding](asset.body);
    asset.encoded[encoding] = compressing;
    compressing.catch(() => {
      asset.encoded[encoding] = undefined;
    });
    return compressing;
  };

  return {
    async serve(relative, request) {
      const safe = normalize(relative).replaceAll("\\", "/");
      if (!safe.startsWith("assets/") || safe.includes("../")) return null;
      let asset: CachedAsset;
      try {
        asset = await load(safe);
      } catch {
        return null;
      }

      const encoding = asset.compressible
        ? negotiateAssetEncoding(request.headers.get("accept-encoding"))
        : "identity";
      const etag = `"${asset.hash}${encoding === "identity" ? "" : `-${encoding}`}"`;
      const headers: Record<string, string> = {
        "cache-control": cacheControl,
        "content-type": asset.contentType,
        etag,
      };
      if (asset.compressible) headers.vary = "accept-encoding";
      if (etagMatches(request.headers.get("if-none-match"), etag)) {
        return new Response(null, { status: 304, headers });
      }

      let body = asset.body;
      if (encoding !== "identity") {
        try {
          body = await encode(asset, encoding);
          headers["content-encoding"] = encoding;
        } catch {
          // Compression failing is a reason to send the plain body, not to fail the request.
          headers.etag = `"${asset.hash}"`;
        }
      }
      headers["content-length"] = String(body.length);
      return new Response(request.method === "HEAD" ? null : new Uint8Array(body), { headers });
    },
  };
}
