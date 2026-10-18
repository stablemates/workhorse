import { describe, expect, it } from "vitest";

import {
  bundleFiles,
  group,
  jvmTrainVersion,
  moduleProblems,
  pomProblems,
  publishedArtifacts,
  scratchDatabaseName,
  stagedFileProblems,
  tagVersion,
  withoutPublicationSecrets,
} from "./check-jvm-release.js";
import { jdbcUrl } from "./verify-release.js";
import { classifyTestDatabase, testFamilyRoots } from "./test-database-sweep.js";

const version = "0.8.0";

/** Every file a complete staging directory holds, without the optional checksums. */
function stagedFiles(artifacts: readonly string[] = publishedArtifacts): string[] {
  return artifacts.flatMap((artifact) => [
    `run/workhorse/${artifact}/maven-metadata.xml`,
    `run/workhorse/${artifact}/maven-metadata.xml.sha1`,
    ...[".jar", "-sources.jar", "-javadoc.jar", ".pom", ".module"].flatMap((suffix) => {
      const file = `run/workhorse/${artifact}/${version}/${artifact}-${version}${suffix}`;
      return [file, `${file}.asc`, `${file}.md5`, `${file}.sha1`, `${file}.sha256`];
    }),
  ]);
}

function pom(
  artifact: string,
  dependencies: string,
  overrides: Record<string, string> = {},
): string {
  const fields = {
    groupId: "run.workhorse",
    artifactId: artifact,
    version,
    name: artifact,
    description: "Workhorse",
    url: "https://workhorse.run",
    ...overrides,
  };
  return `<project>
  ${Object.entries(fields)
    .map(([name, value]) => `<${name}>${value}</${name}>`)
    .join("\n  ")}
  <licenses><license><name>Apache-2.0</name><url>https://www.apache.org/licenses/LICENSE-2.0.txt</url></license></licenses>
  <developers><developer><name>Stablemates</name></developer></developers>
  <scm><url>https://github.com/stablemates/workhorse</url></scm>
  <dependencies>${dependencies}</dependencies>
</project>`;
}

function dependency(
  dependencyGroup: string,
  artifact: string,
  depVersion: string,
  optional = false,
): string {
  return `<dependency><groupId>${dependencyGroup}</groupId><artifactId>${artifact}</artifactId><version>${depVersion}</version>${optional ? "<optional>true</optional>" : ""}</dependency>`;
}

const coreDependencies = [
  dependency("org.postgresql", "postgresql", "42.7.8"),
  dependency("jakarta.servlet", "jakarta.servlet-api", "6.0.0", true),
  dependency("io.opentelemetry", "opentelemetry-api", "1.55.0", true),
].join("");

/** The starter's optional Spring modules, by the feature variant that carries them. */
const starterFeatures: Readonly<Record<string, readonly [group: string, module: string][]>> = {
  jackson: [
    ["org.springframework.boot", "spring-boot-jackson"],
    ["tools.jackson.core", "jackson-databind"],
  ],
  health: [["org.springframework.boot", "spring-boot-health"]],
  servlet: [
    ["org.springframework", "spring-web"],
    ["jakarta.servlet", "jakarta.servlet-api"],
  ],
  opentelemetry: [["io.opentelemetry", "opentelemetry-api"]],
};

const starterDependencies = [
  dependency(group, "workhorse", version),
  dependency("org.springframework.boot", "spring-boot-autoconfigure", "4.0.8"),
  dependency("org.springframework.boot", "spring-boot-jdbc", "4.0.8"),
  ...Object.values(starterFeatures)
    .flat()
    .map(([moduleGroup, artifact]) => dependency(moduleGroup, artifact, "1.0.0", true)),
].join("");

type ModuleDependency = { group: string; module: string };

/** Module metadata with `apiElements` and one variant for each feature. */
function moduleMetadata(
  artifact: string,
  apiDependencies: readonly ModuleDependency[],
  features: Readonly<Record<string, readonly [group: string, module: string][]>>,
): string {
  return JSON.stringify({
    component: { group, module: artifact, version },
    variants: [
      { name: "apiElements", dependencies: apiDependencies },
      ...Object.entries(features).flatMap(([feature, modules]) =>
        (["Api", "Runtime"] as const).map((kind) => ({
          name: `${feature}${kind}Elements`,
          attributes: { "org.gradle.usage": kind === "Api" ? "java-api" : "java-runtime" },
          capabilities: [{ group, name: `${artifact}-${feature}`, version }],
          dependencies: modules.map(([moduleGroup, module]) => ({ group: moduleGroup, module })),
        })),
      ),
    ],
  });
}

function coreModule(apiDependencies: readonly ModuleDependency[] = []): string {
  return moduleMetadata(
    "workhorse",
    [{ group: "org.jspecify", module: "jspecify" }, ...apiDependencies],
    {
      servlet: [["jakarta.servlet", "jakarta.servlet-api"]],
      opentelemetry: [["io.opentelemetry", "opentelemetry-api"]],
    },
  );
}

function starterModule(apiDependencies: readonly ModuleDependency[] = []): string {
  return moduleMetadata(
    "workhorse-spring-boot-starter",
    [{ group, module: "workhorse" }, ...apiDependencies],
    starterFeatures,
  );
}

describe("the JVM train version", () => {
  it("reads the version of jvm/gradle.properties", () => {
    expect(jvmTrainVersion("# The train.\nversion=0.8.0\norg.gradle.daemon=false\n")).toBe("0.8.0");
    expect(() => jvmTrainVersion("org.gradle.daemon=false\n")).toThrow("declares no version");
  });

  it("reads the version of a train tag and refuses another tag", () => {
    expect(tagVersion("v0.9.0-rc.1")).toBe("0.9.0-rc.1");
    expect(() => tagVersion("python/v0.9.0")).toThrow("Expected a vX.Y.Z release tag");
  });
});

describe("the staging directory", () => {
  it("accepts the three artifacts with every signature and checksum", () => {
    expect(stagedFileProblems(stagedFiles(), version)).toEqual([]);
  });

  it("refuses the API snapshot reader and every module outside the three artifacts", () => {
    const files = [
      ...stagedFiles(),
      `run/workhorse/api-snapshot/${version}/api-snapshot-${version}.jar`,
      `org/example/other/1.0/other-1.0.jar`,
    ];
    expect(stagedFileProblems(files, version)).toEqual([
      `the staging directory holds run/workhorse/api-snapshot/${version}/api-snapshot-${version}.jar, but api-snapshot must never publish`,
      "the staging directory holds org/example/other/1.0/other-1.0.jar, outside run.workhorse",
    ]);
  });

  it("refuses an artifact version that differs from the train", () => {
    const files = stagedFiles().map((file) =>
      file.replaceAll(
        "workhorse-kotlin/0.8.0/workhorse-kotlin-0.8.0",
        "workhorse-kotlin/0.7.1/workhorse-kotlin-0.7.1",
      ),
    );
    const problems = stagedFileProblems(files, version);
    expect(problems).toContain(
      "the staging directory holds run/workhorse/workhorse-kotlin/0.7.1/workhorse-kotlin-0.7.1.pom, which is not version 0.8.0",
    );
    expect(problems).toContain("workhorse-kotlin 0.8.0 has no workhorse-kotlin-0.8.0.jar");
  });

  it("names a missing signature, checksum, or javadoc jar", () => {
    const missing = new Set([
      "run/workhorse/workhorse/0.8.0/workhorse-0.8.0.jar.asc",
      "run/workhorse/workhorse-spring-boot-starter/0.8.0/workhorse-spring-boot-starter-0.8.0.pom.md5",
      "run/workhorse/workhorse-kotlin/0.8.0/workhorse-kotlin-0.8.0-javadoc.jar",
    ]);
    expect(
      stagedFileProblems(
        stagedFiles().filter((file) => !missing.has(file)),
        version,
      ),
    ).toEqual([
      "workhorse-0.8.0.jar has no .asc file",
      "workhorse-kotlin 0.8.0 has no workhorse-kotlin-0.8.0-javadoc.jar",
      "workhorse-spring-boot-starter-0.8.0.pom has no .md5 file",
    ]);
  });

  it("leaves the maven-metadata.xml files out of the Central bundle", () => {
    const bundle = bundleFiles(stagedFiles());
    expect(bundle.some((file) => file.includes("maven-metadata.xml"))).toBe(false);
    expect(bundle).toContain("run/workhorse/workhorse/0.8.0/workhorse-0.8.0.jar.asc");
  });
});

describe("the published POMs", () => {
  it("accepts a core POM that marks the OpenTelemetry and Servlet APIs optional", () => {
    expect(pomProblems("workhorse", pom("workhorse", coreDependencies), version)).toEqual([]);
  });

  it("refuses a core POM that makes an optional API a required dependency", () => {
    const required = coreDependencies.replace(
      "<optional>true</optional></dependency>",
      "</dependency>",
    );
    expect(pomProblems("workhorse", pom("workhorse", required), version)).toEqual([
      "the workhorse POM does not declare jakarta.servlet:jakarta.servlet-api as optional",
    ]);
  });

  it("refuses a POM whose version differs from the train", () => {
    expect(
      pomProblems("workhorse", pom("workhorse", coreDependencies, { version: "0.7.1" }), version),
    ).toEqual(["the workhorse POM has version 0.7.1, not 0.8.0"]);
  });

  it("refuses a module that requires another version of the core", () => {
    const kotlin = pom("workhorse-kotlin", dependency("run.workhorse", "workhorse", "0.7.1"));
    expect(pomProblems("workhorse-kotlin", kotlin, version)).toEqual([
      "the workhorse-kotlin POM requires run.workhorse:workhorse 0.7.1, not 0.8.0",
      "the workhorse-kotlin POM requires run.workhorse:workhorse 0.7.1",
    ]);
  });

  it("refuses a POM without the metadata Central requires", () => {
    const bare = pom("workhorse-spring-boot-starter", starterDependencies)
      .replace(/<scm>.*<\/scm>/, "")
      .replace("<description>Workhorse</description>", "");
    expect(pomProblems("workhorse-spring-boot-starter", bare, version)).toEqual([
      "the workhorse-spring-boot-starter POM has no description",
      "the workhorse-spring-boot-starter POM has no scm with a url",
    ]);
  });
});

describe("the starter POM", () => {
  const starter = "workhorse-spring-boot-starter";

  it("accepts a starter POM that marks each conditional Spring module optional", () => {
    expect(pomProblems(starter, pom(starter, starterDependencies), version)).toEqual([]);
  });

  it("refuses a starter POM that makes a conditional Spring module a required dependency", () => {
    const required = starterDependencies.replace(
      /(<artifactId>spring-boot-health<\/artifactId><version>[^<]+<\/version>)<optional>true<\/optional>/,
      "$1",
    );
    expect(pomProblems(starter, pom(starter, required), version)).toEqual([
      "the workhorse-spring-boot-starter POM does not declare org.springframework.boot:spring-boot-health as optional",
    ]);
  });

  it("refuses a starter POM that leaves out a conditional Spring module", () => {
    const missing = starterDependencies.replace(
      dependency("org.springframework", "spring-web", "1.0.0", true),
      "",
    );
    expect(pomProblems(starter, pom(starter, missing), version)).toEqual([
      "the workhorse-spring-boot-starter POM does not declare org.springframework:spring-web as optional",
    ]);
  });

  it("refuses a starter POM that requires a module outside the core, auto-configuration, and JDBC", () => {
    const actuator =
      starterDependencies + dependency("org.springframework.boot", "spring-boot-actuator", "4.0.8");
    expect(pomProblems(starter, pom(starter, actuator), version)).toEqual([
      "the workhorse-spring-boot-starter POM requires org.springframework.boot:spring-boot-actuator, which must be optional",
    ]);
  });
});

describe("the core's Gradle module metadata", () => {
  it("accepts a feature variant for each optional API", () => {
    expect(moduleProblems("workhorse", coreModule(), version)).toEqual([]);
  });

  it("refuses an optional API on the main variants", () => {
    expect(
      moduleProblems(
        "workhorse",
        coreModule([{ group: "io.opentelemetry", module: "opentelemetry-api" }]),
        version,
      ),
    ).toEqual([
      "the workhorse apiElements variant requires the optional io.opentelemetry:opentelemetry-api",
    ]);
  });

  it("refuses metadata without a feature variant", () => {
    const metadata = JSON.parse(coreModule()) as { variants: { name: string }[] };
    metadata.variants = metadata.variants.filter((variant) => !variant.name.startsWith("servlet"));
    expect(moduleProblems("workhorse", JSON.stringify(metadata), version)).toEqual([
      "the workhorse module metadata has no java-api variant of workhorse-servlet",
      "the workhorse module metadata has no java-runtime variant of workhorse-servlet",
      "the workhorse module metadata has no workhorse-servlet variant with jakarta.servlet:jakarta.servlet-api",
    ]);
  });
});

describe("the starter's Gradle module metadata", () => {
  const starter = "workhorse-spring-boot-starter";

  it("accepts a feature variant for each conditional Spring module", () => {
    expect(moduleProblems(starter, starterModule(), version)).toEqual([]);
  });

  it("refuses a conditional Spring module on the main variants", () => {
    expect(
      moduleProblems(
        starter,
        starterModule([{ group: "tools.jackson.core", module: "jackson-databind" }]),
        version,
      ),
    ).toEqual([
      "the workhorse-spring-boot-starter apiElements variant requires the optional tools.jackson.core:jackson-databind",
    ]);
  });

  it("refuses metadata without a feature variant", () => {
    const metadata = JSON.parse(starterModule()) as { variants: { name: string }[] };
    metadata.variants = metadata.variants.filter((variant) => !variant.name.startsWith("health"));
    expect(moduleProblems(starter, JSON.stringify(metadata), version)).toEqual([
      "the workhorse-spring-boot-starter module metadata has no java-api variant of workhorse-spring-boot-starter-health",
      "the workhorse-spring-boot-starter module metadata has no java-runtime variant of workhorse-spring-boot-starter-health",
      "the workhorse-spring-boot-starter module metadata has no workhorse-spring-boot-starter-health variant with org.springframework.boot:spring-boot-health",
    ]);
  });

  it("refuses a feature without its runtime variant", () => {
    const metadata = JSON.parse(starterModule()) as { variants: { name: string }[] };
    metadata.variants = metadata.variants.filter(
      (variant) => variant.name !== "servletRuntimeElements",
    );
    expect(moduleProblems(starter, JSON.stringify(metadata), version)).toEqual([
      "the workhorse-spring-boot-starter module metadata has no java-runtime variant of workhorse-spring-boot-starter-servlet",
    ]);
  });
});

describe("the publication secrets", () => {
  it("keeps the four maven-central secrets out of every subprocess environment", () => {
    expect(
      withoutPublicationSecrets({
        PATH: "/usr/bin",
        MAVEN_CENTRAL_USERNAME: "user",
        MAVEN_CENTRAL_PASSWORD: "token",
        MAVEN_SIGNING_KEY: "-----BEGIN PGP PRIVATE KEY BLOCK-----",
        MAVEN_SIGNING_PASSWORD: "passphrase",
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });
});

describe("the release consumers", () => {
  it("passes the credentials of a postgres URL as JDBC parameters", () => {
    expect(
      jdbcUrl("postgres://workhorse:p%40ss@localhost:5432/workhorse_test?sslmode=disable"),
    ).toBe(
      "jdbc:postgresql://localhost:5432/workhorse_test?sslmode=disable&user=workhorse&password=p%40ss",
    );
  });

  it("names a scratch database that pnpm db:sweep can drop", () => {
    const source = "workhorse_test_eagleanton_sm_1396_jvm_r_5446c00e";
    const scratch = scratchDatabaseName(source, 4242);
    expect(scratch.length).toBeLessThanOrEqual(63);
    expect(
      classifyTestDatabase(scratch, {
        protectedNames: new Set([source]),
        familyRoots: testFamilyRoots([source]),
        currentTemplate: "",
      }),
    ).toEqual({ kind: "scratch", retired: true });
  });
});
