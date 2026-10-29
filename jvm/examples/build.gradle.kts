import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// `examples`: the Java and Kotlin snippets of the documentation (SM-1453). Each
// `// docs:start <name>` region is one snippet. `site/scripts/check-language-examples.ts` requires
// every ```java and ```kotlin fence in the guides, the site pages, and the READMEs to equal a
// dedented region, and every region to appear in one fence. The tests run the regions against
// PostgreSQL. This project is never published: it applies no publishing plugin, and
// `scripts/check-jvm-release.ts` refuses a staged module outside the three artifacts.

plugins { alias(libs.plugins.kotlin.jvm) }

description = "The Java and Kotlin snippets of the documentation, compiled and run"

kotlin {
  compilerOptions {
    jvmTarget = JvmTarget.JVM_21
    allWarningsAsErrors = true
    // Kotlin reads the JSpecify annotations of the core as nullness errors, as a caller does.
    freeCompilerArgs.add("-Xjspecify-annotations=strict")
  }
}

// The README snippets quote `jvm/release-consumer`, which no formatter checks, and
// `scripts/readme-alignment.test.ts` holds them to it. Their files keep that layout.
//
// The landing page shows each pillar snippet in a pane of about 72 columns, and the formatters join
// every line that fits in 100. The pillar regions of `Landing.java` and `Landing.kt` sit between
// `spotless:off` and `spotless:on`, so they keep the style of each formatter at 72 columns.
spotless {
  java {
    targetExclude("src/main/java/run/workhorse/examples/ReadmeExample.java")
    toggleOffOn()
  }
  kotlin {
    targetExclude("src/main/kotlin/run/workhorse/examples/ReadmeExample.kt")
    toggleOffOn()
  }
}

// The tests use the scratch database support of the core's test sources.
evaluationDependsOn(":workhorse")

val coreTests = project(":workhorse").the<SourceSetContainer>()["test"].output

dependencies {
  implementation(project(":workhorse"))
  implementation(project(":workhorse-kotlin"))
  implementation(project(":workhorse-spring-boot-starter"))
  implementation(platform(libs.spring.boot.dependencies))
  implementation(libs.spring.boot.starter.jdbc)
  implementation(libs.jakarta.servlet.api)
  // The README snippet builds its own `PGSimpleDataSource`.
  implementation(libs.pgjdbc)

  testImplementation(coreTests)
  testImplementation(libs.spring.boot.starter.test)
  testImplementation(libs.tomcat.embed.core)
}

// `pnpm jvm:lint` compiles the Kotlin sources too, and every Kotlin warning is an error.
tasks.named("lint") { dependsOn("compileKotlin", "compileTestKotlin") }
