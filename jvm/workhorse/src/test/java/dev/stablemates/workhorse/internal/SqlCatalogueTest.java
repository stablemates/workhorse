package dev.stablemates.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

class SqlCatalogueTest {
  private static final Pattern PROTOCOL_PLACEHOLDER = Pattern.compile("\\$\\d");

  @Test
  void bindsEveryProtocolParameterOfEachStatement() {
    assertFalse(SqlCatalogue.STATEMENTS.isEmpty());
    Set<String> names = new HashSet<>();
    for (SqlCatalogue.Statement statement : SqlCatalogue.STATEMENTS) {
      assertTrue(names.add(statement.name()), statement.name());
      assertFalse(PROTOCOL_PLACEHOLDER.matcher(statement.sql()).find(), statement.name());
      Set<Integer> bound = new HashSet<>();
      for (int placeholder = 1; placeholder <= statement.placeholderCount(); placeholder++) {
        bound.add(statement.protocolParameter(placeholder));
      }
      Set<Integer> expected = new HashSet<>();
      for (int parameter = 1; parameter <= statement.arity(); parameter++) {
        expected.add(parameter);
      }
      assertEquals(expected, bound, statement.name());
    }
  }

  @Test
  void bindsARepeatedParameterAtEachUse() {
    SqlCatalogue.Statement statement = SqlCatalogue.TASK_DEPENDENCY;
    assertEquals(2, statement.arity());
    assertEquals(3, statement.placeholderCount());
    assertEquals(1, statement.protocolParameter(1));
    assertEquals(1, statement.protocolParameter(2));
    assertEquals(2, statement.protocolParameter(3));
  }
}
