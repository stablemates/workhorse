// `connection-budget-probe`: the JVM probe of the connection budget benchmark (SM-1566).
// `scripts/benchmark-connection-budget.ts` runs `connectionBudgetClasspath`, then starts
// `ConnectionBudgetProbe` with `java` for each cell. Nothing in CI runs the probe. This project is
// never published: it applies no publishing plugin, and `scripts/check-jvm-release.ts` refuses a
// staged module outside the three artifacts.

description = "The JVM probe of the connection budget benchmark"

dependencies {
  implementation(project(":workhorse"))
  implementation(platform(libs.spring.boot.dependencies))
  implementation("com.zaxxer:HikariCP")
  runtimeOnly(libs.pgjdbc)
}

// The driver starts the probe with `java` rather than through Gradle, so SIGTERM reaches the
// probe itself. This task writes the class path that the driver passes to `java -cp`.
val probeClasspathFile = layout.buildDirectory.file("connection-budget-classpath.txt")
val probeRuntimeClasspath = the<SourceSetContainer>()["main"].runtimeClasspath

tasks.register("connectionBudgetClasspath") {
  description = "Writes the run-time class path of the connection budget probe"
  val runtimeClasspath = probeRuntimeClasspath
  inputs.files(runtimeClasspath)
  outputs.file(probeClasspathFile)
  doLast { probeClasspathFile.get().asFile.writeText(runtimeClasspath.asPath) }
}
