import { describe, expect, it } from "vitest";
import { dropdownActivitySnapshot } from "./dropdown-activity.js";

describe("dashboard dropdown activity", () => {
  it("blocks refresh only for an open task-list context menu", () => {
    expect(
      dropdownActivitySnapshot(
        new Map([
          ["theme", { opened: true, blocksRefresh: false }],
          ["workspace", { opened: true, blocksRefresh: false }],
        ]),
      ),
    ).toEqual({ opened: true, refreshBlocked: false });

    expect(
      dropdownActivitySnapshot(
        new Map([
          ["theme", { opened: true, blocksRefresh: false }],
          ["task-actions", { opened: true, blocksRefresh: true }],
        ]),
      ),
    ).toEqual({ opened: true, refreshBlocked: true });
  });
});
