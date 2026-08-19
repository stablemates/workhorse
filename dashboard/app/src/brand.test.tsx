import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MantineProvider } from "@mantine/core";
import { WORKHORSE_VERSION } from "@workhorse/core/version";
import { WorkhorseBrand, WorkhorseVersion } from "./brand.js";

describe("WorkhorseBrand", () => {
  it("does not include the Workhorse version", () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <WorkhorseBrand />
      </MantineProvider>,
    );

    expect(html).not.toContain(`v${WORKHORSE_VERSION}`);
  });
});

describe("WorkhorseVersion", () => {
  it("shows the current Workhorse version", () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <WorkhorseVersion />
      </MantineProvider>,
    );

    expect(html).toContain(`aria-label="Workhorse version ${WORKHORSE_VERSION}"`);
    expect(html).toContain(`v${WORKHORSE_VERSION}`);
  });
});
