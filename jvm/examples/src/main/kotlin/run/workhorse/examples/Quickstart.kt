// The Kotlin tab of step 3 of the site quickstart. The region is a whole program: a reader
// pastes it into Quickstart.kt, and QuickstartKotlinExamplesTest runs its main in a child JVM.

package run.workhorse.examples

// docs:start kotlin-quickstart-run-task
import kotlinx.coroutines.runBlocking
import org.postgresql.ds.PGSimpleDataSource
import run.workhorse.Admin
import run.workhorse.ConnectionSource
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.getTaskSuspend
import run.workhorse.kotlin.workhorseWorker

fun main() = runBlocking {
  // A JDBC URL, such as jdbc:postgresql://localhost/app?user=app&password=secret
  val databaseUrl = checkNotNull(System.getenv("JDBC_DATABASE_URL")) { "set JDBC_DATABASE_URL" }
  val dataSource = PGSimpleDataSource().apply { setURL(databaseUrl) }
  val queue = Queue(ConnectionSource.of(dataSource))
  val taskId = queue.enqueueSuspend("email.welcome", mapOf("to" to "ada@example.com")).taskId()

  workhorseWorker(dataSource) {
      handle<Map<String, Any?>>("email.welcome") { _, payload ->
        mapOf("deliveredTo" to payload["to"])
      }
    }
    .use { worker -> worker.runOnce() } // production uses WorkerProcess.runWorkerProcess

  val task = Admin(ConnectionSource.of(dataSource)).getTaskSuspend(taskId)
  println("${task?.state()} ${task?.result()}")
}
// docs:end
