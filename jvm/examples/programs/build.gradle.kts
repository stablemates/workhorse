import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// `programs`: the cross-SDK scenario programs (SM-1469). Each file in `src/main` is one runnable
// program, the JVM counterpart of a file in `ruby/examples` or `rust/examples`.
// `docs/examples-coverage.json` maps each scenario to its program. The programs hold no
// `docs:start` region; those stay in `jvm/examples/src/main`. The tests start each program in a
// child JVM against a scratch database. This project is never published: it applies no publishing
// plugin, and `scripts/check-jvm-release.ts` refuses a staged module outside the three artifacts.

plugins { alias(libs.plugins.kotlin.jvm) }

description = "The cross-SDK scenario programs, run against PostgreSQL"

kotlin {
  compilerOptions {
    jvmTarget = JvmTarget.JVM_21
    allWarningsAsErrors = true
    // Kotlin reads the JSpecify annotations of the core as nullness errors, as a caller does.
    freeCompilerArgs.add("-Xjspecify-annotations=strict")
  }
}

// The tests use the scratch database support of the core's test sources and the isolated database
// of the documentation examples.
evaluationDependsOn(":workhorse")

evaluationDependsOn(":examples")

val coreTests = project(":workhorse").the<SourceSetContainer>()["test"].output
val exampleTests = project(":examples").the<SourceSetContainer>()["test"].output

dependencies {
  implementation(project(":workhorse"))
  implementation(project(":workhorse-kotlin"))
  implementation(libs.pgjdbc)

  testImplementation(coreTests)
  testImplementation(exampleTests)
}

// `pnpm jvm:lint` compiles the Kotlin sources too, and every Kotlin warning is an error.
tasks.named("lint") { dependsOn("compileKotlin", "compileTestKotlin") }

// Both demo launchers start the demo worker (SM-1680). Each runs `demoWorkerClassPath` and starts
// the JVM with the jars in build/demo-worker. `scripts/dev.ts` does not run the worker through
// Gradle, because Gradle runs a build in a daemon of its own session, outside the launcher's
// process group. The image copies the jars, so it needs no Gradle.
tasks.register<Sync>("demoWorkerClassPath") {
  description = "Copies the jars of the demo worker into build/demo-worker."
  from(tasks.named("jar"))
  from(configurations.named("runtimeClasspath"))
  into(layout.buildDirectory.dir("demo-worker"))
}
