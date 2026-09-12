import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MantineProvider } from "@mantine/core";
import { WorkhorseBrand, WorkhorseVersion } from "./brand.js";

describe("WorkhorseBrand", () => {
  it("does not include the Workhorse version", () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <WorkhorseBrand />
      </MantineProvider>,
    );

    expect(html).not.toContain("Workhorse version");
  });
});

describe("WorkhorseVersion", () => {
  it("shows the beta label and current version", () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <WorkhorseVersion version="9.8.7" />
      </MantineProvider>,
    );

    expect(html).toContain('aria-label="Workhorse version 9.8.7"');
    expect(html).toContain("v9.8.7");
    expect(html).toContain("Public beta");
    expect(html).not.toContain("inside a major line a migration only adds");
  });

  it("omits the version when a direct React consumer does not supply one", () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <WorkhorseVersion />
      </MantineProvider>,
    );

    expect(html).toContain("Public beta");
    expect(html).not.toContain("Workhorse version");
  });
});
