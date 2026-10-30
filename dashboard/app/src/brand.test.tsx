import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkhorseBrand, workhorseMarkPaths, workhorseMarkViewBox } from "./brand.js";

describe("WorkhorseBrand", () => {
  it("does not include the Workhorse version", () => {
    const html = renderToStaticMarkup(<WorkhorseBrand />);

    expect(html).not.toContain("Workhorse version");
  });

  it("shows the mark and the wordmark, or the mark alone for the rail", () => {
    const full = renderToStaticMarkup(<WorkhorseBrand />);
    const mark = renderToStaticMarkup(<WorkhorseBrand markOnly />);

    expect(full).toContain('class="workhorse-brand__mark"');
    expect(full).toContain('class="workhorse-brand__wordmark"');
    expect(mark).toContain('class="workhorse-brand__mark"');
    expect(mark).not.toContain("workhorse-brand__wordmark");
  });

  it("draws the same mark as the brand file", () => {
    const file = readFileSync(new URL("./assets/workhorse-mark.svg", import.meta.url), "utf8");
    const filePaths = [
      ...file.matchAll(/<path fill="([^"]*)" transform="([^"]*)" d="([^"]*)"\/>/g),
    ].map(([, fill, transform, d]) => ({ fill, transform, d }));

    expect(file).toContain(`viewBox="${workhorseMarkViewBox}"`);
    expect(filePaths).toEqual(workhorseMarkPaths);
  });
});
