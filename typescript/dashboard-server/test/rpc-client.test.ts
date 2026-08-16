import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardClient } from "../src/rpc-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dashboard browser client", () => {
  it("redirects an expired session without surfacing an RPC failure", async () => {
    const replace = vi.fn<(url: string) => void>();
    vi.stubGlobal("window", {
      location: { origin: "https://dashboard.test", replace },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Unauthorized" }, { status: 401 })),
    );
    const client = createDashboardClient("/workhorse/rpc", {
      unauthorizedRedirectUrl: "/workhorse/login",
    });

    const request = client.meta();
    let settled = false;
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());

    expect(replace).toHaveBeenCalledWith("/workhorse/login");
    expect(settled).toBe(false);
  });
});
