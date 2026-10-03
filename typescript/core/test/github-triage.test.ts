import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubApi,
  recoverGitHubDeliveries,
  verifyGitHubSignature,
  type GitHubScope,
} from "../../examples/github-triage.js";

const scope: GitHubScope = {
  appId: 1,
  installationId: 2,
  repositoryId: 3,
  owner: "fixture",
  repository: "issues",
  label: "triage",
  secret: "fixture-only-secret",
};
const payload = {
  action: "opened",
  repository: { id: 3, full_name: "fixture/issues" },
  installation: { id: 2 },
  issue: { id: 4, number: 5 },
};
const now = new Date("2026-10-02T12:00:00Z");

function delivery(id: number, changes: Record<string, unknown> = {}) {
  return {
    id,
    guid: randomUUID(),
    delivered_at: now.toISOString(),
    status_code: 503,
    event: "issues",
    action: "opened",
    repository_id: 3,
    installation_id: 2,
    ...changes,
  };
}

function json(value: unknown, link?: string) {
  return Response.json(value, { headers: link ? { Link: link } : {} });
}

describe("GitHub signature and authenticated recovery", () => {
  it("matches GitHub's published raw-body HMAC vector", () => {
    expect(
      verifyGitHubSignature(
        Buffer.from("Hello, World!"),
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
        "It's a Secret to Everybody",
      ),
    ).toBe(true);
  });

  it.each(["", "sha1=abc", "sha256=xx", `sha256=${"0".repeat(64)}`, `sha256=${"0".repeat(62)}`])(
    "rejects invalid signature %s without a length-comparison exception",
    (signature) => {
      expect(verifyGitHubSignature(Buffer.from("Hello, World!"), signature, scope.secret)).toBe(
        false,
      );
    },
  );

  it("signs exact UTF-8 bytes, not parsed or reformatted JSON", () => {
    const body = Buffer.from('{ "title": "雪" }');
    const signature = `sha256=${createHmac("sha256", scope.secret).update(body).digest("hex")}`;
    expect(verifyGitHubSignature(body, signature, scope.secret)).toBe(true);
    expect(verifyGitHubSignature(Buffer.from('{"title":"雪"}'), signature, scope.secret)).toBe(
      false,
    );
    expect(verifyGitHubSignature(body, signature, "rotated-secret")).toBe(false);
  });

  it("inspects both authenticated cursor pages and details, redelivering only scoped failures within three days", async () => {
    const first = delivery(1);
    const duplicate = delivery(2, { guid: first.guid });
    const boundary = delivery(3, { delivered_at: "2026-09-29T12:00:00Z", status_code: null });
    const transport = vi.fn<typeof fetch>(async (input, options) => {
      expect(options?.headers).toMatchObject({
        Authorization: "Bearer app-jwt",
        "X-GitHub-Api-Version": "2026-03-10",
      });
      expect(options?.redirect).toBe("error");
      const url = new URL(String(input));
      if (options?.method === "POST") return new Response(null, { status: 202 });
      if (url.pathname.endsWith("/1")) return json({ guid: first.guid, request: { payload } });
      if (url.pathname.endsWith("/3")) return json({ guid: boundary.guid, request: { payload } });
      if (url.searchParams.has("cursor"))
        return json([
          duplicate,
          boundary,
          delivery(4, { delivered_at: "2026-09-29T11:59:59Z" }),
          delivery(5, { repository_id: 999 }),
          delivery(6, { installation_id: 999 }),
          delivery(7, { status_code: 202 }),
          delivery(8, { action: "edited" }),
          delivery(9, { delivered_at: "2026-10-03T00:00:00Z" }),
        ]);
      return json(
        [first],
        '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next>; rel="next"',
      );
    });
    expect(
      await recoverGitHubDeliveries(new GitHubApi(async () => "app-jwt", transport), scope, now),
    ).toEqual([1, 3]);
    expect(
      transport.mock.calls
        .filter(([, options]) => options?.method === "POST")
        .map(([input]) => new URL(String(input)).pathname),
    ).toEqual(["/app/hook/deliveries/1/attempts", "/app/hook/deliveries/3/attempts"]);
  });

  it("refuses inspected bodies whose repository differs from scoped delivery metadata", async () => {
    const failed = delivery(1);
    const transport = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("?per_page")
        ? json([failed])
        : json({
            guid: failed.guid,
            request: { payload: { ...payload, repository: { id: 999 } } },
          }),
    );
    await expect(
      recoverGitHubDeliveries(new GitHubApi(async () => "app-jwt", transport), scope, now),
    ).rejects.toMatchObject({ status: 403 });
    expect(transport.mock.calls).toHaveLength(2);
  });

  it.each([
    "https://attacker.invalid/app/hook/deliveries?cursor=next",
    "https://api.github.com/other?cursor=next",
    "https://api.github.com/app/hook/deliveries?per_page=100",
  ])("rejects unsafe or cycling pagination %s before forwarding credentials", async (next) => {
    const transport = vi.fn<typeof fetch>(async () => json([], `<${next}>; rel="next"`));
    await expect(
      new GitHubApi(async () => "app-jwt", transport).list("/app/hook/deliveries?per_page=100"),
    ).rejects.toThrow(/Pagination|credentials/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("surfaces rate limits and authorization errors instead of marking recovery complete", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }));
    await expect(
      new GitHubApi(async () => "expired-jwt", transport).list("/app/hook/deliveries"),
    ).rejects.toThrow("403");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
