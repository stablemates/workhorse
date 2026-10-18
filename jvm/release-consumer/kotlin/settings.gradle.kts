// A clean consumer of the JVM artifacts. `scripts/check-jvm-release.ts` and
// `pnpm release:verify maven` set the properties.
pluginManagement {
  val kotlinVersion: String by settings
  repositories { gradlePluginPortal() }
  plugins { id("org.jetbrains.kotlin.jvm") version kotlinVersion }
}

rootProject.name = "workhorse-release-consumer"

// The staging directory of a rehearsal. Without it, the consumer takes the published release from
// Maven Central, as the cold install of ADR 0056 Gate 3 does.
val workhorseRepository = providers.gradleProperty("workhorseRepository").orNull

dependencyResolutionManagement {
  repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
  repositories {
    // A rehearsal takes the Workhorse artifacts only from the staging directory, never from Maven
    // Central or a local Maven repository.
    if (workhorseRepository != null) {
      exclusiveContent {
        forRepository { maven { url = uri(workhorseRepository) } }
        filter { includeGroup("dev.stablemates") }
      }
    }
    mavenCentral()
  }
}
