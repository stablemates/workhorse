import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createStaticAssetCache,
  etagMatches,
  negotiateAssetEncoding,
} from "../src/server/static-assets.js";

describe("negotiateAssetEncoding", () => {
  it("prefers brotli, then gzip, then identity", () => {
    expect(negotiateAssetEncoding("gzip, deflate, br")).toBe("br");
    expect(negotiateAssetEncoding("gzip, deflate")).toBe("gzip");
    expect(negotiateAssetEncoding("deflate")).toBe("identity");
    expect(negotiateAssetEncoding(null)).toBe("identity");
  });

  it("honours refusals and wildcards", () => {
    expect(negotiateAssetEncoding("br;q=0, gzip")).toBe("gzip");
    expect(negotiateAssetEncoding("gzip;q=0, br;q=0")).toBe("identity");
    expect(negotiateAssetEncoding("*")).toBe("br");
    expect(negotiateAssetEncoding("*;q=0, gzip")).toBe("gzip");
  });
});

describe("etagMatches", () => {
  it("matches strong, weak, listed, and wildcard validators", () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"xyz", "abc"', '"abc"')).toBe(true);
    expect(etagMatches("*", '"abc"')).toBe(true);
    expect(etagMatches('"abc-br"', '"abc"')).toBe(false);
    expect(etagMatches(null, '"abc"')).toBe(false);
  });
});

const script = "export const answer = 42;\n".repeat(200);
const request = (name: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://dashboard.test/assets/${name}`, { headers, method });

describe("createStaticAssetCache", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "workhorse-dashboard-assets-"));
    await mkdir(path.join(directory, "assets"));
    await writeFile(path.join(directory, "assets", "index-abc.js"), script);
    await writeFile(path.join(directory, "assets", "mark.png"), Buffer.alloc(4_096, 7));
    await writeFile(path.join(directory, "assets", "tiny.js"), "1;");
    await writeFile(path.join(directory, "secret.txt"), "not served");
  });

  it("serves the plain body with a strong validator and immutable caching", async () => {
    const cache = createStaticAssetCache(directory);
    const response = await cache.serve("assets/index-abc.js", request("index-abc.js"));

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response?.headers.get("content-encoding")).toBeNull();
    expect(response?.headers.get("vary")).toBe("accept-encoding");
    expect(response?.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    expect(response?.headers.get("content-length")).toBe(String(script.length));
    expect(await response?.text()).toBe(script);
  });

  it("compresses to what the browser accepts and answers a revalidation with 304", async () => {
    const cache = createStaticAssetCache(directory);
    const brotli = await cache.serve(
      "assets/index-abc.js",
      request("index-abc.js", { "accept-encoding": "gzip, deflate, br" }),
    );
    expect(brotli?.headers.get("content-encoding")).toBe("br");
    const brotliBody = Buffer.from(await brotli!.arrayBuffer());
    expect(brotliBody.length).toBeLessThan(script.length);
    expect(brotli?.headers.get("content-length")).toBe(String(brotliBody.length));
    expect(brotliDecompressSync(brotliBody).toString()).toBe(script);

    const gzip = await cache.serve(
      "assets/index-abc.js",
      request("index-abc.js", { "accept-encoding": "gzip" }),
    );
    expect(gzip?.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await gzip!.arrayBuffer())).toString()).toBe(script);

    // Each representation has its own validator, so a gzip cache cannot revalidate as brotli.
    const brotliEtag = brotli!.headers.get("etag")!;
    const gzipEtag = gzip!.headers.get("etag")!;
    expect(brotliEtag).not.toBe(gzipEtag);
    const revalidated = await cache.serve(
      "assets/index-abc.js",
      request("index-abc.js", { "accept-encoding": "br", "if-none-match": brotliEtag }),
    );
    expect(revalidated?.status).toBe(304);
    expect(revalidated?.headers.get("etag")).toBe(brotliEtag);
    expect(revalidated?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const stale = await cache.serve(
      "assets/index-abc.js",
      request("index-abc.js", { "accept-encoding": "br", "if-none-match": gzipEtag }),
    );
    expect(stale?.status).toBe(200);
  });

  it("reuses one read and one compression per asset", async () => {
    const cache = createStaticAssetCache(directory);
    const first = await cache.serve(
      "assets/index-abc.js",
      request("index-abc.js", { "accept-encoding": "br" }),
    );
    const second = await cache.serve(
      "assets/index-abc.js",
      request("index-abc.js", { "accept-encoding": "br" }),
    );
    expect(await first!.arrayBuffer()).toEqual(await second!.arrayBuffer());
    expect(first!.headers.get("etag")).toBe(second!.headers.get("etag"));
  });

  it("leaves already-compressed and tiny bodies alone", async () => {
    const cache = createStaticAssetCache(directory);
    const image = await cache.serve(
      "assets/mark.png",
      request("mark.png", { "accept-encoding": "br" }),
    );
    expect(image?.headers.get("content-encoding")).toBeNull();
    expect(image?.headers.get("vary")).toBeNull();
    expect(image?.headers.get("content-type")).toBe("image/png");
    const tiny = await cache.serve(
      "assets/tiny.js",
      request("tiny.js", { "accept-encoding": "br" }),
    );
    expect(tiny?.headers.get("content-encoding")).toBeNull();
    expect(await tiny?.text()).toBe("1;");
  });

  it("sends headers without a body for HEAD", async () => {
    const cache = createStaticAssetCache(directory);
    const response = await cache.serve(
      "assets/index-abc.js",
      request("index-abc.js", { "accept-encoding": "br" }, "HEAD"),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-encoding")).toBe("br");
    expect(response?.body).toBeNull();
  });

  it("refuses paths outside assets and reports missing files as unowned", async () => {
    const cache = createStaticAssetCache(directory);
    expect(await cache.serve("secret.txt", request("../secret.txt"))).toBeNull();
    expect(await cache.serve("assets/../secret.txt", request("../secret.txt"))).toBeNull();
    expect(await cache.serve("assets/missing.js", request("missing.js"))).toBeNull();
  });
});
