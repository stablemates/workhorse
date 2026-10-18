import { describe, expect, it } from "vitest";

import {
  bundleFiles,
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
    `dev/stablemates/${artifact}/maven-metadata.xml`,
    `dev/stablemates/${artifact}/maven-metadata.xml.sha1`,
    ...[".jar", "-sources.jar", "-javadoc.jar", ".pom", ".module"].flatMap((suffix) => {
      const file = `dev/stablemates/${artifact}/${version}/${artifact}-${version}${suffix}`;
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
    groupId: "dev.stablemates",
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

function dependency(group: string, artifact: string, depVersion: string, optional = false): string {
  return `<dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${depVersion}</version>${optional ? "<optional>true</optional>" : ""}</dependency>`;
}

const coreDependencies = [
  dependency("org.postgresql", "postgresql", "42.7.8"),
  dependency("jakarta.servlet", "jakarta.servlet-api", "6.0.0", true),
  dependency("io.opentelemetry", "opentelemetry-api", "1.55.0", true),
].join("");

function coreModule(apiDependencies: readonly { group: string; module: string }[] = []): string {
  const capability = (feature: string) => [
    { group: "dev.stablemates", name: `workhorse-${feature}`, version },
  ];
  return JSON.stringify({
    component: { group: "dev.stablemates", module: "workhorse", version },
    variants: [
      {
        name: "apiElements",
        dependencies: [{ group: "org.jspecify", module: "jspecify" }, ...apiDependencies],
      },
      {
        name: "servletApiElements",
        capabilities: capability("servlet"),
        dependencies: [{ group: "jakarta.servlet", module: "jakarta.servlet-api" }],
      },
      {
        name: "opentelemetryApiElements",
        capabilities: capability("opentelemetry"),
        dependencies: [{ group: "io.opentelemetry", module: "opentelemetry-api" }],
      },
    ],
  });
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
      `dev/stablemates/api-snapshot/${version}/api-snapshot-${version}.jar`,
      `org/example/other/1.0/other-1.0.jar`,
    ];
    expect(stagedFileProblems(files, version)).toEqual([
      `the staging directory holds dev/stablemates/api-snapshot/${version}/api-snapshot-${version}.jar, but api-snapshot must never publish`,
      "the staging directory holds org/example/other/1.0/other-1.0.jar, outside dev.stablemates",
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
      "the staging directory holds dev/stablemates/workhorse-kotlin/0.7.1/workhorse-kotlin-0.7.1.pom, which is not version 0.8.0",
    );
    expect(problems).toContain("workhorse-kotlin 0.8.0 has no workhorse-kotlin-0.8.0.jar");
  });

  it("names a missing signature, checksum, or javadoc jar", () => {
    const missing = new Set([
      "dev/stablemates/workhorse/0.8.0/workhorse-0.8.0.jar.asc",
      "dev/stablemates/workhorse-spring-boot-starter/0.8.0/workhorse-spring-boot-starter-0.8.0.pom.md5",
      "dev/stablemates/workhorse-kotlin/0.8.0/workhorse-kotlin-0.8.0-javadoc.jar",
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
    expect(bundle).toContain("dev/stablemates/workhorse/0.8.0/workhorse-0.8.0.jar.asc");
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
    const kotlin = pom("workhorse-kotlin", dependency("dev.stablemates", "workhorse", "0.7.1"));
    expect(pomProblems("workhorse-kotlin", kotlin, version)).toEqual([
      "the workhorse-kotlin POM requires dev.stablemates:workhorse 0.7.1, not 0.8.0",
      "the workhorse-kotlin POM requires dev.stablemates:workhorse 0.7.1",
    ]);
  });

  it("refuses a POM without the metadata Central requires", () => {
    const bare = pom(
      "workhorse-spring-boot-starter",
      dependency("dev.stablemates", "workhorse", version),
    )
      .replace(/<scm>.*<\/scm>/, "")
      .replace("<description>Workhorse</description>", "");
    expect(pomProblems("workhorse-spring-boot-starter", bare, version)).toEqual([
      "the workhorse-spring-boot-starter POM has no description",
      "the workhorse-spring-boot-starter POM has no scm with a url",
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
    metadata.variants = metadata.variants.filter(
      (variant) => variant.name !== "servletApiElements",
    );
    expect(moduleProblems("workhorse", JSON.stringify(metadata), version)).toEqual([
      "the workhorse module metadata has no workhorse-servlet variant with jakarta.servlet:jakarta.servlet-api",
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
