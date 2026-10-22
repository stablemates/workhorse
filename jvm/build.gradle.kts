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
// - Spotless checks the Java sources with google-java-format, and the Kotlin sources with ktfmt.
// - Gradle verifies each plugin and library against its sha256 checksum in
//   `gradle/verification-metadata.xml`. After a dependency change, `pnpm jvm:verification-metadata`
//   writes that file again (SM-1489).

plugins {
  base
  alias(libs.plugins.kotlin.jvm) apply false
  alias(libs.plugins.errorprone) apply false
  alias(libs.plugins.spotless) apply false
  alias(libs.plugins.dokka) apply false
}

val javaFloor = 21
val lint = providers.gradleProperty("workhorse.lint").isPresent
val catalogue = the<VersionCatalogsExtension>().named("libs")
val schema = file("../sql/schema/current.sql")

subprojects {
  group = "run.workhorse"
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
    // A lint run compiles each source set in full, as a fresh CI checkout does. An incremental
    // compile reads the unchanged classes from bytecode, and javac writes the type annotations of a
    // compact record constructor's parameters as field annotations. NullAway then reads
    // `Map<String, @Nullable Object>` as `Map<String, Object>` and reports a false error (SM-1591).
    if (lint) options.isIncremental = false
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
    // The train version, which a test compares with the `sdk_version` that a worker registers.
    systemProperty("workhorse.version", project.version.toString())
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
    pluginManager.withPlugin("org.jetbrains.kotlin.jvm") {
      kotlin {
        target("src/**/*.kt")
        ktfmt(catalogue.findVersion("ktfmt").get().requiredVersion).googleStyle()
      }
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

// The three artifacts of ADR 0103 publish to Maven Central. `api-snapshot` is a build tool and never
// publishes, so it gets no publication.
val publishedArtifacts = setOf("workhorse", "workhorse-kotlin", "workhorse-spring-boot-starter")

// The local Maven repository that the release stage zips and uploads to the Central Portal
// (ADR 0103, "Governed surface and release"). `scripts/check-jvm-release.ts` reads it.
val stagingRepository = layout.buildDirectory.dir("staging-deploy")

// The signing key and its passphrase. The release stage reads both from the `maven-central`
// environment secrets, and the dry run passes a throwaway key that it generates. Without a key the
// publications are not signed, and `scripts/check-jvm-release.ts` refuses the staging directory.
val signingKey = providers.environmentVariable("MAVEN_SIGNING_KEY")
val signingPassword = providers.environmentVariable("MAVEN_SIGNING_PASSWORD")

configure(subprojects.filter { it.name in publishedArtifacts }) {
  apply(plugin = "maven-publish")
  apply(plugin = "signing")

  extensions.configure<JavaPluginExtension> {
    withSourcesJar()
    withJavadocJar()
  }

  // Each published jar names its artifact and the train version in its manifest, so a person or a
  // tool that holds only the jar can tell which release it is. The worker reads its `sdk_version`
  // from `version.properties` instead (`run.workhorse.internal.SdkVersion`), because a named module
  // does not see these entries. `scripts/check-jvm-release.ts` checks both entries in each jar.
  tasks.withType<Jar>().configureEach {
    manifest {
      attributes(
        "Implementation-Title" to project.name,
        "Implementation-Version" to project.version.toString(),
      )
    }
  }

  // Central requires a `-javadoc.jar`. A doclint warning about a missing comment does not fail the
  // release, but every other doclint error does.
  tasks.withType<Javadoc>().configureEach {
    (options as StandardJavadocDocletOptions).apply {
      encoding = "UTF-8"
      addBooleanOption("Xdoclint:all,-missing", true)
      addBooleanOption("Werror", true)
    }
  }

  extensions.configure<PublishingExtension> {
    publications {
      create<MavenPublication>("maven") {
        from(components["java"])
        pom {
          name = project.name
          description = provider { project.description }
          url = "https://workhorse.run"
          licenses {
            license {
              name = "The Apache License, Version 2.0"
              url = "https://www.apache.org/licenses/LICENSE-2.0.txt"
            }
          }
          developers {
            developer {
              id = "stablemates"
              name = "Stablemates"
              url = "https://github.com/stablemates"
            }
          }
          scm {
            url = "https://github.com/stablemates/workhorse"
            connection = "scm:git:https://github.com/stablemates/workhorse.git"
            developerConnection = "scm:git:ssh://git@github.com/stablemates/workhorse.git"
          }
        }
      }
    }
    repositories { maven { name = "staging"; url = uri(stagingRepository) } }
  }

  if (signingKey.isPresent) {
    extensions.configure<SigningExtension> {
      useInMemoryPgpKeys(signingKey.get(), signingPassword.orNull)
      sign(the<PublishingExtension>().publications)
    }
  }
}

// Clears the staging directory, then writes the three signed artifacts to it.
tasks.register("stageRelease") {
  group = "publishing"
  description = "Writes the three JVM artifacts, signed, to build/staging-deploy."
  val publishTasks = publishedArtifacts.map { ":$it:publishAllPublicationsToStagingRepository" }
  dependsOn(publishTasks)
}

gradle.taskGraph.whenReady {
  // The snapshot lane skips dependency verification for two test class paths. The build that
  // holds the signing key must verify every artifact (SM-1489).
  if (hasTask(":stageRelease") && providers.gradleProperty("workhorse.springBoot").orNull == "snapshot") {
    throw GradleException("stageRelease refuses -Pworkhorse.springBoot=snapshot")
  }
  if (hasTask(":stageRelease") && !signingKey.isPresent) {
    throw GradleException("stageRelease needs MAVEN_SIGNING_KEY, so that every file is signed")
  }
}

tasks.register<Delete>("cleanStaging") { delete(stagingRepository) }

subprojects {
  tasks.matching { it.name == "publishAllPublicationsToStagingRepository" }.configureEach {
    mustRunAfter(":cleanStaging")
  }
}
