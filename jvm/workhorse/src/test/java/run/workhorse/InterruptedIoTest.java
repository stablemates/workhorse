package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.io.UncheckedIOException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.nio.channels.ClosedByInterruptException;
import java.sql.SQLException;
import org.junit.jupiter.api.Test;

/**
 * SM-1889: which handler errors show an I/O failure that the drain's interrupt caused. After that
 * interrupt, only such an error releases the task. Another error of the handler's own still charges
 * the attempt.
 */
class InterruptedIoTest {
  @Test
  void findsAnIoFailureThatAnInterruptCausedInTheCauseChain() {
    assertTrue(
        Worker.interruptedIo(
            new SQLException(
                "An I/O error occurred while sending to the backend.",
                new SocketException("Closed by interrupt"))));
    assertTrue(Worker.interruptedIo(new UncheckedIOException(new ClosedByInterruptException())));
    assertTrue(Worker.interruptedIo(new RuntimeException(new InterruptedIOException("read"))));
  }

  @Test
  void doesNotCountAnotherIoError() {
    assertFalse(
        Worker.interruptedIo(new SQLException("down", new IOException("connection reset"))));
    assertFalse(Worker.interruptedIo(new SocketException("Connection reset")));
    assertFalse(Worker.interruptedIo(new SocketTimeoutException("Read timed out")));
    assertFalse(Worker.interruptedIo(new IllegalStateException("own failure")));
  }
}
