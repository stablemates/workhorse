import { access, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The demo image carries what `pnpm deploy --prod` resolves for this package. The dashboard facade
// brings Vite and the React UI libraries, which tripled the image's file count and slowed every
// deploy's push and unpack (SM-852). These checks keep it out.
const facade = "@stablemates/workhorse-dashboard";

describe("demo image contents", () => {
  it("serves the dashboard from the server package and keeps the facade for development", async () => {
    const manifest = JSON.parse(
      await readFile(resolve("typescript/demo/package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      files: string[];
    };

    expect(manifest.dependencies).not.toHaveProperty(facade);
    expect(manifest.dependencies).toHaveProperty("@stablemates/workhorse-dashboard-server");
    expect(manifest.devDependencies).toHaveProperty(facade);
    for (const file of manifest.files.filter((entry) => entry !== "dist")) {
      await expect(access(resolve("typescript/demo", file))).resolves.toBeUndefined();
    }
  });

  it("imports the facade only on demand, in development mode", async () => {
    const directory = resolve("typescript/demo/src");
    const sources = (await readdir(directory)).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    const staticImporters: string[] = [];
    for (const name of sources) {
      const source = await readFile(resolve(directory, name), "utf8");
      if (new RegExp(`from "${facade}[/"]`).test(source)) staticImporters.push(name);
    }
    expect(staticImporters).toEqual([]);
    const index = await readFile(resolve(directory, "index.ts"), "utf8");
    expect(index).toContain(`mode === "development"`);
    expect(index).toContain(`await import("${facade}/dev")`);
  });

  it("removes development dependencies before the deploy that fills the image", async () => {
    // `--prod` still lets a development dependency satisfy core's optional peer on the facade.
    const dockerfile = await readFile(resolve("Dockerfile"), "utf8");
    const removal = dockerfile.indexOf("npm pkg delete devDependencies");
    const deploy = dockerfile.indexOf("pnpm --filter @stablemates/workhorse-demo deploy --prod");
    expect(removal).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(removal);
  });
});
