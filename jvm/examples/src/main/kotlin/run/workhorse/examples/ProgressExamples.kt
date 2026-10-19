// The Kotlin tab of the site page about progress.

package run.workhorse.examples

import run.workhorse.kotlin.SuspendHandlerContext

/** The Kotlin snippet of the site page about progress. The handler imports with `importer`. */
class ProgressKotlinExamples(private val importer: ProgressImporter) {
  /** The handler of the import task. It returns the number of imported rows. */
  suspend fun importRows(context: SuspendHandlerContext, payload: Map<String, Any?>): Any? {
    var processed = 0
    // docs:start kotlin-progress-report
    context.setProgress(mapOf("phase" to "reading", "processed" to 0))
    for (batch in readBatches(payload["source"])) {
      importBatch(batch)
      processed += batch.size
      context.setProgress(mapOf("phase" to "importing", "processed" to processed))
    }
    // docs:end
    return mapOf("processed" to processed)
  }

  private fun readBatches(source: Any?): List<List<String>> = importer.readBatches(source)

  private fun importBatch(batch: List<String>) = importer.importBatch(batch)
}
