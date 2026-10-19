package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.RateLimit;
import run.workhorse.RateLimitPolicy;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about rate limits. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class RateLimitsExamplesTest {
  private final Queue queue = new Queue(ConnectionSource.of(ExampleDatabase.dataSource()));

  @Test
  void theSyncStoresTheQueueBucketAndThePerKeyBucket() {
    List<RateLimitPolicy> policies = new RateLimitsExamples(queue).syncPolicies();
    assertEquals(1, policies.size());
    RateLimitPolicy policy = policies.get(0);
    assertEquals("provider-api", policy.queue());
    assertEquals(new RateLimit(60, Duration.ofMinutes(1), 10), policy.rate());
    assertEquals(new RateLimit(5, Duration.ofMinutes(1), 2), policy.perKey());
    assertTrue(queue.listRateLimitPolicies(List.of("provider-api")).contains(policy));
  }
}
