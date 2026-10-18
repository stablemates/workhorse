package run.workhorse.kotlin

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test

/**
 * The `testWithoutSpring` task runs this class on a class path with no Spring jar. A wrapper then
 * finds no Spring transaction scope, and every call runs on a virtual thread.
 */
@Tag("without-spring")
class WithoutSpringTest {
  @Test
  fun findsNoScopeWhenNoLoaderHasSpring() {
    assertThrows(ClassNotFoundException::class.java) {
      Class.forName(
        SpringTransactionScope.MANAGER,
        false,
        WithoutSpringTest::class.java.classLoader,
      )
    }
    assertNull(
      SpringTransactionScope.find(
        listOf(
          Thread.currentThread().contextClassLoader,
          WithoutSpringTest::class.java.classLoader,
        ),
      ),
    )
    assertFalse(SpringTransactionScope.active())
  }
}
