import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

describe("operator enqueue priority", () => {
  it("exposes a bounded integer field and explains redrive behavior", async () => {
    const { EnqueuePriorityInput } = await import("./dashboard.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(EnqueuePriorityInput, { value: 73, onChange: () => undefined }),
      ),
    );

    expect(html).toContain('aria-label="Test task priority"');
    expect(html).toContain('value="73"');
    expect(html).toContain("Redrive keeps the source task priority");
  });
});
