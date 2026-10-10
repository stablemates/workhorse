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

  it("links the source revision beside the version when the build names one", () => {
    const revision = "8d94d3fd0123456789abcdef0123456789abcdef";
    const html = renderToStaticMarkup(
      <MantineProvider>
        <WorkhorseVersion version="9.8.7" revision={revision} />
      </MantineProvider>,
    );

    expect(html).toContain('aria-label="Workhorse version 9.8.7"');
    expect(html).toContain(`href="https://github.com/stablemates/workhorse/commit/${revision}"`);
    expect(html).toContain(`aria-label="Workhorse revision ${revision}"`);
    expect(html).toContain(">8d94d3f</a>");
  });

  it("shows no revision for a published release", () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <WorkhorseVersion version="9.8.7" />
      </MantineProvider>,
    );

    expect(html).not.toContain("Workhorse revision");
    expect(html).not.toContain("/commit/");
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
