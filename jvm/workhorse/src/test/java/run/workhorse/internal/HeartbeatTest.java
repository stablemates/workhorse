package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class HeartbeatTest {
  private static long millis(long milliseconds) {
    return TimeUnit.MILLISECONDS.toNanos(milliseconds);
  }

  @Test
  void boundsARoundByThreeQuartersOfTheIntervalAndByTheIntervalUpTo50Ms() {
    assertEquals(millis(10), Heartbeat.roundBoundNanos(millis(10)));
    assertEquals(millis(40), Heartbeat.roundBoundNanos(millis(40)));
    assertEquals(millis(50), Heartbeat.roundBoundNanos(millis(50)));
    assertEquals(millis(50), Heartbeat.roundBoundNanos(millis(66)));
    assertEquals(millis(51), Heartbeat.roundBoundNanos(millis(69)));
    assertEquals(millis(150), Heartbeat.roundBoundNanos(millis(200)));
    assertEquals(millis(7_500), Heartbeat.roundBoundNanos(millis(10_000)));
  }

  @Test
  void keepsTheBoundBelowAnIntervalAbove50Ms() {
    for (long interval = 1; interval <= 1_000; interval++) {
      long bound = Heartbeat.roundBoundNanos(millis(interval));
      if (interval <= 50) {
        assertEquals(millis(interval), bound, "interval " + interval + " ms");
      } else {
        assertTrue(bound < millis(interval), "interval " + interval + " ms");
      }
    }
  }

  @Test
  void retriesAFailedRoundNoLaterThanTheNextSlot() {
    // A 40 ms interval: the round that started at 0 failed at 30 ms, so the next slot is in 10 ms.
    assertEquals(millis(10), Heartbeat.retryWaitNanos(0, millis(40), millis(30)));
    // The next slot is later than the retry wait, so the retry wait applies.
    assertEquals(millis(100), Heartbeat.retryWaitNanos(0, millis(10_000), millis(7_500)));
    // The slot has passed, for example after a checkout that the pool refused.
    assertEquals(millis(100), Heartbeat.retryWaitNanos(0, millis(40), millis(50)));
  }

  @Test
  void leavesAMarginAfterOneTimedOutRoundWithTheDefaults() {
    long lease = millis(30_000);
    long interval = lease / 3;
    assertTrue(2 * interval + Heartbeat.roundBoundNanos(interval) < lease);
  }

  private static Heartbeat.Member member(String workerId) {
    UUID taskId = UUID.randomUUID();
    return new Heartbeat.Member() {
      @Override
      public String workerId() {
        return workerId;
      }

      @Override
      public UUID taskId() {
        return taskId;
      }

      @Override
      public long fenceToken() {
        return 1;
      }

      @Override
      public long leaseMs() {
        return 30_000;
      }

      @Override
      public long intervalNanos() {
        return millis(10_000);
      }

      @Override
      public void renew(long sentAt) {}

      @Override
      public void settle(String status) {}

      @Override
      public void fail(Exception error) {}
    };
  }

  private static List<Heartbeat.Member> members(int count) {
    List<Heartbeat.Member> members = new ArrayList<>();
    for (int index = 0; index < count; index++) {
      members.add(member("worker"));
    }
    return members;
  }

  /** A round whose first batch always passes the deadline. It records the payload of each send. */
  private static Heartbeat.Round slowFirstBatch(String slowTask, List<String> sent) {
    return (timeoutNanos, statement, parameters) -> {
      String payload = (String) parameters[1];
      sent.add(payload);
      if (payload.contains(slowTask)) {
        try {
          TimeUnit.MILLISECONDS.sleep(30);
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
        }
      }
      return List.of();
    };
  }

  @Test
  void aSharedRoundSendsEveryBatchAfterASlowFirstBatch() throws Exception {
    List<Heartbeat.Member> due = members(101);
    List<Heartbeat.Batch> batches = Heartbeat.batches(due);
    assertEquals(2, batches.size());
    String last = due.get(100).taskId().toString();
    Heartbeat shared = new Heartbeat(null, false);
    for (int round = 0; round < 3; round++) {
      List<String> sent = new ArrayList<>();
      long deadline = System.nanoTime() + millis(10);
      shared.sendBatches(
          batches,
          shared.nextFirstBatch(batches.size()),
          deadline,
          slowFirstBatch(due.get(0).taskId().toString(), sent));
      // A shared round has no deadline, so the batch after the slow one is always sent.
      assertEquals(2, sent.size(), "round " + round);
      assertTrue(sent.get(1).contains(last), "round " + round);
    }
  }

  @Test
  void aDedicatedRoundStartsWithTheNextBatchSoNoBatchStarves() throws Exception {
    List<Heartbeat.Member> due = members(101);
    List<Heartbeat.Batch> batches = Heartbeat.batches(due);
    String last = due.get(100).taskId().toString();
    Heartbeat dedicated = new Heartbeat(null, true);
    int renewedLast = 0;
    for (int round = 0; round < 4; round++) {
      List<String> sent = new ArrayList<>();
      long deadline = System.nanoTime() + millis(10);
      dedicated.sendBatches(
          batches,
          dedicated.nextFirstBatch(batches.size()),
          deadline,
          slowFirstBatch(due.get(0).taskId().toString(), sent));
      if (sent.stream().anyMatch(payload -> payload.contains(last))) {
        renewedLast++;
      }
    }
    // The slow batch uses the whole deadline when it goes first, so the last lease is sent in the
    // rounds that start with its batch: every second round.
    assertEquals(2, renewedLast);
  }
}
