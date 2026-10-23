import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DerbyStatusLine } from "./derby-status";

describe("the Derby status line", () => {
  it("keeps the race clock visible and outside the live region", () => {
    const markup = renderToStaticMarkup(
      <DerbyStatusLine status={{ announcement: "racing", clock: "t+04.2", won: false }} />,
    );
    expect(markup).toContain('<span role="status" aria-live="polite">racing</span>');
    expect(markup).toMatch(/<\/span><span> — t\+04\.2<\/span><\/span>$/);
  });

  it("shows only the announcement when no race runs", () => {
    const markup = renderToStaticMarkup(
      <DerbyStatusLine
        status={{
          announcement: "foal-tolerant wins — you picked the winner",
          clock: null,
          won: true,
        }}
      />,
    );
    expect(markup).toContain(
      '<span role="status" aria-live="polite">foal-tolerant wins — you picked the winner</span></span>',
    );
    expect(markup).toContain("text-safety-600");
    expect(markup).not.toContain("t+");
  });
});
