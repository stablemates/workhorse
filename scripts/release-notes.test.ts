import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryBlob = "https://github.com/stablemates/workhorse/blob/main/";
const coldExportGuide = "docs/guides/335-cold-export.md#a-day-is-a-utc-day";

const changelogs = [
  "CHANGELOG.md",
  "go/CHANGELOG.md",
  "python/CHANGELOG.md",
  "rust/CHANGELOG.md",
  "ruby/CHANGELOG.md",
];

/** A phrase that may wrap across lines, matched case-insensitively. */
function phrase(text: string): RegExp {
  return new RegExp(text.replace(/\*/g, "\\*").replace(/ /g, "\\s+"), "i");
}

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** The 0.6.0 release: the first entry whose notes cover migrations 0045 through 0053. */
const release = "## 0.6.0 — 2026-10-02";

/** One release entry, from its heading to the next `##` heading. */
function entry(path: string, heading: string): string {
  const text = read(path);
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, `${path} has no "${heading}" heading`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** GitHub's heading anchor: lowercase, punctuation dropped, each space a hyphen. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/** Heading anchors and explicit `<a id>` anchors, which keep an old link valid after a rename. */
function anchors(path: string): Set<string> {
  const text = read(path);
  const headings = text
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => slug(line.replace(/^#{1,6} /, "")));
  const explicit = [...text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)].map((match) => match[1]!);
  return new Set([...headings, ...explicit]);
}

/** Markdown link targets, resolved to repository paths where they name this repository. */
function links(
  path: string,
  section: string,
): { target: string; file?: string; anchor?: string }[] {
  return [...section.matchAll(/\]\(([^)\s]+)\)/g)].map(([, target = ""]) => {
    if (target.startsWith("http") && !target.startsWith(repositoryBlob)) return { target };
    const [location = "", anchor] = target.replace(repositoryBlob, "/").split("#");
    const file =
      location === ""
        ? path
        : location.startsWith("/")
          ? location.slice(1)
          : relative(root, resolve(root, dirname(path), location));
    return { target, file, anchor };
  });
}

describe("release notes", () => {
  it("leave the 0.5.0 notes on the schema version that release shipped", () => {
    expect(entry("CHANGELOG.md", "## 0.5.0 — 2026-09-28")).toMatch(/^Requires \*\*schema v43\*\*/m);
  });

  it("name every migration the release adds in the root notes", () => {
    // 0.5.0 shipped schema version 43, so every migration after 0044 is new in 0.6.0.
    const shipped = Number(
      /Requires \*\*schema v(\d+)\*\*/.exec(entry("CHANGELOG.md", "## 0.5.0 — 2026-09-28"))?.[1],
    );
    const section = entry("CHANGELOG.md", release);
    const added = readdirSync(join(root, "sql/migrations"))
      .map((name) => /^(\d{4})-/.exec(name)?.[1])
      .filter(
        (number): number is string =>
          number !== undefined && Number(number) > shipped + 1 && Number(number) <= 53,
      );
    expect(added.length).toBeGreaterThan(0);
    for (const number of added) expect(section, `migration ${number}`).toContain(number);
  });

  describe.each(changelogs)("%s", (path) => {
    const section = entry(path, release);

    it("states the final schema version and the compatibility floor separately", () => {
      expect(section).toMatch(phrase(`final schema version is **52**`));
      expect(section).toMatch(phrase(`compatibility floor (?:stays at|is) schema version **43**`));
    });

    it("warns that cold exporters stop across migration 0052", () => {
      expect(section).toMatch(phrase("migration 0052"));
      expect(section).toMatch(phrase("stop every cold exporter"));
      expect(section).toMatch(phrase("object and manifest uploads"));
      expect(section).toMatch(phrase("keep cold export enabled"));
      expect(section).toMatch(phrase("restart the exporters after the migration commits"));
      expect(links(path, section).map(({ file, anchor }) => `${file}#${anchor}`)).toContain(
        coldExportGuide,
      );
    });

    it("links only to files and headings that exist", () => {
      const broken = links(path, section)
        .filter(({ file, anchor }) => {
          if (file === undefined) return false;
          if (!existsSync(join(root, file))) return true;
          return anchor !== undefined && file.endsWith(".md") && !anchors(file).has(anchor);
        })
        .map(({ target }) => target);
      expect(broken).toEqual([]);
    });
  });
});

/** The 0.6.1 release: no migration, rebuilt so the Python distribution carries attestations. */
const patch = "## 0.6.1 — 2026-10-02";

describe("0.6.1 release notes", () => {
  it("say why the release exists in the root notes", () => {
    const section = entry("CHANGELOG.md", patch);
    expect(section).toMatch(phrase("PEP 740 attestations"));
    expect(section).toMatch(phrase("adds no migration"));
  });

  describe.each(changelogs)("%s", (path) => {
    const section = entry(path, patch);

    it("keep the schema version 0.6.0 shipped", () => {
      expect(section).toMatch(/^Requires \*\*schema v43\*\*/m);
      expect(section).toMatch(phrase(`final schema version is **52**`));
      expect(entry(path, release)).toMatch(phrase(`final schema version is **52**`));
      expect(section).toMatch(phrase(`compatibility floor stays at schema version **43**`));
    });

    it("link only to files and headings that exist", () => {
      const broken = links(path, section)
        .filter(({ file, anchor }) => {
          if (file === undefined) return false;
          if (!existsSync(join(root, file))) return true;
          return anchor !== undefined && file.endsWith(".md") && !anchors(file).has(anchor);
        })
        .map(({ target }) => target);
      expect(broken).toEqual([]);
    });
  });
});

/** The 0.7.0 release: the first entry whose notes cover migrations 0054 through 0065. */
const minor = "## 0.7.0 — 2026-10-09";

describe("0.7.0 release notes", () => {
  describe.each(changelogs)("%s", (path) => {
    const section = entry(path, minor);

    it("states the current schema, compatibility floor, and migration before rollout", () => {
      expect(section).toMatch(/^Requires \*\*schema v54\*\*/m);
      expect(section).toMatch(phrase("final schema version is **64**"));
      expect(section).toMatch(phrase("compatibility floor is schema version **54**"));
      expect(section).toMatch(phrase("Migration 0054"));
      expect(section).toMatch(phrase("Migrate the schema before starting updated processes"));
    });

    it("links only to files and headings that exist", () => {
      const broken = links(path, section)
        .filter(({ file, anchor }) => {
          if (file === undefined) return false;
          if (!existsSync(join(root, file))) return true;
          return anchor !== undefined && file.endsWith(".md") && !anchors(file).has(anchor);
        })
        .map(({ target }) => target);
      expect(broken).toEqual([]);
    });
  });

  it("names every migration added after 0.6.1 in the root notes", () => {
    // 0.6.0 and 0.6.1 shipped schema version 52, and 0.7.0 shipped 64, so migrations 0054 through
    // 0065 are new in 0.7.0.
    const section = entry("CHANGELOG.md", minor);
    const added = readdirSync(join(root, "sql/migrations"))
      .map((name) => /^(\d{4})-/.exec(name)?.[1])
      .filter(
        (number): number is string =>
          number !== undefined && Number(number) > 53 && Number(number) <= 65,
      );
    expect(added.length).toBeGreaterThan(0);
    for (const number of added) expect(section, `migration ${number}`).toContain(number);
  });
});

/** The 0.7.1 release: no migration, re-cut because the npm publish of 0.7.0 stopped partway. */
const recut = "## 0.7.1 — 2026-10-09";

describe("0.7.1 release notes", () => {
  it("say why the release exists in the root notes", () => {
    const section = entry("CHANGELOG.md", recut);
    expect(section).toMatch(phrase("npm publish of 0.7.0 stopped partway"));
    expect(section).toMatch(phrase("deprecated in favour of 0.7.1"));
    expect(section).toMatch(phrase("adds no migration"));
  });

  describe.each(changelogs)("%s", (path) => {
    const section = entry(path, recut);

    it("keep the schema version 0.7.0 shipped", () => {
      expect(section).toMatch(/^Requires \*\*schema v54\*\*/m);
      expect(section).toMatch(phrase("final schema version is **64**"));
      expect(entry(path, minor)).toMatch(phrase("final schema version is **64**"));
      expect(section).toMatch(phrase("compatibility floor stays at schema version **54**"));
    });

    it("link only to files and headings that exist", () => {
      const broken = links(path, section)
        .filter(({ file, anchor }) => {
          if (file === undefined) return false;
          if (!existsSync(join(root, file))) return true;
          return anchor !== undefined && file.endsWith(".md") && !anchors(file).has(anchor);
        })
        .map(({ target }) => target);
      expect(broken).toEqual([]);
    });
  });
});

/** The 0.8.0 release: the first entry whose notes cover migrations 0066 through 0072. */
const taskGroups = "## 0.8.0 — 2026-10-13";

describe("0.8.0 release notes", () => {
  describe.each(changelogs)("%s", (path) => {
    const section = entry(path, taskGroups);

    it("states the current schema, compatibility floor, and migration before rollout", () => {
      expect(section).toMatch(/^Requires \*\*schema v69\*\*/m);
      expect(section).toMatch(phrase("final schema version is **71**"));
      expect(section).toMatch(phrase("compatibility floor is schema version **69**"));
      expect(section).toMatch(phrase("Migration 0066"));
      expect(section).toMatch(phrase("Migrate the schema before starting updated processes"));
    });

    it("does not defer task groups or the checkpoint input check to a later release", () => {
      expect(section).not.toMatch(phrase("in later releases"));
    });

    it("links only to files and headings that exist", () => {
      const broken = links(path, section)
        .filter(({ file, anchor }) => {
          if (file === undefined) return false;
          if (!existsSync(join(root, file))) return true;
          return anchor !== undefined && file.endsWith(".md") && !anchors(file).has(anchor);
        })
        .map(({ target }) => target);
      expect(broken).toEqual([]);
    });
  });

  it("names every migration added after 0.7.1 in the root notes", () => {
    // 0.7.0 and 0.7.1 shipped schema version 64, and 0.8.0 ships 71, so migrations 0066 through
    // 0072 are new in 0.8.0.
    const section = entry("CHANGELOG.md", taskGroups);
    const added = readdirSync(join(root, "sql/migrations"))
      .map((name) => /^(\d{4})-/.exec(name)?.[1])
      .filter(
        (number): number is string =>
          number !== undefined && Number(number) > 65 && Number(number) <= 72,
      );
    expect(added).toHaveLength(7);
    for (const number of added) expect(section, `migration ${number}`).toContain(number);
  });

  it("say in the root notes that all five SDKs ship task groups and the checkpoint input check", () => {
    expect(entry("CHANGELOG.md", taskGroups)).toMatch(
      phrase("All five SDKs ship task groups and the checkpoint input check in this release"),
    );
  });

  it("give the Ruby upgrade step for the eighth TaskCheckpoint member", () => {
    const section = entry("ruby/CHANGELOG.md", taskGroups);
    expect(section).toMatch(phrase("adds `input_fingerprint` as its eighth member"));
    expect(section).toMatch(phrase("seven positional arguments raises `ArgumentError`"));
    expect(section).toMatch(phrase("no compatible constructor"));
  });
});

/** The 0.9.0 release: the first entry whose notes cover migrations 0073 and 0074 and the JVM SDK. */
const heartbeats = "## 0.9.0 — 2026-10-20";

describe("0.9.0 release notes", () => {
  const withJvm = [...changelogs, "jvm/CHANGELOG.md"];

  describe.each(changelogs)("%s", (path) => {
    const section = entry(path, heartbeats);

    it("states the current schema, compatibility floor, and migration before rollout", () => {
      expect(section).toMatch(/^Requires \*\*schema v73\*\*/m);
      expect(section).toMatch(phrase("Migrations 0073 and 0074 move the schema to version **73**"));
      expect(section).toMatch(phrase("compatibility floor rises from 69 to **73**"));
      expect(section).toMatch(phrase("Migrate the schema before starting updated processes"));
    });
  });

  it("names every migration added after 0.8.0 in the root notes", () => {
    // 0.8.0 shipped schema version 71, and 0.9.0 ships 73, so migrations 0073 and 0074 are new
    // in 0.9.0.
    const section = entry("CHANGELOG.md", heartbeats);
    const added = readdirSync(join(root, "sql/migrations"))
      .map((name) => /^(\d{4})-/.exec(name)?.[1])
      .filter(
        (number): number is string =>
          number !== undefined && Number(number) > 72 && Number(number) <= 74,
      );
    expect(added).toEqual(["0073", "0074"]);
    for (const number of added) expect(section, `migration ${number}`).toContain(number);
  });

  it("name the JVM changelog in the header of the root changelog", () => {
    const header = read("CHANGELOG.md").split(/^## /m)[0]!;
    expect(header).toContain("[`jvm/CHANGELOG.md`](jvm/CHANGELOG.md)");
    expect(header).toMatch(phrase("JVM artifacts"));
  });

  it("state the three JVM artifacts, the schema, and the Java and PostgreSQL floors", () => {
    const section = entry("jvm/CHANGELOG.md", heartbeats);
    expect(section).toMatch(
      /^Requires \*\*schema v73\*\*, Java \*\*21\*\* or newer, and PostgreSQL \*\*15\*\* or newer\.$/m,
    );
    expect(section).toMatch(phrase("compatibility floor is schema version **73**"));
    for (const artifact of ["workhorse", "workhorse-kotlin", "workhorse-spring-boot-starter"]) {
      expect(section).toContain(`\`${artifact}\``);
    }
    expect(section).toContain("`run.workhorse`");
  });

  describe.each(changelogs)("%s", (path) => {
    const section = entry(path, heartbeats);

    it("states the heartbeat changes since 0.8.0 with the values of the lifecycle page", () => {
      expect(section).toMatch(phrase("Rounds start on a fixed schedule"));
      expect(section).toContain("`max(1 ms, interval × 3 / 4, min(50 ms, interval))`");
      expect(section).toMatch(phrase("For an interval of 200 ms or more, this is three quarters"));
      expect(section).toMatch(phrase("the bound is 7.5 s, so one timed-out round leaves a margin"));
      expect(section).toContain("`2 × interval + round bound < lease`");
      for (const setting of ["statement_timeout", "idle_in_transaction_session_timeout"]) {
        expect(section).toContain(`\`${setting}\``);
      }
      expect(section).toMatch(
        phrase("one half of the time that remains, and each idle gap one eighth"),
      );
      expect(section).toMatch(phrase("less than 8 ms remains"));
      expect(section).toMatch(phrase("100 ms is the smallest supported heartbeat interval"));
      expect(section).toMatch(phrase("the round bound is 75 ms"));
    });
  });

  it("state that a Rust lease leaves the heartbeat set when its watchdog expires", () => {
    const section = entry("rust/CHANGELOG.md", heartbeats);
    expect(section).toMatch(phrase("leaves the heartbeat set when the watchdog expires"));
    expect(section).toContain("`CancelReason::LeaseLost`");
  });

  it("state that a Python round prepares its statements before the server timeouts", () => {
    const section = entry("python/CHANGELOG.md", heartbeats);
    expect(section).toMatch(phrase("prepares the settings statement and the heartbeat statement"));
    expect(section).toContain("`prepare=False`");
  });

  describe.each(withJvm)("%s", (path) => {
    it("links only to files and headings that exist", () => {
      const broken = links(path, entry(path, heartbeats))
        .filter(({ file, anchor }) => {
          if (file === undefined) return false;
          if (!existsSync(join(root, file))) return true;
          return anchor !== undefined && file.endsWith(".md") && !anchors(file).has(anchor);
        })
        .map(({ target }) => target);
      expect(broken).toEqual([]);
    });
  });
});

/** The 0.10.0 release: the first entry whose notes cover migrations 0075 through 0087 and .NET. */
const firstDotnet = "## 0.10.0 — 2026-10-26";

describe("0.10.0 release notes", () => {
  const withJvm = [...changelogs, "jvm/CHANGELOG.md"];

  describe.each(changelogs)("%s", (path) => {
    const section = entry(path, firstDotnet);

    it("states the current schema, compatibility floor, and migration before rollout", () => {
      expect(section).toMatch(/^Requires \*\*schema v76\*\*/m);
      expect(section).toMatch(
        phrase("Migrations 0075 through 0087 move the schema to version **86**"),
      );
      expect(section).toMatch(phrase("compatibility floor rises from 73 to **76**"));
      expect(section).toMatch(phrase("Migrate the schema before starting updated processes"));
    });
  });

  it("names every migration added after 0.9.0 in the root notes", () => {
    // 0.9.0 shipped schema version 73, and 0.10.0 ships 86, so migrations 0075 through 0087 are
    // new in 0.10.0.
    const section = entry("CHANGELOG.md", firstDotnet);
    const added = readdirSync(join(root, "sql/migrations"))
      .map((name) => /^(\d{4})-/.exec(name)?.[1])
      .filter(
        (number): number is string =>
          number !== undefined && Number(number) > 74 && Number(number) <= 87,
      );
    expect(added).toHaveLength(13);
    for (const number of added) expect(section, `migration ${number}`).toContain(number);
  });

  it("state the schema and the Java and PostgreSQL floors in the JVM notes", () => {
    const section = entry("jvm/CHANGELOG.md", firstDotnet);
    expect(section).toMatch(
      /^Requires \*\*schema v76\*\*, Java \*\*21\*\* or newer, and PostgreSQL \*\*15\*\* or newer\.$/m,
    );
  });

  describe.each(withJvm)("%s", (path) => {
    it("links only to files and headings that exist", () => {
      const broken = links(path, entry(path, firstDotnet))
        .filter(({ file, anchor }) => {
          if (file === undefined) return false;
          if (!existsSync(join(root, file))) return true;
          return anchor !== undefined && file.endsWith(".md") && !anchors(file).has(anchor);
        })
        .map(({ target }) => target);
      expect(broken).toEqual([]);
    });
  });
});

/**
 * The first entry of the .NET changelog, the oldest one. It stays `## Unreleased` until the
 * release candidate of the first .NET publish dates it.
 */
function firstDotnetEntry(): { heading: string; section: string } {
  const heading = read("dotnet/CHANGELOG.md")
    .split("\n")
    .findLast((line) => line.startsWith("## "));
  expect(heading, "dotnet/CHANGELOG.md has no entry").toBeDefined();
  return { heading: heading!, section: entry("dotnet/CHANGELOG.md", heading!) };
}

describe("the first .NET release notes", () => {
  const packages = [
    "Workhorse",
    "Workhorse.Hosting",
    "Workhorse.EntityFrameworkCore",
    "Workhorse.AspNetCore",
  ];

  it("name the .NET packages and the .NET changelog in the header of the root changelog", () => {
    const header = read("CHANGELOG.md").split(/^## /m)[0]!;
    expect(header).toContain("[`dotnet/CHANGELOG.md`](dotnet/CHANGELOG.md)");
    expect(header).toMatch(phrase("four .NET packages"));
    for (const name of packages) expect(header).toContain(`\`${name}\``);
  });

  it("state the four packages, the schema floor, and the .NET and PostgreSQL floors", () => {
    const { section } = firstDotnetEntry();
    expect(section).toMatch(phrase("This is the first release of the .NET SDK"));
    const floor =
      /^Requires \*\*schema v(\d+)\*\*, \.NET \*\*10\*\* or newer, and PostgreSQL \*\*15\*\* or newer\.$/m.exec(
        section,
      )?.[1];
    expect(floor).toBeDefined();
    expect(section).toMatch(phrase(`compatibility floor is schema version **${floor}**`));
    for (const name of packages) expect(section).toContain(`\`${name}\``);
  });

  it("state the floor that the .NET SDK refuses to run below until the entry is dated", () => {
    const { heading, section } = firstDotnetEntry();
    if (heading !== "## Unreleased") return;
    // A dated entry is immutable, so only the undated entry follows the generated catalogue.
    const minimum = /MinimumSchemaVersion = (\d+);/.exec(
      read("dotnet/src/Workhorse/Internal/SqlCatalogue.g.cs"),
    )?.[1];
    expect(minimum).toBeDefined();
    expect(section).toContain(`Requires **schema v${minimum}**`);
  });

  it("links only to files and headings that exist", () => {
    const { section } = firstDotnetEntry();
    const broken = links("dotnet/CHANGELOG.md", section)
      .filter(({ file, anchor }) => {
        if (file === undefined) return false;
        if (!existsSync(join(root, file))) return true;
        return anchor !== undefined && file.endsWith(".md") && !anchors(file).has(anchor);
      })
      .map(({ target }) => target);
    expect(broken).toEqual([]);
  });
});
