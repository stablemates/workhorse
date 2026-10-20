package run.workhorse.kotlin

import java.lang.reflect.ParameterizedType
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** The type that `WorkerScope.handle` and `handleBatch` register for each reified payload type. */
class PayloadTypeTest {
  @Test
  fun keepsTheTypeArgumentsOfEachPayloadType() {
    assertEquals(Long::class.javaObjectType, javaTypeOf<Long>())
    assertEquals(Any::class.java, javaTypeOf<Any?>())
    assertEquals(LongArray::class.java, javaTypeOf<LongArray>())
    val list = javaTypeOf<List<String>>() as ParameterizedType
    assertEquals(List::class.java, list.rawType)
    assertEquals(listOf(String::class.java), list.actualTypeArguments.toList())
  }
}
