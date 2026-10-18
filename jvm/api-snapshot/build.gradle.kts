import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// `api-snapshot`: the reader behind `pnpm java-api:generate` and `pnpm kotlin-api:generate`
// (ADR 0103, "Governed surface and release"). It is a build tool. No artifact depends on it, and
// it is never published.

plugins { alias(libs.plugins.kotlin.jvm) }

description = "Writes api/java.txt and api/kotlin.txt from the JVM artifacts"

kotlin {
  compilerOptions {
    jvmTarget = JvmTarget.JVM_21
    allWarningsAsErrors = true
  }
}

// The class path the Java reader loads the two artifacts on. Reflection resolves every type a
// public signature names, so it holds the optional dependencies that the core and the starter
// compile against but do not bring.
val snapshotClasspath: Configuration =
  configurations.create("snapshotClasspath") {
    isCanBeConsumed = false
    isCanBeResolved = true
  }

// Each jar alone, so the reader knows which classes belong to which artifact.
fun jarOf(path: String): Configuration =
  configurations.create("jar" + path.removePrefix(":").replace("-", "")) {
    isCanBeConsumed = false
    isCanBeResolved = true
    isTransitive = false
    dependencies.add(project.dependencies.project(path))
  }

val coreJar = jarOf(":workhorse")
val starterJar = jarOf(":workhorse-spring-boot-starter")

dependencies {
  implementation(libs.kotlin.compiler.embeddable)
  implementation(platform(libs.spring.boot.dependencies))
  implementation(libs.jackson.databind)

  snapshotClasspath(project(":workhorse-spring-boot-starter"))
  snapshotClasspath(platform(libs.spring.boot.dependencies))
  snapshotClasspath(libs.spring.boot.jackson)
  snapshotClasspath(libs.jackson.databind)
  snapshotClasspath(libs.spring.boot.health)
  snapshotClasspath(libs.spring.web)
  snapshotClasspath(libs.jakarta.servlet.api)
  snapshotClasspath(libs.opentelemetry.api)

  testImplementation(libs.jspecify)
}

val readerClasspath = the<SourceSetContainer>()["main"].runtimeClasspath
val kotlinSources = project(":workhorse-kotlin").layout.projectDirectory.dir("src/main/kotlin")

tasks.register<JavaExec>("javaApi") {
  description = "Writes the Java API snapshot to build/api/java.txt."
  group = "verification"
  val output = layout.buildDirectory.file("api/java.txt")
  inputs.files(coreJar, starterJar, snapshotClasspath)
  outputs.file(output)
  classpath = readerClasspath
  mainClass = "dev.stablemates.workhorse.apisnapshot.MainKt"
  argumentProviders.add(
    CommandLineArgumentProvider {
      listOf(
        "java",
        output.get().asFile.path,
        "workhorse=${coreJar.singleFile}",
        "workhorse-spring-boot-starter=${starterJar.singleFile}",
        "--classpath=${snapshotClasspath.asPath}",
      )
    }
  )
}

tasks.register<JavaExec>("kotlinApi") {
  description = "Writes the Kotlin API snapshot to build/api/kotlin.txt."
  group = "verification"
  val output = layout.buildDirectory.file("api/kotlin.txt")
  // A source that does not compile must fail here, not produce a snapshot.
  dependsOn(":workhorse-kotlin:compileKotlin")
  inputs.dir(kotlinSources)
  outputs.file(output)
  classpath = readerClasspath
  mainClass = "dev.stablemates.workhorse.apisnapshot.MainKt"
  argumentProviders.add(
    CommandLineArgumentProvider {
      listOf("kotlin", output.get().asFile.path, kotlinSources.asFile.path)
    }
  )
}

tasks.test { dependsOn(":workhorse-kotlin:compileKotlin") }

tasks.named("lint") { dependsOn("compileKotlin", "compileTestKotlin") }
