// The Kotlin tab of step 5 of the site quickstart. Quickstart.kt holds the tab of step 3.

package run.workhorse.examples

import javax.sql.DataSource
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueSuspend

/** The Kotlin snippet of step 5 of the site quickstart. */
object QuickstartKotlinExamples {
  // docs:start kotlin-quickstart-enqueue-with-data
  suspend fun createOrder(dataSource: DataSource, queue: Queue, orderId: String) {
    dataSource.connection.use { connection ->
      connection.autoCommit = false
      try {
        connection.prepareStatement("INSERT INTO orders (id) VALUES (?)").use { insert ->
          insert.setString(1, orderId)
          insert.executeUpdate()
        }
        queue.enqueueSuspend("order.fulfill", mapOf("orderId" to orderId), connection = connection)
        connection.commit()
      } catch (error: Throwable) {
        connection.rollback()
        throw error
      }
    }
  }
  // docs:end
}
