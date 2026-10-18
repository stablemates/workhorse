// Enqueue in a JDBC transaction from Kotlin: guide 200 and the site page about enqueue.

package run.workhorse.examples

import java.sql.Connection
import javax.sql.DataSource
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueSuspend

// docs:start kotlin-jdbc-transaction
suspend fun createAccount(dataSource: DataSource, queue: Queue, id: String, email: String) {
  dataSource.connection.use { connection ->
    connection.autoCommit = false
    try {
      connection.prepareStatement("INSERT INTO account (id, email) VALUES (?, ?)").use { insert ->
        insert.setString(1, id)
        insert.setString(2, email)
        insert.executeUpdate()
      }
      queue.enqueueSuspend("account.created", mapOf("accountId" to id), connection = connection)
      connection.commit()
    } catch (error: Throwable) {
      connection.rollback()
      throw error
    }
  }
}

// docs:end

/** The short form in the tab group of the site page. The caller owns the connection. */
suspend fun enqueueInTransaction(connection: Connection, queue: Queue, id: String, email: String) {
  // docs:start kotlin-enqueue-in-transaction
  connection.autoCommit = false
  connection.prepareStatement("INSERT INTO account (id, email) VALUES (?, ?)").use { insert ->
    insert.setString(1, id)
    insert.setString(2, email)
    insert.executeUpdate()
  }
  queue.enqueueSuspend("account.created", mapOf("accountId" to id), connection = connection)
  connection.commit()
  // docs:end
}
