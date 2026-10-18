// `workhorse-spring-boot-starter`: auto-configuration, transactions, lifecycle, and health
// (ADR 0103, "Spring Boot starter").

description = "Workhorse for Spring Boot: auto-configuration, transactions, lifecycle, and health"

// The tests use the scratch database support of the core's test sources.
evaluationDependsOn(":workhorse")

val coreTests = project(":workhorse").the<SourceSetContainer>()["test"].output

// The Spring Boot line of the test class paths: `4.0` (the floor), `4.1`, or `snapshot`. The main
// sources always compile against the floor, so a newer line tests the floor-compiled jar.
val springBootLine = providers.gradleProperty("workhorse.springBoot").getOrElse("4.0")
val springBootTestVersion =
  the<VersionCatalogsExtension>()
    .named("libs")
    .findVersion(
      when (springBootLine) {
        "4.0" -> "spring-boot"
        "4.1" -> "spring-boot-4-1"
        "snapshot" -> "spring-boot-snapshot"
        else -> throw GradleException("workhorse.springBoot must be 4.0, 4.1, or snapshot")
      }
    )
    .get()
    .requiredVersion

dependencies {
  api(project(":workhorse"))
  api(libs.spring.boot.autoconfigure)
  api(libs.spring.boot.jdbc)

  // Jackson, Actuator health, the servlet registration, and OpenTelemetry are optional (ADR 0103).
  // Each configuration that uses one is conditional on its classes.
  compileOnly(platform(libs.spring.boot.dependencies))
  compileOnly(libs.spring.boot.jackson)
  compileOnly(libs.jackson.databind)
  compileOnly(libs.spring.boot.health)
  compileOnly(libs.spring.web)
  compileOnly(libs.jakarta.servlet.api)
  compileOnly(libs.opentelemetry.api)

  // Writes META-INF/spring-configuration-metadata.json from the property classes.
  annotationProcessor(libs.spring.boot.configuration.processor)

  testImplementation(platform("org.springframework.boot:spring-boot-dependencies:$springBootTestVersion"))
  testImplementation(coreTests)
  testImplementation(libs.spring.boot.starter.test)
  testImplementation(libs.spring.boot.starter.jdbc)
  testImplementation(libs.spring.boot.jackson)
  testImplementation(libs.spring.boot.health)
  testImplementation(libs.spring.web)
  testImplementation(libs.jakarta.servlet.api)
  testImplementation(libs.opentelemetry.api)
  testImplementation(libs.opentelemetry.sdk.testing)
  testImplementation(libs.spring.boot.opentelemetry)
}

tasks.jar { manifest { attributes("Automatic-Module-Name" to "dev.stablemates.workhorse.spring") } }

// `WithoutOpenTelemetryTest`, tagged `without-opentelemetry`, runs on a class path with no
// OpenTelemetry jar, so it proves that the starter starts its context without the optional API. The
// other test classes can name OpenTelemetry types and cannot load there. `test` depends on this task.
val testSources = the<SourceSetContainer>()["test"]
val withoutOpenTelemetry =
  tasks.register<Test>("testWithoutOpenTelemetry") {
    description = "Runs the tests tagged without-opentelemetry with no OpenTelemetry jar."
    group = "verification"
    testClassesDirs = testSources.output.classesDirs
    classpath = testSources.runtimeClasspath.filter { !it.name.startsWith("opentelemetry-") }
    filter { includeTestsMatching("dev.stablemates.workhorse.spring.WithoutOpenTelemetryTest") }
    useJUnitPlatform { includeTags("without-opentelemetry") }
    systemProperty("workhorse.springBoot", springBootLine)
  }

tasks.test {
  systemProperty("workhorse.springBoot", springBootLine)
  useJUnitPlatform { excludeTags("without-opentelemetry") }
  dependsOn(withoutOpenTelemetry)
}

// The configuration processor claims no annotation, so javac's `processing` lint would warn on
// every Spring annotation. Every other lint stays an error.
tasks.compileJava {
  options.compilerArgs.add("-Xlint:-processing")
  // The processor merges META-INF/additional-spring-configuration-metadata.json from the
  // resources output.
  inputs.files(tasks.processResources)
  // An incremental compile gives the processor only the changed classes, so it would write
  // metadata without the descriptions of the other properties.
  options.isIncremental = false
}
