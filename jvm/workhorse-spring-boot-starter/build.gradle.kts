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

// A snapshot changes without notice, so no checksum in `jvm/gradle/verification-metadata.xml` can
// pin it (SM-1489). In the snapshot lane, only the two test class paths that take the snapshot BOM
// skip dependency verification. The plugin class path and every other configuration stay verified.
if (springBootLine == "snapshot") {
  listOf("testCompileClasspath", "testRuntimeClasspath").forEach {
    configurations.named(it) { resolutionStrategy.disableDependencyVerification() }
  }
}

// Each optional dependency is a feature variant of the main source set, as the core does (ADR 0103,
// "Three artifacts and their dependencies"). The published POM marks each one
// `<optional>true</optional>`, and the Gradle module metadata gives each its own capability, so a
// caller resolves none unless it asks: for example `requireFeature("health")`. Each feature names
// the class-path condition of the configuration that uses it. `scripts/check-jvm-release.ts` checks
// both files.
//
// - `jackson`: `JacksonCodecConfiguration`, `@ConditionalOnClass(JsonMapper.class)`.
// - `health`: `HealthConfiguration`, `@ConditionalOnClass(HealthIndicator.class, ...)`.
// - `servlet`: `DashboardConfiguration`, `@ConditionalOnClass(Filter.class,
//   FilterRegistrationBean.class)`. javac reads `OncePerRequestFilter` of `spring-web` through
//   `FilterRegistrationBean`.
// - `opentelemetry`: `OpenTelemetryConfiguration`, `@ConditionalOnClass(OpenTelemetry.class)`.
val optionalFeatures = listOf("jackson", "health", "servlet", "opentelemetry")
extensions.configure<JavaPluginExtension> {
  val main = the<SourceSetContainer>()["main"]
  optionalFeatures.forEach { registerFeature(it) { usingSourceSet(main) } }
}

// The Spring Boot floor gives the versions of the optional modules on both class paths of the main
// sources. No published variant extends this configuration, so no caller takes the platform.
val springBootFloor =
  configurations.dependencyScope("springBootFloor") {
    description = "The Spring Boot floor that gives the versions of the optional modules."
  }
configurations.named("compileClasspath") { extendsFrom(springBootFloor.get()) }
configurations.named("runtimeClasspath") { extendsFrom(springBootFloor.get()) }

dependencies {
  api(project(":workhorse"))
  api(libs.spring.boot.autoconfigure)
  api(libs.spring.boot.jdbc)

  springBootFloor(platform(libs.spring.boot.dependencies))
  "jacksonApi"(libs.spring.boot.jackson)
  "jacksonApi"(libs.jackson.databind)
  "healthApi"(libs.spring.boot.health)
  "servletApi"(libs.spring.web)
  "servletApi"(libs.jakarta.servlet.api)
  "opentelemetryApi"(libs.opentelemetry.api)

  // Writes META-INF/spring-configuration-metadata.json from the property classes.
  annotationProcessor(libs.spring.boot.configuration.processor)

  testImplementation(platform("org.springframework.boot:spring-boot-dependencies:$springBootTestVersion"))
  testImplementation(coreTests)
  testImplementation(libs.spring.boot.starter.test)
  testImplementation(libs.spring.boot.starter.jdbc)
  testImplementation(libs.spring.boot.jackson)
  // The jackson-databind floor of the `jackson` feature, above the version of each tested BOM.
  testImplementation(libs.jackson.databind)
  testImplementation(libs.spring.boot.health)
  testImplementation(libs.spring.web)
  testImplementation(libs.jakarta.servlet.api)
  testImplementation(libs.opentelemetry.api)
  testImplementation(libs.opentelemetry.sdk.testing)
  testImplementation(libs.spring.boot.opentelemetry)
}

// Each published variant takes the version that the compile class path resolves. The Spring Boot
// floor gives the version of each optional module that names none. jackson-databind names its
// floor, 3.1.7, which is above the version of the Spring Boot floor (ADR 0103, "Amendment: the JVM
// floors rise past their known advisories").
extensions.configure<PublishingExtension> {
  publications.named<MavenPublication>("maven") {
    versionMapping { allVariants { fromResolutionOf("compileClasspath") } }
  }
}

tasks.jar { manifest { attributes("Automatic-Module-Name" to "run.workhorse.spring") } }

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
    filter { includeTestsMatching("run.workhorse.spring.WithoutOpenTelemetryTest") }
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
