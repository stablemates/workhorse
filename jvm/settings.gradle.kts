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
