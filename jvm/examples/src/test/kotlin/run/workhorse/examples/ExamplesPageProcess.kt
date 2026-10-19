package run.workhorse.examples

import kotlinx.coroutines.runBlocking
import org.postgresql.ds.PGSimpleDataSource
import run.workhorse.Admin
import run.workhorse.ConnectionSource
import run.workhorse.Queue

/**
 * The child JVM of [ExamplesPageProcessTest]. The billing snippets run their worker as the whole
 * process, so they cannot run inside the test JVM.
 *
 * Arguments: the snippet (`java-examples-page-billing-worker` or
 * `kotlin-examples-page-billing-worker`), and a JDBC URL with credentials.
 */
object ExamplesPageProcess {
  @JvmStatic
  fun main(arguments: Array<String>) {
    val dataSource = PGSimpleDataSource()
    dataSource.setURL(arguments[1])
    val queue = Queue(ConnectionSource.of(dataSource))
    when (arguments[0]) {
      "java-examples-page-billing-worker" ->
        ExamplesPageExamples(dataSource, queue, Admin(ConnectionSource.of(dataSource)))
          .runBillingWorker()
      "kotlin-examples-page-billing-worker" ->
        runBlocking { ExamplesPageKotlin.runBillingWorker(dataSource, queue) }
      else -> throw IllegalArgumentException("unknown snippet ${arguments[0]}")
    }
  }
}
