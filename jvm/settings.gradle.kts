rootProject.name = "workhorse-jvm"

dependencyResolutionManagement {
  repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
  repositories { mavenCentral() }
}

pluginManagement {
  repositories { gradlePluginPortal() }
}

include("workhorse", "workhorse-kotlin", "workhorse-spring-boot-starter")
