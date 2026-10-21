// `workhorse`: the Java core, the named module `run.workhorse` (ADR 0103).

description = "Workhorse for Java: the client, the worker, Admin, and the dashboard backend"

// The two optional dependencies are feature variants of the main source set (ADR 0103, "Three
// artifacts and their dependencies"). The published POM marks each one `<optional>true</optional>`,
// and the Gradle module metadata gives each its own capability, so a caller resolves neither unless
// it asks: for example `requireFeature("opentelemetry")`. `scripts/check-jvm-release.ts` checks both
// files.
extensions.configure<JavaPluginExtension> {
  val main = the<SourceSetContainer>()["main"]
  registerFeature("servlet") { usingSourceSet(main) }
  registerFeature("opentelemetry") { usingSourceSet(main) }
}

dependencies {
  // PgJDBC at its floor. A caller may resolve a newer 42.7.x, and `PgjdbcVersion` refuses an
  // older one at run time.
  implementation(libs.pgjdbc)
  api(libs.jspecify)
  // The dashboard filter needs the Servlet API, which the servlet container supplies.
  "servletApi"(libs.jakarta.servlet.api)
  // OpenTelemetry is optional (ADR 0103, "Telemetry"): the caller's class path supplies the API.
  "opentelemetryApi"(libs.opentelemetry.api)
  testImplementation(libs.tomcat.embed.core)
  // A real pool for the tests of the connection budget: its own wait for a connection is 30 s,
  // longer than a lease (SM-1569).
  testImplementation(libs.hikaricp) { exclude(group = "org.slf4j") }
  testRuntimeOnly(libs.slf4j.api)
  testImplementation(libs.opentelemetry.api)
  testImplementation(libs.opentelemetry.sdk.testing)
}

// `WithoutOpenTelemetryTest`, tagged `without-opentelemetry`, runs on a class path with no
// OpenTelemetry jar, so it proves that the SDK loads and runs without the optional API. The other
// test classes name OpenTelemetry types and cannot load there. `test` depends on this task.
val testSources = the<SourceSetContainer>()["test"]
val withoutOpenTelemetry =
  tasks.register<Test>("testWithoutOpenTelemetry") {
    description = "Runs the tests tagged without-opentelemetry with no OpenTelemetry jar."
    group = "verification"
    testClassesDirs = testSources.output.classesDirs
    classpath = testSources.runtimeClasspath.filter { !it.name.startsWith("opentelemetry-") }
    filter { includeTestsMatching("run.workhorse.WithoutOpenTelemetryTest") }
    useJUnitPlatform { includeTags("without-opentelemetry") }
  }

tasks.test {
  useJUnitPlatform { excludeTags("without-opentelemetry") }
  dependsOn(withoutOpenTelemetry)
}

// The SDK version as a class path resource, so the dashboard reports `project.version` on the class
// path, where a jar has no module descriptor.
val versionResource =
  tasks.register("versionResource") {
    val value = project.version.toString()
    val output = layout.buildDirectory.dir("generated/version-resource")
    inputs.property("version", value)
    outputs.dir(output)
    doLast {
      val file = output.get().file("run/workhorse/version.properties").asFile
      file.parentFile.mkdirs()
      file.writeText("version=$value\n")
    }
  }

// The jar carries the committed browser bundle as class path resources next to `Dashboard`.
// `pnpm dashboard-bundle:check` checks the digest of these files.
tasks.processResources {
  from(versionResource)
  from("../../dashboard/v1/bundle") {
    include("bundle.json", "read-surface-*.tar.gz")
    into("run/workhorse/dashboard")
  }
}
