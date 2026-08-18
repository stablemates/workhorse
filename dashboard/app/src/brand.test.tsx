import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MantineProvider } from "@mantine/core";
import { WORKHORSE_VERSION } from "@workhorse/core/version";
import { WorkhorseBrand } from "./brand.js";

describe("WorkhorseBrand", () => {
  it("shows the current Workhorse version", () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <WorkhorseBrand />
      </MantineProvider>,
    );

    expect(html).toContain(`aria-label="Workhorse version ${WORKHORSE_VERSION}"`);
    expect(html).toContain(`v${WORKHORSE_VERSION}`);
  });
});
