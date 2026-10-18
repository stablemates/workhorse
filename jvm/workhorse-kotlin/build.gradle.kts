import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

// `workhorse-kotlin`: suspend handlers, suspend client wrappers, and a DSL over the Java core
// (ADR 0103, "Kotlin module").

plugins { alias(libs.plugins.kotlin.jvm) }

description = "Workhorse for Kotlin: suspend handlers, suspend wrappers, and a DSL"

// The Kotlin floor of ADR 0103: language and API version 2.2.
val kotlinFloor = KotlinVersion.KOTLIN_2_2

kotlin {
  // A Kotlin 2.2 caller can read this module and resolves no newer standard library.
  coreLibrariesVersion = libs.versions.kotlin.core.libraries.get()
  explicitApi()
  compilerOptions {
    languageVersion = kotlinFloor
    apiVersion = kotlinFloor
    jvmTarget = JvmTarget.JVM_21
    allWarningsAsErrors = true
    // Kotlin reads the JSpecify annotations of the core as nullness errors.
    freeCompilerArgs.add("-Xjspecify-annotations=strict")
  }
}

// The tests use the scratch database support of the core's test sources.
evaluationDependsOn(":workhorse")

val coreTests = project(":workhorse").the<SourceSetContainer>()["test"].output

dependencies {
  api(project(":workhorse"))
  api(libs.kotlinx.coroutines.core)

  testImplementation(coreTests)
}

tasks.jar { manifest { attributes("Automatic-Module-Name" to "run.workhorse.kotlin") } }

// A Kotlin 2.2 caller must resolve no newer standard library through this module (ADR 0103,
// "Floors"). The check fails if the runtime class path, which holds the module's own dependencies,
// resolves a Kotlin core library outside the 2.2 line.
val verifyKotlinFloor =
  tasks.register("verifyKotlinFloor") {
    val floor = kotlinFloor.version
    val resolved =
      configurations.runtimeClasspath.map { classpath ->
        classpath.incoming.resolutionResult.allComponents
          .mapNotNull { it.moduleVersion }
          .filter { it.group == "org.jetbrains.kotlin" }
          .map { "${it.name}:${it.version}" }
      }
    inputs.property("resolved", resolved)
    doLast {
      val outside = resolved.get().filterNot { it.substringAfter(':').startsWith("$floor.") }
      if (resolved.get().none { it.startsWith("kotlin-stdlib:") }) {
        throw GradleException("The runtime class path resolves no kotlin-stdlib")
      }
      if (outside.isNotEmpty()) {
        throw GradleException("Kotlin core libraries outside the $floor line: $outside")
      }
    }
  }

// `pnpm jvm:lint` compiles the Kotlin sources too, and every Kotlin warning is an error.
tasks.named("lint") { dependsOn("compileKotlin", "compileTestKotlin", verifyKotlinFloor) }
