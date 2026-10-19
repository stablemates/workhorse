// The Kotlin tabs of the site page about rate limits.

package run.workhorse.examples

import java.time.Duration
import run.workhorse.Queue
import run.workhorse.RateLimit
import run.workhorse.RateLimitPolicy
import run.workhorse.RateLimitPolicyDefinition
import run.workhorse.kotlin.syncRateLimitPoliciesSuspend

/** The Kotlin snippets of the site page about rate limits. */
object RateLimitsKotlinExamples {
  /** Synchronizes the rate-limit policy of the `provider-api` queue. */
  suspend fun syncPolicies(queue: Queue): List<RateLimitPolicy> {
    // docs:start kotlin-rate-limits-sync
    val policies =
      queue.syncRateLimitPoliciesSuspend(
        "workers",
        listOf(
          RateLimitPolicyDefinition(
            "provider-api",
            RateLimit(60, Duration.ofMinutes(1), 10),
            RateLimit(5, Duration.ofMinutes(1), 2),
          ),
        ),
      )
    // docs:end
    return policies
  }
}
