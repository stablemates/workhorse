package run.workhorse.examples;

import java.time.Duration;
import java.util.List;
import run.workhorse.Queue;
import run.workhorse.RateLimit;
import run.workhorse.RateLimitPolicy;
import run.workhorse.RateLimitPolicyDefinition;

/** The Java tabs of the site page about rate limits. */
public final class RateLimitsExamples {
  private final Queue queue;

  /** The snippets run on this queue. */
  public RateLimitsExamples(Queue queue) {
    this.queue = queue;
  }

  List<RateLimitPolicy> syncPolicies() {
    // docs:start java-rate-limits-sync
    List<RateLimitPolicy> policies =
        queue.syncRateLimitPolicies(
            "workers",
            List.of(
                new RateLimitPolicyDefinition(
                    "provider-api",
                    new RateLimit(60, Duration.ofMinutes(1), 10),
                    new RateLimit(5, Duration.ofMinutes(1), 2))));
    // docs:end
    return policies;
  }
}
