package run.workhorse.examples

import kotlinx.coroutines.runBlocking
import org.postgresql.ds.PGSimpleDataSource

/**
 * The child JVM of [LandingProcessExamplesTest]. A landing snippet that runs a worker until the
 * process ends cannot run inside the test JVM, so this process runs it.
 *
 * Arguments: the region name of the snippet, and a JDBC URL with credentials. The deploy snippets
 * read the URL from `JDBC_DATABASE_URL` instead.
 */
object LandingProcess {
  @JvmStatic
  fun main(arguments: Array<String>) {
    val dataSource = PGSimpleDataSource().apply { setURL(arguments[1]) }
    when (arguments[0]) {
      "landing-hero-java" -> Landing.HeroExample.run(dataSource)
      "landing-hero-kotlin" -> runBlocking { LandingKotlin.HeroExample.run(dataSource) }
      "landing-schedules-java" -> Landing.SchedulesExample.run(dataSource)
      "landing-schedules-kotlin" -> runBlocking { LandingKotlin.SchedulesExample.run(dataSource) }
      "landing-deploy-java" -> Landing.DeployExample.run()
      "landing-deploy-kotlin" -> LandingKotlin.DeployExample.run()
      else -> throw IllegalArgumentException("unknown snippet ${arguments[0]}")
    }
  }
}
