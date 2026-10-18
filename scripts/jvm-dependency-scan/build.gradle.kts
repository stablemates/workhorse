// Resolves each published JVM artifact as a caller resolves it from Maven Central: the runtime
// class path for Java 21, with no feature and with each feature set that the plan names. The plan
// is a JSON file that scripts/audit-jvm-dependencies.ts writes:
//
//   [{ "artifact": "workhorse", "version": "0.8.0", "features": ["servlet"] }, ...]
//
// The task writes one JSON object for each plan entry to `workhorse.scanReport`. The object lists
// every resolved module outside `run.workhorse`, and every dependency that did not resolve.

import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import org.gradle.api.artifacts.result.UnresolvedDependencyResult

plugins { `java-library` }

val plan = file(providers.gradleProperty("workhorse.scanPlan").get())
val report = file(providers.gradleProperty("workhorse.scanReport").get())

tasks.register("resolveRuntimeClassPaths") {
  doLast {
    @Suppress("UNCHECKED_CAST")
    val entries = JsonSlurper().parse(plan) as List<Map<String, Any>>
    val results =
      entries.map { entry ->
        val artifact = entry["artifact"] as String
        val version = entry["version"] as String
        @Suppress("UNCHECKED_CAST") val features = entry["features"] as List<String>
        val coordinates = "run.workhorse:$artifact:$version"
        val requested =
          listOf(dependencies.create(coordinates)) +
            features.map { feature ->
              (dependencies.create(coordinates) as ModuleDependency).capabilities {
                requireFeature(feature)
              }
            }
        val classPath = configurations.detachedConfiguration(*requested.toTypedArray())
        classPath.attributes {
          attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage.JAVA_RUNTIME))
          attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category.LIBRARY))
          attribute(LibraryElements.LIBRARY_ELEMENTS_ATTRIBUTE, objects.named(LibraryElements.JAR))
          attribute(Bundling.BUNDLING_ATTRIBUTE, objects.named(Bundling.EXTERNAL))
          attribute(TargetJvmVersion.TARGET_JVM_VERSION_ATTRIBUTE, 21)
        }
        val graph = classPath.incoming.resolutionResult
        mapOf(
          "artifact" to artifact,
          "features" to features,
          "modules" to
            graph.allComponents
              .filter { it != graph.root }
              .mapNotNull { it.moduleVersion }
              .filter { it.group != "run.workhorse" }
              .map { mapOf("group" to it.group, "name" to it.name, "version" to it.version) },
          "unresolved" to
            graph.allDependencies.filterIsInstance<UnresolvedDependencyResult>().map {
              "${it.attempted.displayName}: ${it.failure.message}"
            },
        )
      }
    report.writeText(JsonOutput.toJson(results))
  }
}
