package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import org.junit.jupiter.api.Test;
import run.workhorse.CompatibilityException.Code;
import run.workhorse.DatabaseException;

class CompatibilityTest {
  private static final int CLIENT = SqlCatalogue.CLIENT_PROTOCOL_VERSION;
  private static final int SCHEMA = SqlCatalogue.MINIMUM_SCHEMA_VERSION;

  @Test
  void acceptsAServedProtocol() {
    assertNull(Compatibility.check(SCHEMA, CLIENT, List.of(CLIENT)));
    assertNull(Compatibility.check(SCHEMA, CLIENT, List.of()));
  }

  @Test
  void refusesEachIncompatibleState() {
    assertEquals(Code.SCHEMA_NOT_INSTALLED, Compatibility.check(null, CLIENT, List.of()));
    assertEquals(Code.SCHEMA_TOO_OLD, Compatibility.check(SCHEMA - 1, CLIENT, List.of()));
    assertEquals(
        Code.CLIENT_PROTOCOL_TOO_OLD,
        Compatibility.check(SCHEMA, SqlCatalogue.MINIMUM_PROTOCOL_VERSION - 1, List.of()));
    assertEquals(
        Code.CLIENT_PROTOCOL_TOO_NEW,
        Compatibility.check(SCHEMA, SqlCatalogue.MAXIMUM_PROTOCOL_VERSION + 1, List.of()));
    assertEquals(Code.SCHEMA_TOO_NEW, Compatibility.check(SCHEMA, CLIENT, List.of(CLIENT + 1)));
    assertEquals(Code.SCHEMA_TOO_OLD, Compatibility.check(SCHEMA, CLIENT, List.of(CLIENT - 1)));
  }

  @Test
  void keepsADriverErrorWithoutSqlState() {
    Connection broken =
        (Connection)
            Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                (proxy, method, arguments) -> {
                  throw new SQLException("driver error");
                });
    DatabaseException error =
        assertThrows(DatabaseException.class, () -> Compatibility.evaluate(broken));
    assertNull(error.sqlState());
    assertEquals("driver error", error.getCause().getMessage());
  }
}
