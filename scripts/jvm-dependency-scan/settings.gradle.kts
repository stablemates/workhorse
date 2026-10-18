// The consumer build of `pnpm jvm:vuln` (scripts/audit-jvm-dependencies.ts). The scan copies this
// directory to a scratch directory and runs it there. It takes the JVM artifacts only from the
// scratch repository that `publish.init.gradle.kts` fills, and every other module from Maven
// Central, as a caller does.

rootProject.name = "workhorse-dependency-scan"

dependencyResolutionManagement {
  repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
  repositories {
    exclusiveContent {
      forRepository {
        maven {
          name = "dependencyScan"
          url = uri(providers.gradleProperty("workhorse.scanRepository").get())
        }
      }
      filter { includeGroup("run.workhorse") }
    }
    mavenCentral()
  }
}
