// `workhorse`: the Java core, the named module `dev.stablemates.workhorse` (ADR 0103).

description = "Workhorse for Java: the client, the worker, Admin, and the dashboard backend"

dependencies {
  // PgJDBC at its floor. A caller may resolve a newer 42.7.x, and `PgjdbcVersion` refuses an
  // older one at run time.
  implementation(libs.pgjdbc)
  api(libs.jspecify)
  // The dashboard filter needs the Servlet API, which the servlet container supplies.
  compileOnly(libs.jakarta.servlet.api)
  testImplementation(libs.tomcat.embed.core)
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
      val file = output.get().file("dev/stablemates/workhorse/version.properties").asFile
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
    into("dev/stablemates/workhorse/dashboard")
  }
}
