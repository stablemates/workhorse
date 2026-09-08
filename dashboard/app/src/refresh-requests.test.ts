import { describe, expect, it, vi } from "vitest";
import { createRefreshRequests } from "./refresh-requests.js";

describe("dashboard refresh requests", () => {
  it("shares a slow read while allowing another filter to load", async () => {
    const requests = createRefreshRequests();
    let finish!: (value: number) => void;
    const read = vi.fn<() => Promise<number>>(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const first = requests.run("tasks:a", read);
    const second = requests.run("tasks:a", read);
    expect(await requests.run("tasks:b", async () => 2)).toBe(2);
    expect(read).toHaveBeenCalledTimes(1);
    finish(1);
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    expect(requests.has("tasks:a")).toBe(false);
  });

  it("reads again after a mutation instead of reusing a pre-mutation snapshot", async () => {
    const requests = createRefreshRequests();
    let finish!: (value: string) => void;
    const old = requests.run(
      "tasks",
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    const read = vi.fn<() => Promise<string>>(async () => "new");
    const updated = requests.run("tasks", read, true);
    expect(read).not.toHaveBeenCalled();
    finish("old");
    expect(await old).toBe("old");
    expect(await updated).toBe("new");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("allows retry after rejection", async () => {
    const requests = createRefreshRequests();
    await expect(
      requests.run("tasks", async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(await requests.run("tasks", async () => "online")).toBe("online");
  });
});
