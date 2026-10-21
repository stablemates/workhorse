rootProject.name = "workhorse-jvm"

dependencyResolutionManagement {
  repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
  repositories {
    mavenCentral()
    // The non-blocking CI job tests the starter on the next Spring Boot snapshot (ADR 0103,
    // "Floors"). Only that run adds the repository, and only for snapshots of the Spring
    // projects.
    if (providers.gradleProperty("workhorse.springBoot").orNull == "snapshot") {
      maven("https://repo.spring.io/snapshot") {
        mavenContent { snapshotsOnly() }
        // Each group is here because the Spring Boot snapshot BOM imports it from this
        // repository: org.springframework for Spring Boot, Spring Framework, and the other Spring
        // projects; io.micrometer for the Micrometer and Micrometer Tracing BOMs; and
        // io.projectreactor for the Reactor BOM. If a later snapshot needs another group, the
        // snapshot job fails, and a person adds the group after a check.
        content {
          includeGroupByRegex("org\\.springframework(\\..*)?")
          includeGroupByRegex("io\\.micrometer(\\..*)?")
          includeGroupByRegex("io\\.projectreactor(\\..*)?")
        }
      }
    }
  }
}

pluginManagement {
  repositories { gradlePluginPortal() }
}

include("workhorse", "workhorse-kotlin", "workhorse-spring-boot-starter")

// The reader behind `api/java.txt` and `api/kotlin.txt`. It is a build tool, not an artifact.
include("api-snapshot")

// The Java and Kotlin snippets of the documentation, compiled and run. It is never published.
include("examples")

// The cross-SDK scenario programs (SM-1469), one `main` for each scenario. It is never published.
include("examples:programs")

// The JVM probe of the connection budget benchmark (SM-1566). It is never published.
include("connection-budget-probe")
