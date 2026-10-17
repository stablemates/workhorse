import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

// `workhorse-kotlin`: suspend handlers, suspend client wrappers, and a DSL over the Java core
// (ADR 0103, "Kotlin module").

plugins { alias(libs.plugins.kotlin.jvm) }

description = "Workhorse for Kotlin: suspend handlers, suspend wrappers, and a DSL"

kotlin {
  // A Kotlin 2.2 caller can read this module and resolves no newer standard library.
  coreLibrariesVersion = libs.versions.kotlin.core.libraries.get()
  explicitApi()
  compilerOptions {
    languageVersion = KotlinVersion.KOTLIN_2_2
    apiVersion = KotlinVersion.KOTLIN_2_2
    jvmTarget = JvmTarget.JVM_21
    allWarningsAsErrors = true
  }
}

dependencies { api(project(":workhorse")) }

tasks.jar { manifest { attributes("Automatic-Module-Name" to "dev.stablemates.workhorse.kotlin") } }
