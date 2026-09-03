import resolved from "@/.source/releases.json";
import type { ResolvedReleaseLine } from "@/lib/releases";

/**
 * The published versions of the three lines, rendered from
 * `site/.source/releases.json` after `scripts/gen-docs-index.ts` has read them
 * out of `CHANGELOG.md`, `python/CHANGELOG.md`, and `go/CHANGELOG.md`.
 *
 * Reading the generated file rather than typing the versions is the whole point
 * of the page: a stale table here would turn the support policy in `SECURITY.md`
 * into a false statement, and nobody would notice, because a stale version
 * still looks like a version (ADR 0058).
 */
const lines = resolved as readonly ResolvedReleaseLine[];

/** The release date, spelled for a reader rather than for a sort. */
function released(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function Head({ columns }: { columns: readonly string[] }) {
  return (
    <thead>
      <tr className="wh-rule border-b">
        {columns.map((column) => (
          <th key={column} className="wh-mono-label py-2 pr-6 text-left font-normal last:pr-0">
            {column}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function Released({ date }: { date: string }) {
  return (
    <time className="whitespace-nowrap" dateTime={date}>
      {released(date)}
    </time>
  );
}

const cell = "wh-rule border-b py-3 pr-6 align-baseline last:pr-0";

export function ReleaseTable() {
  const superseded = lines.flatMap((line) =>
    line.earlier.map((release) => ({ line, release, key: `${line.id}-${release.version}` })),
  );

  return (
    <div className="not-prose mt-8 flex flex-col gap-10 text-[14.5px] leading-relaxed">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <Head columns={["Line", "Install", "Current version", "Released", "Receives fixes"]} />
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td className={`${cell} font-semibold`}>{line.name}</td>
                <td className={cell}>
                  <a href={line.registryUrl} className="wh-link-underline font-mono text-[12.5px]">
                    {line.artifact}
                  </a>
                  <span className="ml-2 text-fd-muted-foreground">on {line.registry}</span>
                </td>
                <td className={`${cell} font-mono text-[13px]`}>{line.current.version}</td>
                <td className={cell}>
                  <Released date={line.current.date} />
                </td>
                <td className={cell}>Yes</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* A line whose first release is its only one has nothing superseded, so
          an empty table under this heading would say the opposite of the truth. */}
      {superseded.length > 0 ? (
        <div>
          <p className="text-fd-muted-foreground">
            Every earlier published version is superseded and receives no fix.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse">
              <Head columns={["Line", "Version", "Released", "Receives fixes"]} />
              <tbody>
                {superseded.map(({ line, release, key }) => (
                  <tr key={key}>
                    <td className={`${cell} font-semibold`}>{line.name}</td>
                    <td className={`${cell} font-mono text-[13px]`}>{release.version}</td>
                    <td className={cell}>
                      <Released date={release.date} />
                    </td>
                    <td className={`${cell} text-fd-muted-foreground`}>No</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
