package run.workhorse.examples

import java.time.Duration
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.Queue
import run.workhorse.RateLimit
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippets of the site page about rate limits. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class RateLimitsKotlinExamplesTest {
  private val queue = Queue(ConnectionSource.of(ExampleDatabase.dataSource()))

  @Test
  fun theSyncStoresTheQueueBucketAndThePerKeyBucket() = runBlocking {
    val policies = RateLimitsKotlinExamples.syncPolicies(queue)
    assertEquals(1, policies.size)
    val policy = policies[0]
    assertEquals("provider-api", policy.queue)
    assertEquals(RateLimit(60, Duration.ofMinutes(1), 10), policy.rate)
    assertEquals(RateLimit(5, Duration.ofMinutes(1), 2), policy.perKey)
    assertTrue(queue.listRateLimitPolicies(listOf("provider-api")).contains(policy))
  }
}
