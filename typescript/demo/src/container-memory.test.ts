import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The demo container's memory limit and its Node heap ceiling are one pair.
 *
 * V8 sizes a heap from a fixed default rather than from the container it runs in, so an uncapped
 * Node process inside the demo container believes it may grow to 4288 MB. It defers collection
 * while it believes memory remains, the container limit is reached first, and the kernel kills the
 * process without a message or a stack.
 *
 * Neither value is therefore meaningful alone, and the two live in different files: the ceiling in
 * `Dockerfile`, the limit in `DEPLOYMENT.md`. These tests read both and check that they still
 * describe one container, so changing either alone fails here rather than in production.
 */

/** Node processes the container entry point supervises, including the supervisor itself. */
const NODE_PROCESSES = 4;

/**
 * Resident set a demo Node process holds outside its JavaScript heap: the binary's mapped code,
 * the OpenTelemetry preload's native dependencies, and the PostgreSQL client's buffers. Measured
 * at 100 MiB resident with 24 MiB of live heap, whatever ceiling the process was given.
 */
const NON_HEAP_MIB_PER_NODE_PROCESS = 80;

/** Resident set of the Python and Go demo workers together, measured at 39 MiB and 15 MiB. */
const OTHER_RUNTIME_MIB = 60;

function dockerfileRuntimeStage(dockerfile: string): string {
  const runtime = dockerfile.indexOf("AS runtime");
  expect(runtime).toBeGreaterThan(-1);
  return dockerfile.slice(runtime);
}

function onlyMatch(source: string, pattern: RegExp, what: string): number {
  const matches = [...source.matchAll(pattern)];
  expect(matches, `expected exactly one ${what}`).toHaveLength(1);
  return Number(matches[0]![1]);
}

describe("demo container memory", () => {
  it("caps every Node process the published image starts", async () => {
    const dockerfile = await readFile(resolve("Dockerfile"), "utf8");
    const runtime = dockerfileRuntimeStage(dockerfile);
    expect(runtime).toMatch(/^ENV NODE_OPTIONS=--max-old-space-size=\d+$/m);
  });

  it("fits every ceiling and both other runtimes inside the documented limit", async () => {
    const [dockerfile, deployment] = await Promise.all([
      readFile(resolve("Dockerfile"), "utf8"),
      readFile(resolve("typescript/demo/DEPLOYMENT.md"), "utf8"),
    ]);
    const ceilingMib = onlyMatch(
      dockerfileRuntimeStage(dockerfile),
      /^ENV NODE_OPTIONS=--max-old-space-size=(\d+)$/gm,
      "runtime heap ceiling in Dockerfile",
    );
    const limitMib =
      onlyMatch(
        deployment,
        /The demo container is limited to one CPU, (\d+) GiB of memory/g,
        "container memory limit in DEPLOYMENT.md",
      ) * 1024;

    const worstCaseMib =
      NODE_PROCESSES * (ceilingMib + NON_HEAP_MIB_PER_NODE_PROCESS) + OTHER_RUNTIME_MIB;
    expect(worstCaseMib).toBeLessThan(limitMib);
    // A ceiling far below the limit wastes the container and collects more often than it needs to
    // on one CPU. This bound is what makes lowering the limit alone fail, too.
    expect(worstCaseMib).toBeGreaterThan(limitMib / 2);
  });

  it("states the same ceiling in the deployment contract", async () => {
    const [dockerfile, deployment] = await Promise.all([
      readFile(resolve("Dockerfile"), "utf8"),
      readFile(resolve("typescript/demo/DEPLOYMENT.md"), "utf8"),
    ]);
    const ceilingMib = onlyMatch(
      dockerfileRuntimeStage(dockerfile),
      /^ENV NODE_OPTIONS=--max-old-space-size=(\d+)$/gm,
      "runtime heap ceiling in Dockerfile",
    );
    expect(deployment).toContain(`--max-old-space-size=${ceilingMib}`);
  });
});
