// The schema check before a runtime starts, from Kotlin: the site page about installation.

package run.workhorse.examples

import javax.sql.DataSource
import run.workhorse.ConnectionSource
import run.workhorse.Queue
import run.workhorse.kotlin.assertCompatibleSuspend

/** Throws `CompatibilityException` if the installed schema does not match. */
suspend fun checkSchema(dataSource: DataSource): Queue {
  // docs:start kotlin-assert-compatible
  val queue = Queue(ConnectionSource.of(dataSource))
  queue.assertCompatibleSuspend()
  // docs:end
  return queue
}
