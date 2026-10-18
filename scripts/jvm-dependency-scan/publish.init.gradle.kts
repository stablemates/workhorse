// `pnpm jvm:vuln` (scripts/audit-jvm-dependencies.ts) runs the JVM build with this init script. It
// adds a scratch Maven repository to each published artifact, so the scan reads the POM and the
// Gradle module metadata that Maven Central receives, without a change to the JVM build.
// `-Pworkhorse.scanRepository=<directory>` names the repository.

import org.gradle.api.publish.PublishingExtension

val scanRepository: String =
  gradle.startParameter.projectProperties["workhorse.scanRepository"]
    ?: throw GradleException("workhorse.scanRepository must name the scratch repository")

allprojects {
  pluginManager.withPlugin("maven-publish") {
    extensions.configure<PublishingExtension> {
      repositories {
        maven {
          name = "dependencyScan"
          url = uri(scanRepository)
        }
      }
    }
  }
}
