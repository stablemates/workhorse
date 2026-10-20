// `pnpm jvm:verification-metadata` (scripts/jvm-verification-metadata.ts) runs the JVM build with
// this init script. It adds the task `resolveAllConfigurations` to each project. The task resolves
// every configuration that Gradle can resolve, so that Gradle writes a checksum for each artifact
// that a task of the build can download, also for a task that the regeneration does not run.

allprojects {
  val resolvable = configurations.matching { it.isCanBeResolved }
  tasks.register("resolveAllConfigurations") {
    description = "Resolves every resolvable configuration of this project."
    doLast { resolvable.forEach { it.incoming.artifacts.artifactFiles.files } }
  }
}
