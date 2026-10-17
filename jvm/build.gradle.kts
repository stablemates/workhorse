import com.diffplug.gradle.spotless.SpotlessExtension
import net.ltgt.gradle.errorprone.CheckSeverity
import net.ltgt.gradle.errorprone.errorprone
import org.gradle.api.tasks.testing.logging.TestExceptionFormat

// The JVM SDK build (ADR 0103). The three artifacts share these conventions:
//
// - Every module compiles for the Java 21 floor on the JDK that runs Gradle, and every javac
//   warning is an error.
// - `-Pworkhorse.lint` adds Error Prone and NullAway in JSpecify mode. `pnpm jvm:lint` sets it on
//   the pinned JDK. The checkers are build-only: they live in the `errorprone` configuration, so
//   no published POM and no runtime class path names them.
// - Spotless checks the Java sources with google-java-format.

plugins {
  base
  alias(libs.plugins.kotlin.jvm) apply false
  alias(libs.plugins.errorprone) apply false
  alias(libs.plugins.spotless) apply false
}

val javaFloor = 21
val lint = providers.gradleProperty("workhorse.lint").isPresent
val catalogue = the<VersionCatalogsExtension>().named("libs")
val schema = file("../sql/schema/current.sql")

subprojects {
  group = "dev.stablemates"
  version = rootProject.version

  apply(plugin = "java-library")
  apply(plugin = "net.ltgt.errorprone")
  apply(plugin = "com.diffplug.spotless")

  dependencies {
    "errorprone"(catalogue.findLibrary("errorprone-core").get())
    "errorprone"(catalogue.findLibrary("nullaway").get())
    "testImplementation"(platform(catalogue.findLibrary("junit-bom").get()))
    "testImplementation"(catalogue.findLibrary("junit-jupiter").get())
    "testRuntimeOnly"(catalogue.findLibrary("junit-platform-launcher").get())
  }

  tasks.withType<JavaCompile>().configureEach {
    options.release = javaFloor
    options.encoding = "UTF-8"
    // The named core module requires PgJDBC, which is an automatic module.
    options.compilerArgs.addAll(listOf("-Xlint:all,-requires-automatic", "-Werror"))
    options.errorprone {
      enabled.set(lint)
      excludedPaths = ".*/internal/SqlCatalogue\\.java"
      check("NullAway", if (name == "compileJava") CheckSeverity.ERROR else CheckSeverity.OFF)
      option("NullAway:OnlyNullMarked", "true")
      option("NullAway:JSpecifyMode", "true")
    }
  }

  tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    // A database test reads PostgreSQL state, which no task input describes, so it always runs.
    outputs.upToDateWhen { false }
    inputs.file(schema)
    systemProperty("workhorse.schema", schema.path)
    testLogging {
      events("failed", "skipped")
      exceptionFormat = TestExceptionFormat.FULL
      showStandardStreams = true
    }
  }

  extensions.configure<SpotlessExtension> {
    java {
      target("src/**/*.java")
      targetExclude("**/internal/SqlCatalogue.java")
      googleJavaFormat(catalogue.findVersion("google-java-format").get().requiredVersion)
    }
  }

  // Every package is `@NullMarked` (ADR 0103), so a Kotlin caller sees JSpecify nullness.
  val verifyNullMarked =
    tasks.register("verifyNullMarked") {
      val sources = fileTree("src/main/java") { include("**/*.java") }
      inputs.files(sources)
      doLast {
        val missing =
          sources.files
            .filter { it.name != "module-info.java" }
            .map { it.parentFile }
            .toSortedSet()
            .filter { directory ->
              val info = directory.resolve("package-info.java")
              !info.isFile || !info.readText().contains("@NullMarked")
            }
        if (missing.isNotEmpty()) {
          throw GradleException(
            "Each package needs a package-info.java with @NullMarked:\n" +
              missing.joinToString("\n") { it.relativeTo(projectDir).path }
          )
        }
      }
    }

  tasks.register("lint") {
    group = "verification"
    description = "Compiles every source set with the linters, and checks @NullMarked."
    dependsOn("compileJava", "compileTestJava", verifyNullMarked)
  }
}
